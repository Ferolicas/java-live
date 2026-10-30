'use strict';

const MAX_CODE_BYTES = 50_000;
const MAX_STDIN_BYTES = 10_000;

// Sustituye comentarios, textos y caracteres por espacios, conservando posiciones y saltos de línea.
function stripNoise(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      out += blank(src.slice(i, j));
      i = j;
    } else if (c === '/' && d === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      out += blank(src.slice(i, j));
      i = j;
    } else if (c === '"' && src.startsWith('"""', i)) {
      let j = src.indexOf('"""', i + 3);
      j = j < 0 ? n : j + 3;
      out += blank(src.slice(i, j));
      i = j;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      j = Math.min(j + 1, n);
      out += blank(src.slice(i, j));
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';

// Devuelve cómo guardar, compilar y lanzar el programa.
function analyze(code) {
  const text = stripNoise(code);

  const pub = text.match(new RegExp(`\\bpublic\\s+(?:(?:final|abstract|sealed|non-sealed|strictfp|static)\\s+)*(?:class|interface|enum|record)\\s+(${IDENT})`));
  const publicType = pub ? pub[1] : null;

  const pk = text.match(new RegExp(`^\\s*package\\s+(${IDENT}(?:\\.${IDENT})*)\\s*;`, 'm'));
  const packageName = pk ? pk[1] : null;

  let mainClass = publicType || 'Main';
  const mainAt = text.search(/\bstatic\s+void\s+main\s*\(/);
  if (mainAt >= 0) {
    // última declaración de tipo de nivel superior anterior a main
    let depth = 0;
    let top = null;
    const re = new RegExp(`[{}]|\\b(?:class|interface|enum|record)\\s+(${IDENT})`, 'g');
    let m;
    while ((m = re.exec(text)) && m.index < mainAt) {
      if (m[0] === '{') depth++;
      else if (m[0] === '}') depth--;
      else if (depth === 0) top = m[1];
    }
    if (top) mainClass = top;
  }

  return {
    fileName: `${publicType || 'Main'}.java`,
    mainClass: packageName ? `${packageName}.${mainClass}` : mainClass,
    publicType,
    packageName,
  };
}

function validate(body) {
  if (!body || typeof body !== 'object') return 'Petición no válida';
  if (typeof body.code !== 'string' || body.code.trim() === '') return 'No hay código que ejecutar';
  if (Buffer.byteLength(body.code) > MAX_CODE_BYTES) return `El código supera ${MAX_CODE_BYTES / 1000} KB`;
  if (body.stdin != null && typeof body.stdin !== 'string') return 'Entrada no válida';
  if (Buffer.byteLength(body.stdin || '') > MAX_STDIN_BYTES) return `La entrada supera ${MAX_STDIN_BYTES / 1000} KB`;
  return null;
}

module.exports = { analyze, validate, stripNoise, MAX_CODE_BYTES, MAX_STDIN_BYTES };

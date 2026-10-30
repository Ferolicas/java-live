(() => {
  'use strict';

  const DEBOUNCE_MS = 700;
  const DEFAULT_CODE = `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        System.out.println("¿Cómo te llamas?");
        String nombre = sc.nextLine();
        System.out.println("Hola, " + nombre + "!");
    }
}
`;
  const DEFAULT_STDIN = 'Mundo\n';

  const $ = (id) => document.getElementById(id);
  const out = $('out');
  const statusEl = $('status');
  const stdinEl = $('stdin');
  const autoEl = $('auto');
  const fileEl = $('filename');
  const timingEl = $('timing');

  const store = {
    get(k, d) { try { const v = localStorage.getItem('javalive.' + k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('javalive.' + k, v); } catch { /* sin almacenamiento */ } },
  };

  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  const themeName = () => (dark.matches ? 'material-darker' : 'neo');

  const cm = CodeMirror($('editor'), {
    value: store.get('code', DEFAULT_CODE),
    mode: 'text/x-java',
    theme: themeName(),
    lineNumbers: true,
    indentUnit: 4,
    tabSize: 4,
    indentWithTabs: false,
    matchBrackets: true,
    autoCloseBrackets: true,
    styleActiveLine: true,
    lineWrapping: false,
    extraKeys: {
      Tab: (c) => (c.somethingSelected() ? c.indentSelection('add') : c.replaceSelection('    ', 'end')),
      'Shift-Tab': 'indentLess',
      'Ctrl-Enter': () => run(),
      'Cmd-Enter': () => run(),
      'Ctrl-S': () => download(),
      'Cmd-S': () => download(),
    },
  });
  dark.addEventListener('change', () => cm.setOption('theme', themeName()));
  stdinEl.value = store.get('stdin', DEFAULT_STDIN);
  autoEl.checked = store.get('auto', '1') === '1';

  // ---- nombre del archivo: igual que en el servidor (clase pública, o Main) ----
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ').replace(/"(?:\\.|[^"\\\n])*"/g, '""');
  }
  function detectName(src) {
    const m = stripComments(src).match(/\bpublic\s+(?:(?:final|abstract|sealed|non-sealed|strictfp|static)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    return (m ? m[1] : 'Main') + '.java';
  }

  // ---- estado y salida ----
  function setStatus(state, text) { statusEl.dataset.state = state; statusEl.textContent = text; }
  function add(parent, cls, text) { const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = text; parent.appendChild(s); return s; }
  function resetOut() { out.textContent = ''; return out; }
  function message(text, cls = 'muted') { resetOut(); add(out, cls, text); }
  function seconds(ms) { return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s'; }

  let marked = [];
  function clearMarks() { marked.forEach((l) => cm.removeLineClass(l, 'background', 'err-line')); marked = []; }

  const ERR_RE = /^(?:.*[\\/])?[A-Za-z_][A-Za-z0-9_]*\.java:(\d+): (error|warning): /;

  function renderCompileError(c) {
    resetOut();
    if (c.timedOut) { add(out, 'w', 'La compilación tardó demasiado y se cortó.\n'); return; }
    c.output.split('\n').forEach((line, i, all) => {
      const m = line.match(ERR_RE);
      const nl = i < all.length - 1 ? '\n' : '';
      if (m) {
        const n = Number(m[1]);
        if (n >= 1 && n <= cm.lineCount()) { cm.addLineClass(n - 1, 'background', 'err-line'); marked.push(n - 1); }
        const a = document.createElement('a');
        a.className = 'jump'; a.textContent = line; a.title = 'Ir a la línea ' + n;
        a.addEventListener('click', () => { cm.focus(); cm.setCursor({ line: n - 1, ch: 0 }); });
        out.appendChild(a); out.appendChild(document.createTextNode(nl));
      } else {
        add(out, 'e', line + nl);
      }
    });
  }

  function renderRun(r, code) {
    resetOut();
    if (r.stdout) add(out, '', r.stdout);
    if (r.stderr) add(out, 'e', (r.stdout && !r.stdout.endsWith('\n') ? '\n' : '') + r.stderr);
    if (!r.stdout && !r.stderr && !r.timedOut) add(out, 'muted', '(el programa no escribió nada)');
    if (r.timedOut) add(out, 'note', '⏱ Tiempo agotado (5 s). Revisa si hay un bucle infinito o una espera que nunca termina.');
    if (r.truncated) add(out, 'note', 'La salida es muy larga y se cortó.');
    if (/NoSuchElementException/.test(r.stderr) && /Scanner/.test(code)) {
      add(out, 'note', 'El programa pidió más datos de los que hay en «Entrada». Escribe en ese cuadro una línea por cada lectura (nextLine, nextInt…).');
    }
    if (/OutOfMemoryError/.test(r.stderr)) add(out, 'note', 'El programa superó la memoria disponible (128 MB).');
    add(out, 'meta', r.timedOut ? `Cortado por tiempo · ${seconds(r.ms)}` : `Terminó con código ${r.code} · ${seconds(r.ms)}`);
  }

  // ---- ejecución ----
  let seq = 0;
  let controller = null;
  let timer = null;

  async function run() {
    clearTimeout(timer);
    controller?.abort();
    controller = new AbortController();
    const mine = ++seq;
    const code = cm.getValue();
    clearMarks();
    setStatus('busy', 'Compilando…');
    timingEl.textContent = '';
    const t0 = performance.now();
    try {
      const res = await fetch('api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, stdin: stdinEl.value }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (mine !== seq || res.status === 409) return;
      if (!res.ok) {
        message(data.error || `Error ${res.status}`, 'w');
        setStatus('warn', res.status === 429 ? 'Demasiado rápido' : res.status === 503 ? 'Servidor ocupado' : 'No se pudo ejecutar');
        return;
      }
      fileEl.textContent = data.fileName;
      const total = performance.now() - t0;
      timingEl.textContent = `${Math.round(total)} ms en total`;
      if (!data.compile.ok) {
        renderCompileError(data.compile);
        const n = (data.compile.output.match(/: error: /g) || []).length;
        setStatus('err', n === 1 ? '1 error de compilación' : n > 1 ? `${n} errores de compilación` : 'No compila');
        return;
      }
      renderRun(data.run, code);
      setStatus(data.run.timedOut || data.run.code !== 0 ? 'warn' : 'ok',
        data.run.timedOut ? 'Tiempo agotado' : data.run.code === 0 ? `✓ Ejecutado · ${seconds(total)}` : `Terminó con error (${data.run.code})`);
    } catch (e) {
      if (e.name === 'AbortError') return;
      message('No se pudo conectar con el servidor. Comprueba tu conexión.', 'w');
      setStatus('err', 'Sin conexión');
    }
  }

  function schedule() {
    if (!autoEl.checked) { setStatus('idle', 'Cambios sin ejecutar'); return; }
    clearTimeout(timer);
    setStatus('idle', 'Escribiendo…');
    timer = setTimeout(run, DEBOUNCE_MS);
  }

  // ---- descarga ----
  let toastTimer = null;
  function toast(text) {
    const t = $('toast'); t.textContent = text; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }
  function download() {
    const name = detectName(cm.getValue());
    const blob = new Blob([cm.getValue()], { type: 'text/x-java-source;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Descargado ' + name);
  }

  // ---- eventos ----
  cm.on('change', () => {
    store.set('code', cm.getValue());
    fileEl.textContent = detectName(cm.getValue());
    clearMarks();
    schedule();
  });
  stdinEl.addEventListener('input', () => { store.set('stdin', stdinEl.value); schedule(); });
  autoEl.addEventListener('change', () => { store.set('auto', autoEl.checked ? '1' : '0'); if (autoEl.checked) schedule(); else setStatus('idle', 'Auto desactivado'); });
  $('run').addEventListener('click', run);
  $('download').addEventListener('click', download);
  $('reset').addEventListener('click', () => {
    if (cm.getValue() !== DEFAULT_CODE && !confirm('Se perderá tu código actual y volverá el ejemplo inicial. ¿Seguro?')) return;
    cm.setValue(DEFAULT_CODE); stdinEl.value = DEFAULT_STDIN; store.set('stdin', DEFAULT_STDIN);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); download(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
  });

  fileEl.textContent = detectName(cm.getValue());
  cm.focus();
  run();
})();

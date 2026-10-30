'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze, validate } = require('../lib/source');

test('clase pública con main', () => {
  const r = analyze('public class Calculadora { public static void main(String[] a) {} }');
  assert.equal(r.fileName, 'Calculadora.java');
  assert.equal(r.mainClass, 'Calculadora');
});

test('sin clase pública: Main.java y la clase que contiene main', () => {
  const r = analyze('class Otra {}\nclass Programa { public static void main(String[] a) {} }');
  assert.equal(r.fileName, 'Main.java');
  assert.equal(r.mainClass, 'Programa');
});

test('main dentro del tipo público aunque haya otras clases antes y después', () => {
  const r = analyze('class A {}\npublic class Uno { public static void main(String[] a){} }\nclass B {}');
  assert.equal(r.fileName, 'Uno.java');
  assert.equal(r.mainClass, 'Uno');
});

test('ignora comentarios y textos que parecen código', () => {
  const r = analyze('// public class Falsa\n/* public class Tambien */\npublic class Real { String s = "public class Mentira"; public static void main(String[] a){} }');
  assert.equal(r.fileName, 'Real.java');
});

test('package se añade al nombre de la clase principal', () => {
  const r = analyze('package ejercicios.uno;\npublic class Hola { public static void main(String[] a){} }');
  assert.equal(r.mainClass, 'ejercicios.uno.Hola');
});

test('record, enum e interface públicos', () => {
  assert.equal(analyze('public record Punto(int x) {}').fileName, 'Punto.java');
  assert.equal(analyze('public enum Dia { L, M }').fileName, 'Dia.java');
});

test('nombres con caracteres peligrosos no llegan al nombre de archivo', () => {
  const r = analyze('public class $Raro { }');
  assert.match(r.fileName, /^[A-Za-z_][A-Za-z0-9_]*\.java$/);
});

test('validación de entrada', () => {
  assert.equal(validate({ code: 'class A{}' }), null);
  assert.ok(validate({ code: '' }));
  assert.ok(validate({ code: 5 }));
  assert.ok(validate(null));
  assert.ok(validate({ code: 'x'.repeat(60_000) }));
  assert.ok(validate({ code: 'a', stdin: 'x'.repeat(20_000) }));
});

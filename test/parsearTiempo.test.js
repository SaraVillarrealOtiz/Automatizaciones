const test = require('node:test');
const assert = require('node:assert/strict');
const { parsearFechaLimite, parsearFechaLimiteConHora, parsearTiempoEstimadoMinutos } = require('../src/interpretacion/parsearTiempo');

test('mañana y pasado mañana son fechas distintas', () => {
  const manana = parsearFechaLimite('mañana');
  const pasadoManana = parsearFechaLimite('pasado mañana');
  assert.ok(manana);
  assert.ok(pasadoManana);
  assert.notStrictEqual(manana.getTime(), pasadoManana.getTime());
  assert.strictEqual(pasadoManana.getTime() - manana.getTime(), 24 * 60 * 60 * 1000);
});

test('fecha con formato "20 de julio"', () => {
  const fecha = parsearFechaLimite('20 de julio');
  assert.ok(fecha);
  assert.strictEqual(fecha.getUTCDate(), 20);
});

test('fecha numérica dd/mm/yyyy', () => {
  const fecha = parsearFechaLimite('20/07/2026');
  assert.ok(fecha);
});

test('texto sin sentido devuelve null, nunca adivina', () => {
  assert.strictEqual(parsearFechaLimite('algo sin sentido'), null);
  assert.strictEqual(parsearFechaLimite(''), null);
  assert.strictEqual(parsearFechaLimite(null), null);
});

test('tiempo estimado en horas y minutos', () => {
  assert.strictEqual(parsearTiempoEstimadoMinutos('2 horas'), 120);
  assert.strictEqual(parsearTiempoEstimadoMinutos('30 minutos'), 30);
  assert.strictEqual(parsearTiempoEstimadoMinutos('medio dia'), 240);
  assert.strictEqual(parsearTiempoEstimadoMinutos('1.5 h'), 90);
});

test('tiempo estimado no reconocido devuelve null', () => {
  assert.strictEqual(parsearTiempoEstimadoMinutos('no se'), null);
});

test('parsearFechaLimiteConHora sin hora mencionada usa la hora por defecto y horaExplicita=false', () => {
  const resultado = parsearFechaLimiteConHora('mañana');
  assert.ok(resultado);
  assert.strictEqual(resultado.horaExplicita, false);
  assert.deepStrictEqual(resultado.fecha, parsearFechaLimite('mañana'));
});

test('parsearFechaLimiteConHora detecta hora explicita en formato "3pm"', () => {
  const resultado = parsearFechaLimiteConHora('mañana a las 3pm');
  assert.ok(resultado);
  assert.strictEqual(resultado.horaExplicita, true);
  // 3pm Bogota (UTC-5) = 20:00 UTC
  assert.strictEqual(resultado.fecha.getUTCHours(), 20);
});

test('parsearFechaLimiteConHora detecta formato 24 horas "15:00"', () => {
  const resultado = parsearFechaLimiteConHora('mañana a las 15:00');
  assert.strictEqual(resultado.horaExplicita, true);
  assert.strictEqual(resultado.fecha.getUTCHours(), 20);
});

test('parsearFechaLimiteConHora detecta "mediodia"', () => {
  const resultado = parsearFechaLimiteConHora('mañana a mediodia');
  assert.strictEqual(resultado.horaExplicita, true);
  assert.strictEqual(resultado.fecha.getUTCHours(), 17); // 12pm Bogota = 17:00 UTC
});

test('parsearFechaLimiteConHora devuelve null si la fecha no se entiende, sin importar la hora', () => {
  assert.strictEqual(parsearFechaLimiteConHora('a las 3pm'), null);
});

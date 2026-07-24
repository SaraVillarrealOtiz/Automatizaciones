const test = require('node:test');
const assert = require('node:assert/strict');
const { detectarCambios, urgenciaDesdePrioridadPlanner } = require('../src/teams/avisosCambiosPlanner');

test('urgenciaDesdePrioridadPlanner mapea toda la banda 0-10 de Planner', () => {
  assert.equal(urgenciaDesdePrioridadPlanner(0), 'Urgente');
  assert.equal(urgenciaDesdePrioridadPlanner(1), 'Urgente');
  assert.equal(urgenciaDesdePrioridadPlanner(2), 'Importante');
  assert.equal(urgenciaDesdePrioridadPlanner(4), 'Importante');
  assert.equal(urgenciaDesdePrioridadPlanner(5), 'Media');
  assert.equal(urgenciaDesdePrioridadPlanner(7), 'Media');
  assert.equal(urgenciaDesdePrioridadPlanner(8), 'Baja');
  assert.equal(urgenciaDesdePrioridadPlanner(10), 'Baja');
});

test('detectarCambios no reporta nada si Planner coincide con Firestore', () => {
  const tarea = { fechaLimite: '2026-08-01T22:00:00.000Z', urgencia: 'Media' };
  const tareaPlanner = { dueDateTime: '2026-08-01T22:00:00.000Z', priority: 5 };
  const { cambios, cambiosFirestore } = detectarCambios(tarea, tareaPlanner);
  assert.equal(cambios.length, 0);
  assert.deepEqual(cambiosFirestore, {});
});

test('detectarCambios detecta cambio de fecha, guarda original y arma historial', () => {
  const tarea = { fechaLimite: '2026-08-01T22:00:00.000Z', urgencia: 'Media' };
  const tareaPlanner = { dueDateTime: '2026-08-05T22:00:00.000Z', priority: 5 };
  const { cambios, cambiosFirestore } = detectarCambios(tarea, tareaPlanner);
  assert.equal(cambios.length, 1);
  assert.equal(cambios[0].numeroCambio, 1);
  assert.equal(cambiosFirestore.fechaLimiteOriginal, '2026-08-01T22:00:00.000Z');
  assert.equal(cambiosFirestore.fechaLimite, '2026-08-05T22:00:00.000Z');
  assert.equal(cambiosFirestore.historialFechaLimite.length, 1);
  assert.equal(cambiosFirestore.avisoEnviado, false);
});

test('detectarCambios no pisa fechaLimiteOriginal si ya existia (segundo cambio)', () => {
  const tarea = {
    fechaLimite: '2026-08-05T22:00:00.000Z',
    fechaLimiteOriginal: '2026-08-01T22:00:00.000Z',
    historialFechaLimite: [{ anterior: '2026-08-01T22:00:00.000Z', nueva: '2026-08-05T22:00:00.000Z', detectadoEn: '2026-07-25T00:00:00.000Z' }],
    urgencia: 'Media',
  };
  const tareaPlanner = { dueDateTime: '2026-08-10T22:00:00.000Z', priority: 5 };
  const { cambios, cambiosFirestore } = detectarCambios(tarea, tareaPlanner);
  assert.equal(cambios[0].numeroCambio, 2);
  assert.equal(cambiosFirestore.fechaLimiteOriginal, '2026-08-01T22:00:00.000Z');
  assert.equal(cambiosFirestore.historialFechaLimite.length, 2);
});

test('detectarCambios detecta cambio de prioridad', () => {
  const tarea = { fechaLimite: '2026-08-01T22:00:00.000Z', urgencia: 'Media' };
  const tareaPlanner = { dueDateTime: '2026-08-01T22:00:00.000Z', priority: 1 };
  const { cambios, cambiosFirestore } = detectarCambios(tarea, tareaPlanner);
  assert.equal(cambios.length, 1);
  assert.equal(cambiosFirestore.urgenciaOriginal, 'Media');
  assert.equal(cambiosFirestore.urgencia, 'Urgente');
  assert.equal(cambiosFirestore.historialUrgencia.length, 1);
});

test('detectarCambios detecta ambos a la vez y no toca avisoEnviado si solo cambia prioridad', () => {
  const tarea = { fechaLimite: '2026-08-01T22:00:00.000Z', urgencia: 'Baja' };
  const tareaPlanner = { dueDateTime: '2026-08-01T22:00:00.000Z', priority: 1 };
  const { cambios, cambiosFirestore } = detectarCambios(tarea, tareaPlanner);
  assert.equal(cambios.length, 1);
  assert.equal(cambiosFirestore.avisoEnviado, undefined);
});

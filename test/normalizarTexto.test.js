const test = require('node:test');
const assert = require('node:assert/strict');
const { mencionaNuevaTarea, esRespuestaAfirmativa } = require('../src/interpretacion/normalizarTexto');

test('mencionaNuevaTarea detecta frases de reinicio de tarea', () => {
  assert.strictEqual(mencionaNuevaTarea('Quiero asignar una nueva tarea'), true);
  assert.strictEqual(mencionaNuevaTarea('Necesito agregar otra tarea para Juan'), true);
  assert.strictEqual(mencionaNuevaTarea('Quiero asignar otra a Maria en Cliente X'), true);
});

test('mencionaNuevaTarea no se activa con texto normal de una tarea', () => {
  assert.strictEqual(mencionaNuevaTarea('Contabilizacion de nomina para Cliente X'), false);
  assert.strictEqual(mencionaNuevaTarea('mañana a las 3pm'), false);
});

test('esRespuestaAfirmativa reconoce confirmaciones comunes', () => {
  for (const texto of ['Si', 'si', 'Sí, dale', 'confirmo', 'Claro', 'Listo', 'de una']) {
    assert.strictEqual(esRespuestaAfirmativa(texto), true, `deberia ser afirmativo: "${texto}"`);
  }
});

test('esRespuestaAfirmativa no se activa con textos no afirmativos', () => {
  for (const texto of ['no', 'No gracias', 'sigamos con la anterior', 'otra cosa']) {
    assert.strictEqual(esRespuestaAfirmativa(texto), false, `no deberia ser afirmativo: "${texto}"`);
  }
});

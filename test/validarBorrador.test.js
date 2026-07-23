const test = require('node:test');
const assert = require('node:assert/strict');
const { validarBorrador, combinarBorradorCrudo } = require('../src/validacion/validarBorrador');

const responsables = [
  { id: 'r1', nombre: 'Juan Perez', alias: ['juan'], email: 'juan@jpulido.com.co', activo: true },
  { id: 'r2', nombre: 'Maria Gomez', alias: ['maria'], email: 'maria@jpulido.com.co', activo: true },
];
const clientes = [
  {
    id: 'c1',
    nombre: 'Acme SAS',
    alias: ['acme'],
    plannerGroupId: 'group-1',
    plannerPlanId: 'plan-1',
    bucketInicioId: 'bucket-inicio-1',
    auxiliarIds: ['r1'],
    analistaIds: ['r2'],
    supervisorIds: [],
  },
];

test('borrador incompleto pide el primer campo faltante', () => {
  const resultado = validarBorrador({ tarea: 'Enviar factura' }, { responsables, clientes });
  assert.strictEqual(resultado.valido, false);
  assert.strictEqual(resultado.campoPendiente, 'responsable');
});

test('borrador completo y válido se resuelve correctamente', () => {
  const crudo = {
    tarea: 'Enviar factura',
    responsable: 'juan',
    cliente: 'acme',
    fechaLimite: 'mañana',
    tiempoEstimado: '1 hora',
    urgencia: 'alta',
    descripcion: 'Enviar factura de julio',
  };
  const resultado = validarBorrador(crudo, { responsables, clientes });
  assert.strictEqual(resultado.valido, true);
  assert.strictEqual(resultado.resuelto.responsables.length, 1);
  assert.strictEqual(resultado.resuelto.responsables[0].id, 'r1');
  assert.strictEqual(resultado.resuelto.cliente.id, 'c1');
  // "alta" es alias heredado de "Urgente" (ver src/interpretacion/normalizarTexto.js)
  assert.strictEqual(resultado.resuelto.urgencia, 'Urgente');
  // "juan" es auxiliarId del cliente "acme" -> nivel inicial Auxiliar
  assert.strictEqual(resultado.resuelto.responsables[0].nivelActual, 'Auxiliar');
});

test('el nivel se determina segun el rol de esa persona para ese cliente en particular', () => {
  const crudo = {
    tarea: 'Enviar factura',
    responsable: 'maria',
    cliente: 'acme',
    fechaLimite: 'mañana',
    tiempoEstimado: '1 hora',
    urgencia: 'alta',
    descripcion: 'Enviar factura de julio',
  };
  const resultado = validarBorrador(crudo, { responsables, clientes });
  assert.strictEqual(resultado.valido, true);
  // "maria" es analistaId del cliente "acme" -> nivel inicial Analista
  assert.strictEqual(resultado.resuelto.responsables[0].nivelActual, 'Analista');
});

test('persona valida pero que no pertenece a la cadena de ese cliente es rechazada', () => {
  const otroCliente = [
    { id: 'c2', nombre: 'Beta SAS', alias: ['beta'], plannerGroupId: 'group-2', plannerPlanId: 'plan-2', bucketInicioId: 'bucket-2', auxiliarIds: ['r2'], analistaIds: [], supervisorIds: [] },
  ];
  const crudo = {
    tarea: 'Enviar factura',
    responsable: 'juan', // juan no esta en la cadena de "beta" (solo maria/r2 lo esta)
    cliente: 'beta',
    fechaLimite: 'mañana',
    tiempoEstimado: '1 hora',
    urgencia: 'alta',
    descripcion: 'x',
  };
  const resultado = validarBorrador(crudo, { responsables, clientes: otroCliente });
  assert.strictEqual(resultado.valido, false);
  assert.strictEqual(resultado.campoPendiente, 'responsable');
});

test('cualquiera de varias personas listadas en un mismo rol es valida', () => {
  const clienteConDosSupervisores = [
    {
      id: 'c3',
      nombre: 'Gamma SAS',
      alias: ['gamma'],
      plannerGroupId: 'group-3',
      plannerPlanId: 'plan-3',
      bucketInicioId: 'bucket-3',
      auxiliarIds: [],
      analistaIds: [],
      supervisorIds: ['r1', 'r2'],
    },
  ];
  for (const nombre of ['juan', 'maria']) {
    const crudo = {
      tarea: 'Enviar factura',
      responsable: nombre,
      cliente: 'gamma',
      fechaLimite: 'mañana',
      urgencia: 'alta',
      descripcion: 'x',
    };
    const resultado = validarBorrador(crudo, { responsables, clientes: clienteConDosSupervisores });
    assert.strictEqual(resultado.valido, true);
    assert.strictEqual(resultado.resuelto.responsables[0].nivelActual, 'Supervisor');
  }
});

test('responsable fuera de lista es rechazado, no se adivina', () => {
  const crudo = {
    tarea: 'Enviar factura',
    responsable: 'alguien inventado',
    cliente: 'acme',
    fechaLimite: 'mañana',
    tiempoEstimado: '1 hora',
    urgencia: 'alta',
    descripcion: 'x',
  };
  const resultado = validarBorrador(crudo, { responsables, clientes });
  assert.strictEqual(resultado.valido, false);
  assert.strictEqual(resultado.campoPendiente, 'responsable');
});

test('tiempoEstimado ausente no bloquea la tarea (es opcional)', () => {
  const crudo = {
    tarea: 'Enviar factura',
    responsable: 'juan',
    cliente: 'acme',
    fechaLimite: 'mañana',
    urgencia: 'alta',
    descripcion: 'x',
  };
  const resultado = validarBorrador(crudo, { responsables, clientes });
  assert.strictEqual(resultado.valido, true);
  assert.strictEqual(resultado.resuelto.tiempoEstimadoMinutos, null);
});

test('tiempoEstimado mencionado pero no interpretable si bloquea (no se descarta en silencio)', () => {
  const crudo = {
    tarea: 'Enviar factura',
    responsable: 'juan',
    cliente: 'acme',
    fechaLimite: 'mañana',
    tiempoEstimado: 'mañana',
    urgencia: 'alta',
    descripcion: 'x',
  };
  const resultado = validarBorrador(crudo, { responsables, clientes });
  assert.strictEqual(resultado.valido, false);
  assert.strictEqual(resultado.campoPendiente, 'tiempoEstimado');
});

test('fecha límite ya vencida es rechazada', () => {
  const crudo = {
    tarea: 'Enviar factura',
    responsable: 'juan',
    cliente: 'acme',
    fechaLimite: '20/07/2020',
    tiempoEstimado: '1 hora',
    urgencia: 'alta',
    descripcion: 'x',
  };
  const resultado = validarBorrador(crudo, { responsables, clientes });
  assert.strictEqual(resultado.valido, false);
  assert.strictEqual(resultado.campoPendiente, 'fechaLimite');
});

test('combinarBorradorCrudo no sobreescribe con null y preserva campos previos', () => {
  const combinado = combinarBorradorCrudo({ tarea: 'A', cliente: 'acme' }, { tarea: null, responsable: 'juan' });
  assert.deepStrictEqual(combinado, { tarea: 'A', cliente: 'acme', responsable: 'juan' });
});

test('un responsable mal escrito se avisa de inmediato, sin esperar a que el borrador este completo', () => {
  // Solo se ha dado "tarea" y "responsable" (con un typo) -- aun faltan cliente, fecha,
  // urgencia y descripcion, pero el error de responsable debe salir YA, no al final.
  const resultado = validarBorrador({ tarea: 'Enviar factura', responsable: 'natilia' }, { responsables, clientes });
  assert.strictEqual(resultado.valido, false);
  assert.strictEqual(resultado.campoPendiente, 'responsable');
  assert.match(resultado.mensaje, /No reconozco "natilia"/);
});

test('un cliente mal escrito se avisa de inmediato, sin esperar a que el borrador este completo', () => {
  const resultado = validarBorrador({ tarea: 'Enviar factura', cliente: 'acmee' }, { responsables, clientes });
  assert.strictEqual(resultado.valido, false);
  assert.strictEqual(resultado.campoPendiente, 'cliente');
  assert.match(resultado.mensaje, /No reconozco "acmee"/);
});

test('dos responsables separados por "y" quedan ambos asignados si los dos pertenecen a la cadena del cliente', () => {
  const clienteConAmbosRoles = [
    { id: 'c4', nombre: 'Delta SAS', alias: ['delta'], plannerGroupId: 'g4', plannerPlanId: 'p4', bucketInicioId: 'b4', auxiliarIds: ['r1'], analistaIds: ['r2'], supervisorIds: [] },
  ];
  const crudo = {
    tarea: 'Planilla de seguridad social',
    responsable: 'juan y maria',
    cliente: 'delta',
    fechaLimite: 'mañana',
    urgencia: 'media',
    descripcion: 'x',
  };
  const resultado = validarBorrador(crudo, { responsables, clientes: clienteConAmbosRoles });
  assert.strictEqual(resultado.valido, true);
  assert.strictEqual(resultado.resuelto.responsables.length, 2);
  assert.deepStrictEqual(resultado.resuelto.responsables.map((r) => r.id), ['r1', 'r2']);
  assert.strictEqual(resultado.resuelto.responsables[0].nivelActual, 'Auxiliar');
  assert.strictEqual(resultado.resuelto.responsables[1].nivelActual, 'Analista');
});

test('si uno de los dos responsables mencionados no existe, se rechaza nombrando a esa persona', () => {
  const crudo = {
    tarea: 'Planilla de seguridad social',
    responsable: 'juan y natilia',
    cliente: 'acme',
    fechaLimite: 'mañana',
    urgencia: 'media',
    descripcion: 'x',
  };
  const resultado = validarBorrador(crudo, { responsables, clientes });
  assert.strictEqual(resultado.valido, false);
  assert.strictEqual(resultado.campoPendiente, 'responsable');
  assert.match(resultado.mensaje, /No reconozco "natilia"/);
});

test('si uno de los dos responsables no pertenece a la cadena de ese cliente, se rechaza', () => {
  // "acme": juan es auxiliar, maria es analista -> ambos SI pertenecen. Probamos con un
  // cliente donde solo uno de los dos esta en la cadena.
  const clienteSoloConJuan = [
    { id: 'c5', nombre: 'Epsilon SAS', alias: ['epsilon'], plannerGroupId: 'g5', plannerPlanId: 'p5', bucketInicioId: 'b5', auxiliarIds: ['r1'], analistaIds: [], supervisorIds: [] },
  ];
  const crudo = {
    tarea: 'Planilla de seguridad social',
    responsable: 'juan y maria',
    cliente: 'epsilon',
    fechaLimite: 'mañana',
    urgencia: 'media',
    descripcion: 'x',
  };
  const resultado = validarBorrador(crudo, { responsables, clientes: clienteSoloConJuan });
  assert.strictEqual(resultado.valido, false);
  assert.strictEqual(resultado.campoPendiente, 'responsable');
  assert.match(resultado.mensaje, /Maria Gomez/);
});

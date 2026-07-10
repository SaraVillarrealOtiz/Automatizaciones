const { getDb } = require('../firestore/firebaseAdmin');

const COLECCION = 'conversaciones';
const MAX_HISTORIAL = 20;

const ESTADO_INICIAL = {
  estado: 'recolectando',
  borrador: {},
  ultimaActualizacion: null,
  historial: [],
  nombreSolicitante: null,
};

async function obtenerConversacion(telefono) {
  const db = getDb();
  const ref = db.collection(COLECCION).doc(telefono);
  const snap = await ref.get();

  if (!snap.exists) {
    return { ...ESTADO_INICIAL };
  }

  return { ...ESTADO_INICIAL, ...snap.data() };
}

async function guardarConversacion(telefono, conversacion) {
  const db = getDb();
  const ref = db.collection(COLECCION).doc(telefono);

  await ref.set(
    {
      ...conversacion,
      ultimaActualizacion: new Date().toISOString(),
    },
    { merge: false }
  );
}

function agregarAlHistorial(conversacion, rol, texto) {
  const historial = [...(conversacion.historial || []), { rol, texto, timestamp: new Date().toISOString() }];

  return {
    ...conversacion,
    historial: historial.slice(-MAX_HISTORIAL),
  };
}

async function reiniciarConversacion(telefono) {
  await guardarConversacion(telefono, { ...ESTADO_INICIAL });
}

module.exports = {
  obtenerConversacion,
  guardarConversacion,
  agregarAlHistorial,
  reiniciarConversacion,
};

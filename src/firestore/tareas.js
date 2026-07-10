const { getDb } = require('./firebaseAdmin');

const COLECCION = 'tareas';

async function crearTarea(datos) {
  const db = getDb();
  const ref = await db.collection(COLECCION).add({
    ...datos,
    creadaEn: new Date().toISOString(),
  });
  return ref.id;
}

async function actualizarTarea(tareaId, cambios) {
  const db = getDb();
  await db.collection(COLECCION).doc(tareaId).update(cambios);
}

async function registrarEvento(tareaId, tipo, detalle = {}) {
  const db = getDb();
  await db
    .collection(COLECCION)
    .doc(tareaId)
    .collection('eventos')
    .add({ tipo, detalle, timestamp: new Date().toISOString() });
}

module.exports = { crearTarea, actualizarTarea, registrarEvento };

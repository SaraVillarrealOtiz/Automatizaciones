const { getDb } = require('./firebaseAdmin');

const COLECCION = 'responsables';
const TTL_CACHE_MS = 5 * 60 * 1000;

let cache = null;
let cacheTimestamp = 0;

async function listarResponsables({ forzarRecarga = false } = {}) {
  const ahora = Date.now();
  if (!forzarRecarga && cache && ahora - cacheTimestamp < TTL_CACHE_MS) {
    return cache;
  }

  const db = getDb();
  const snap = await db.collection(COLECCION).where('activo', '==', true).get();
  cache = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  cacheTimestamp = ahora;

  return cache;
}

module.exports = { listarResponsables };

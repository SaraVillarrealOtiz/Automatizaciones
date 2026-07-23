const { getDb, getAuth } = require('../firestore/firebaseAdmin');

async function verificarToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Falta el token de autenticación (header Authorization: Bearer <token>).' });
  }

  try {
    req.usuario = await getAuth().verifyIdToken(token);
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Token inválido o expirado.' });
  }
}

function registerReportesRoute(app) {
  app.get('/reportes/tareas', verificarToken, async (req, res) => {
    try {
      const db = getDb();
      let query = db.collection('tareas');

      if (req.query.estado) query = query.where('estado', '==', req.query.estado);
      // `responsableEmails` es el arreglo con todos los responsables de la tarea (uno o
      // mas, ver src/validacion/validarBorrador.js); array-contains encuentra la tarea sin
      // importar si esa persona fue la primera o una adicional.
      if (req.query.responsableEmail) query = query.where('responsableEmails', 'array-contains', req.query.responsableEmail);
      if (req.query.cliente) query = query.where('cliente', '==', req.query.cliente);

      const limite = Math.min(parseInt(req.query.limite, 10) || 100, 500);
      const snap = await query.orderBy('creadaEn', 'desc').limit(limite).get();

      const tareas = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      res.status(200).json({ total: tareas.length, tareas });
    } catch (err) {
      console.error('Error en /reportes/tareas:', err);
      res.status(500).json({ error: 'Error interno consultando el reporte.' });
    }
  });
}

module.exports = { registerReportesRoute };

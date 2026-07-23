const { getDb } = require('../firestore/firebaseAdmin');
const { graphRequest } = require('../planner/graphClient');

// Solo tiene sentido comparar "misma hora y mismo dia" cuando el usuario SI mencionó una
// hora especifica (ver parsearFechaLimiteConHora) — si ambas tareas solo usan la hora por
// defecto, coincidirian siempre sin que eso signifique un conflicto real, asi que ese caso
// nunca se revisa. El conflicto se busca contra CUALQUIER cliente de ese responsable (una
// persona solo tiene una agenda), y solo contra tareas que en Planner aun no esten
// completadas (percentComplete < 100) — se consulta Planner en vivo porque Firestore no
// sincroniza ese estado. Si la tarea nueva tiene mas de un responsable (ver
// src/validacion/validarBorrador.js), se revisa a CADA UNO por separado — protege la
// agenda de cada persona individualmente, no solo la del primero mencionado.
async function verificarConflictoHorario({ resuelto }) {
  if (!resuelto.horaLimiteExplicita) {
    return { conflicto: false };
  }

  const db = getDb();

  for (const responsable of resuelto.responsables) {
    const candidatos = await db
      .collection('tareas')
      .where('responsableEmails', 'array-contains', responsable.email)
      .where('fechaLimite', '==', resuelto.fechaLimite.toISOString())
      .where('estado', '==', 'creada')
      .get();

    for (const doc of candidatos.docs) {
      const tareaExistente = doc.data();
      if (!tareaExistente.plannerTaskId) continue;

      let tareaPlanner;
      try {
        tareaPlanner = await graphRequest('GET', `/planner/tasks/${tareaExistente.plannerTaskId}`);
      } catch {
        continue; // la tarea ya no existe en Planner, no cuenta como conflicto
      }

      if (tareaPlanner.percentComplete < 100) {
        return { conflicto: true, responsableConflicto: responsable, tareaExistente: { id: doc.id, ...tareaExistente } };
      }
    }
  }

  return { conflicto: false };
}

module.exports = { verificarConflictoHorario };

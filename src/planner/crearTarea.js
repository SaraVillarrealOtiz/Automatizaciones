const { graphRequest } = require('./graphClient');

// Mapeo confirmado con el usuario: nuestra urgencia (4 niveles, igual que Planner) contra
// la prioridad nativa de Planner (Int32 0-10, ver src/interpretacion/normalizarTexto.js):
// 1=Urgent, 3=Important, 5=Medium, 9=Low.
const PRIORIDAD_PLANNER_POR_URGENCIA = { Urgente: 1, Importante: 3, Media: 5, Baja: 9 };

async function resolverUsuarioAAD(email) {
  const usuario = await graphRequest('GET', `/users/${encodeURIComponent(email)}?$select=id,displayName`);
  return usuario.id;
}

// Planner solo notifica/muestra correctamente una asignacion si la persona ya es
// miembro del grupo de Microsoft 365 que respalda el Plan del cliente; si no lo es,
// la API deja crear la asignacion igual pero queda "rota" (sin notificacion por
// correo, sin verse bien en el tablero). Por eso se asegura la membresia antes de
// asignar, en vez de asumir que ya es miembro.
async function asegurarMiembroDelGrupo(groupId, userId) {
  try {
    await graphRequest('POST', `/groups/${groupId}/members/$ref`, {
      '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${userId}`,
    });
  } catch (err) {
    const mensaje = err.response && err.response.data && err.response.data.error && err.response.data.error.message;
    // "One or more added object references already exist" = ya era miembro, no es un error real.
    if (mensaje && /already exist/i.test(mensaje)) return;
    throw err;
  }
}

// El Plan de Planner y el Bucket "Inicio" ya quedan resueltos en el documento del
// cliente (colección `clientes`, poblada por scripts/poblarClientesYResponsables.js).
// La tarea siempre se crea en el Bucket "Inicio"; el avance por las demas etapas
// (Planificación, Ejecución, Cierre, etc.) se gestiona directamente en Planner.
async function crearTareaPlanner({ resuelto }) {
  // `resuelto.responsables` es un arreglo (uno o mas, ver src/validacion/validarBorrador.js)
  // — cada persona queda como asignada independiente en el mismo task de Planner.
  const asignaciones = {};
  for (const responsable of resuelto.responsables) {
    const asignadoAId = await resolverUsuarioAAD(responsable.email);
    await asegurarMiembroDelGrupo(resuelto.cliente.plannerGroupId, asignadoAId);
    asignaciones[asignadoAId] = {
      '@odata.type': '#microsoft.graph.plannerAssignment',
      orderHint: ' !',
    };
  }

  const tarea = await graphRequest('POST', '/planner/tasks', {
    planId: resuelto.cliente.plannerPlanId,
    bucketId: resuelto.cliente.bucketInicioId,
    title: resuelto.tarea,
    dueDateTime: resuelto.fechaLimite.toISOString(),
    priority: PRIORIDAD_PLANNER_POR_URGENCIA[resuelto.urgencia],
    assignments: asignaciones,
  });

  const detallesActuales = await graphRequest('GET', `/planner/tasks/${tarea.id}/details`);

  const referencias = {};
  for (const adjunto of resuelto.adjuntos || []) {
    referencias[encodeURI(adjunto.url)] = {
      '@odata.type': '#microsoft.graph.plannerExternalReference',
      alias: adjunto.mimeType || 'adjunto',
      type: 'Other',
    };
  }

  await graphRequest('PATCH', `/planner/tasks/${tarea.id}/details`, {
    description: resuelto.descripcion,
    references: referencias,
    __etag: detallesActuales['@odata.etag'],
  });

  return {
    exito: true,
    plannerPlanId: resuelto.cliente.plannerPlanId,
    plannerBucketId: resuelto.cliente.bucketInicioId,
    plannerTaskId: tarea.id,
  };
}

module.exports = { crearTareaPlanner, resolverUsuarioAAD, asegurarMiembroDelGrupo, PRIORIDAD_PLANNER_POR_URGENCIA };

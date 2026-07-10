const { graphRequest } = require('./graphClient');

async function resolverUsuarioAAD(email) {
  const usuario = await graphRequest('GET', `/users/${encodeURIComponent(email)}?$select=id,displayName`);
  return usuario.id;
}

// El Plan de Planner y el Bucket "Inicio" ya quedan resueltos en el documento del
// cliente (colección `clientes`, poblada por scripts/poblarClientesYResponsables.js).
// La tarea siempre se crea en el Bucket "Inicio"; el avance por las demas etapas
// (Planificación, Ejecución, Cierre, etc.) se gestiona directamente en Planner.
async function crearTareaPlanner({ resuelto }) {
  const asignadoAId = await resolverUsuarioAAD(resuelto.responsable.email);

  const tarea = await graphRequest('POST', '/planner/tasks', {
    planId: resuelto.cliente.plannerPlanId,
    bucketId: resuelto.cliente.bucketInicioId,
    title: resuelto.tarea,
    dueDateTime: resuelto.fechaLimite.toISOString(),
    assignments: {
      [asignadoAId]: {
        '@odata.type': '#microsoft.graph.plannerAssignment',
        orderHint: ' !',
      },
    },
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

module.exports = { crearTareaPlanner, resolverUsuarioAAD };

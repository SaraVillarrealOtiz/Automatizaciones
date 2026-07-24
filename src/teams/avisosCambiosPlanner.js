// Avisos por Microsoft Teams cuando alguien cambia directamente en Planner la fecha de
// vencimiento o la prioridad de una tarea ya creada por ContaLigal (fuera de WhatsApp).
// Planner no permite restringir esas acciones por permisos, asi que en vez de bloquearlas
// se vigilan por comparacion periodica (mismo patron de sondeo cada 5 min que
// src/teams/avisosVencimiento.js) contra lo que quedo registrado en Firestore al crear la
// tarea.

const axios = require('axios');
const { getDb } = require('../firestore/firebaseAdmin');
const { graphRequest } = require('../planner/graphClient');
const { PRIORIDAD_PLANNER_POR_URGENCIA } = require('../planner/crearTarea');

const VENTANA_REVISION_MS = 5 * 60 * 1000; // se revisa cada 5 minutos

// Banda de interpretacion de Planner para el campo priority (Int32 0-10), documentada en
// contalia_planner_api_notes.md: 0,1=Urgent 2-4=Important 5-7=Medium 8-10=Low. Se usa esta
// banda (no solo los 4 valores exactos 1/3/5/9 que nosotros escribimos) porque alguien
// editando directamente en la UI de Planner puede quedar con cualquier valor del rango.
function urgenciaDesdePrioridadPlanner(prioridad) {
  if (prioridad <= 1) return 'Urgente';
  if (prioridad <= 4) return 'Importante';
  if (prioridad <= 7) return 'Media';
  return 'Baja';
}

function formatearFechaHoraBogota(fecha) {
  return fecha.toLocaleString('es-CO', {
    timeZone: 'America/Bogota',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function construirTarjetaCambio(tarea, cambios) {
  const responsablesTexto = Array.isArray(tarea.responsables) && tarea.responsables.length
    ? tarea.responsables.map((r) => r.nombre).join(', ')
    : tarea.responsableEmail || '(sin responsable)';

  const bloquesCambios = cambios.map((c) => ({
    type: 'TextBlock',
    text: `🔁 ${c.etiqueta}: ${c.anteriorTexto} → **${c.nuevoTexto}** (cambio #${c.numeroCambio} de esta tarea)`,
    wrap: true,
  }));

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: '🔧 Cambio detectado en Planner', weight: 'Bolder', size: 'Medium', color: 'Warning' },
            { type: 'TextBlock', text: `📋 ${tarea.tarea}`, wrap: true, weight: 'Bolder' },
            { type: 'TextBlock', text: `🏢 Cliente: ${tarea.cliente}`, wrap: true },
            { type: 'TextBlock', text: `👤 Responsable(s): ${responsablesTexto}`, wrap: true },
            ...bloquesCambios,
            { type: 'TextBlock', text: 'Este cambio se hizo directamente en Planner, no desde WhatsApp.', wrap: true, isSubtle: true },
          ],
        },
      },
    ],
  };
}

async function enviarAvisoCambio(payload) {
  const webhookUrl = process.env.TEAMS_WEBHOOK_URL_CAMBIOS;
  if (!webhookUrl) return; // sin webhook configurado, no se envia nada (no se asume)
  await axios.post(webhookUrl, payload);
}

// Compara la tarea de Planner contra lo registrado en Firestore. Si detecta un cambio en
// fecha de vencimiento y/o prioridad, arma los cambios a aplicar en Firestore: mantiene el
// valor "Original" (el primero que se registro) intacto y agrega al arreglo `historialX` un
// registro por cada cambio detectado, para trazabilidad de cuantas veces cambio cada campo.
function detectarCambios(tarea, tareaPlanner) {
  const cambios = [];
  const cambiosFirestore = {};

  const fechaFirestoreMs = tarea.fechaLimite ? new Date(tarea.fechaLimite).getTime() : null;
  const fechaPlannerMs = tareaPlanner.dueDateTime ? new Date(tareaPlanner.dueDateTime).getTime() : null;
  if (fechaFirestoreMs !== fechaPlannerMs) {
    const historial = tarea.historialFechaLimite || [];
    cambios.push({
      etiqueta: '📅 Fecha de vencimiento',
      anteriorTexto: tarea.fechaLimite ? formatearFechaHoraBogota(new Date(tarea.fechaLimite)) : '(sin fecha)',
      nuevoTexto: tareaPlanner.dueDateTime ? formatearFechaHoraBogota(new Date(tareaPlanner.dueDateTime)) : '(sin fecha)',
      numeroCambio: historial.length + 1,
    });
    cambiosFirestore.fechaLimiteOriginal = tarea.fechaLimiteOriginal || tarea.fechaLimite || null;
    cambiosFirestore.fechaLimite = tareaPlanner.dueDateTime || null;
    cambiosFirestore.historialFechaLimite = [
      ...historial,
      { anterior: tarea.fechaLimite || null, nueva: tareaPlanner.dueDateTime || null, detectadoEn: new Date().toISOString() },
    ];
    // La fecha cambio: si ya se habia enviado el recordatorio de vencimiento para la fecha
    // vieja, se reactiva para que avisosVencimiento.js lo vuelva a evaluar con la fecha nueva.
    cambiosFirestore.avisoEnviado = false;
  }

  const urgenciaPlanner = typeof tareaPlanner.priority === 'number' ? urgenciaDesdePrioridadPlanner(tareaPlanner.priority) : null;
  if (urgenciaPlanner && urgenciaPlanner !== tarea.urgencia) {
    const historial = tarea.historialUrgencia || [];
    cambios.push({
      etiqueta: '🚦 Prioridad',
      anteriorTexto: tarea.urgencia || '(sin definir)',
      nuevoTexto: urgenciaPlanner,
      numeroCambio: historial.length + 1,
    });
    cambiosFirestore.urgenciaOriginal = tarea.urgenciaOriginal || tarea.urgencia || null;
    cambiosFirestore.urgencia = urgenciaPlanner;
    cambiosFirestore.historialUrgencia = [
      ...historial,
      { anterior: tarea.urgencia || null, nueva: urgenciaPlanner, detectadoEn: new Date().toISOString() },
    ];
  }

  return { cambios, cambiosFirestore };
}

async function revisarCambiosDePlanner() {
  if (!process.env.TEAMS_WEBHOOK_URL_CAMBIOS) return;

  const db = getDb();
  const snapTareas = await db.collection('tareas').where('estado', '==', 'creada').get();

  for (const doc of snapTareas.docs) {
    const tarea = doc.data();
    if (!tarea.plannerTaskId) continue;

    let tareaPlanner;
    try {
      tareaPlanner = await graphRequest('GET', `/planner/tasks/${tarea.plannerTaskId}`);
    } catch (err) {
      // 404 = la tarea ya no existe en Planner (borrada manualmente); no hay nada que
      // comparar, no se asume que eso cuenta como un "cambio" de fecha/prioridad.
      if (err.response && err.response.status === 404) continue;
      console.error('Error consultando tarea de Planner', tarea.plannerTaskId, ':', err.message);
      continue;
    }

    const { cambios, cambiosFirestore } = detectarCambios(tarea, tareaPlanner);
    if (!cambios.length) continue;

    try {
      await enviarAvisoCambio(construirTarjetaCambio(tarea, cambios));
      await doc.ref.update(cambiosFirestore);
    } catch (err) {
      console.error('Error enviando aviso de cambio de Planner para tarea', doc.id, ':', err.response ? JSON.stringify(err.response.data) : err.message);
    }
  }
}

function iniciarProgramadorDeCambiosPlanner() {
  if (!process.env.TEAMS_WEBHOOK_URL_CAMBIOS) {
    console.log('TEAMS_WEBHOOK_URL_CAMBIOS no configurado: avisos de cambios en Planner desactivados.');
    return;
  }
  console.log('Avisos de cambios en Planner activos (revisión cada 5 minutos).');
  setInterval(() => {
    revisarCambiosDePlanner().catch((err) => console.error('Error revisando cambios de Planner:', err.message));
  }, VENTANA_REVISION_MS);
}

module.exports = {
  revisarCambiosDePlanner,
  iniciarProgramadorDeCambiosPlanner,
  urgenciaDesdePrioridadPlanner,
  detectarCambios,
};

// Avisos por Microsoft Teams cuando una tarea esta por vencer (1 hora antes) o ya vencio.
// Solo aplica a tareas con hora de entrega EXPLICITA (ver src/interpretacion/parsearTiempo.js
// parsearFechaLimiteConHora) — si nadie dijo una hora especifica, no hay una hora concreta
// de la cual avisar "1 hora antes" con sentido, asi que esas tareas no generan aviso.
//
// Envio via un webhook de la app "Workflows" de Teams (reemplazo de los Conectores clasicos,
// retirados por Microsoft). Los Conectores clasicos y los webhooks de Workflows NO soportan
// botones interactivos (Action.Submit) — solo Action.OpenUrl/ShowCard/ToggleVisibility. Marcar
// una tarea como completada/en revision desde el mensaje requiere un Bot de Teams (Bot
// Framework), que queda como una fase posterior, no incluida aqui.

const axios = require('axios');
const { getDb } = require('../firestore/firebaseAdmin');
const { listarResponsables } = require('../firestore/responsables');
const { NIVELES_ESCALAMIENTO, CAMPO_IDS_POR_NIVEL } = require('../validacion/validarBorrador');

const VENTANA_REVISION_MS = 5 * 60 * 1000; // se revisa cada 5 minutos
const MARGEN_AVISO_MS = 5 * 60 * 1000; // ventana de +/-5 min alrededor de "1 hora antes"
const UNA_HORA_MS = 60 * 60 * 1000;

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

// Determina el siguiente nivel de escalamiento despues del nivel actual de la tarea
// (Auxiliar -> Analista -> Supervisor). Si ya esta en el nivel mas alto, no hay siguiente.
function nivelSiguiente(nivelActual) {
  const indice = NIVELES_ESCALAMIENTO.indexOf(nivelActual);
  if (indice === -1 || indice === NIVELES_ESCALAMIENTO.length - 1) return null;
  return NIVELES_ESCALAMIENTO[indice + 1];
}

async function nombresDePersonas(ids, responsablesPorId) {
  return ids.map((id) => responsablesPorId.get(id)?.nombre).filter(Boolean);
}

async function construirTarjeta(tarea, cliente, responsablesPorId) {
  const nivelSig = nivelSiguiente(tarea.nivelActual);
  const idsNivelSig = nivelSig ? cliente[CAMPO_IDS_POR_NIVEL[nivelSig]] || [] : [];
  const nombresNivelSig = await nombresDePersonas(idsNivelSig, responsablesPorId);

  const lineaEscalamiento = nivelSig && nombresNivelSig.length
    ? `🪜 Si no se completa a tiempo, escala a **${nivelSig}**: ${nombresNivelSig.join(', ')}`
    : '🪜 Este es el nivel más alto de escalamiento para este cliente.';

  const responsableNombre = responsablesPorId.get(tarea.responsableId)?.nombre || tarea.responsableEmail;

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
            { type: 'TextBlock', text: '⏰ Recordatorio de tarea próxima a vencer', weight: 'Bolder', size: 'Medium', color: 'Attention' },
            { type: 'TextBlock', text: `📋 ${tarea.tarea}`, wrap: true, weight: 'Bolder' },
            { type: 'TextBlock', text: `🏢 Cliente: ${cliente.nombre}`, wrap: true },
            { type: 'TextBlock', text: `👤 Responsable (${tarea.nivelActual}): ${responsableNombre}`, wrap: true },
            { type: 'TextBlock', text: `📅 Vence: ${formatearFechaHoraBogota(new Date(tarea.fechaLimite))}`, wrap: true },
            { type: 'TextBlock', text: lineaEscalamiento, wrap: true },
            { type: 'TextBlock', text: 'Por favor marca la tarea como completada en Planner si ya está lista.', wrap: true, isSubtle: true },
          ],
        },
      },
    ],
  };
}

async function enviarAvisoTeams(payload) {
  const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
  if (!webhookUrl) return; // sin webhook configurado, no se envia nada (no se asume)
  await axios.post(webhookUrl, payload);
}

// Revisa las tareas activas con hora de entrega explicita y envia el aviso a Teams a las
// que esten a ~1 hora de vencer y aun no hayan recibido el aviso. Se marca `avisoEnviado`
// para no enviar el mismo aviso dos veces.
async function revisarAvisosDeVencimiento() {
  if (!process.env.TEAMS_WEBHOOK_URL) return;

  const db = getDb();
  const ahora = Date.now();

  const [snapTareas, responsables] = await Promise.all([
    db.collection('tareas').where('estado', '==', 'creada').get(),
    listarResponsables(),
  ]);
  const responsablesPorId = new Map(responsables.map((r) => [r.id, r]));
  const responsablesPorEmail = new Map(responsables.map((r) => [r.email, r]));

  for (const doc of snapTareas.docs) {
    const tarea = doc.data();
    if (!tarea.horaLimiteExplicita || tarea.avisoEnviado || !tarea.clienteId) continue;

    const vence = new Date(tarea.fechaLimite).getTime();
    const faltan = vence - ahora;
    if (faltan < UNA_HORA_MS - MARGEN_AVISO_MS || faltan > UNA_HORA_MS + MARGEN_AVISO_MS) continue;

    const clienteSnap = await db.collection('clientes').doc(tarea.clienteId).get();
    if (!clienteSnap.exists) continue;
    const cliente = clienteSnap.data();

    const responsableActual = responsablesPorEmail.get(tarea.responsableEmail);
    const tareaConId = { ...tarea, responsableId: responsableActual?.id };

    try {
      const tarjeta = await construirTarjeta(tareaConId, cliente, responsablesPorId);
      await enviarAvisoTeams(tarjeta);
      await doc.ref.update({ avisoEnviado: true, avisoEnviadoEn: new Date().toISOString() });
    } catch (err) {
      console.error('Error enviando aviso de Teams para tarea', doc.id, ':', err.response ? JSON.stringify(err.response.data) : err.message);
    }
  }
}

function iniciarProgramadorDeAvisos() {
  if (!process.env.TEAMS_WEBHOOK_URL) {
    console.log('TEAMS_WEBHOOK_URL no configurado: avisos de vencimiento por Teams desactivados.');
    return;
  }
  console.log('Avisos de vencimiento por Teams activos (revisión cada 5 minutos).');
  setInterval(() => {
    revisarAvisosDeVencimiento().catch((err) => console.error('Error revisando avisos de vencimiento:', err.message));
  }, VENTANA_REVISION_MS);
}

module.exports = { revisarAvisosDeVencimiento, iniciarProgramadorDeAvisos, nivelSiguiente };

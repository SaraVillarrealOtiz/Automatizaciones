// Avisos por Microsoft Teams cuando una tarea esta por vencer.
// - Tareas con hora de entrega EXPLICITA (ver src/interpretacion/parsearTiempo.js
//   parsearFechaLimiteConHora): aviso 1 hora antes de esa hora.
// - Tareas SIN hora explicita: parsearFechaLimiteConHora ya guarda su fechaLimite a las
//   5:00pm hora Bogota del dia limite (fin de la jornada laboral), asi que si ese dia es
//   HOY se avisa a esa misma hora — no tiene sentido restar "1 hora antes" de una hora que
//   nadie especifico, pero si avisar antes de que termine el dia en que vence.
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
const MARGEN_AVISO_MS = 5 * 60 * 1000; // ventana de +/-5 min alrededor de la hora de aviso
const UNA_HORA_MS = 60 * 60 * 1000;
const ZONA_HORARIA_BOGOTA = 'America/Bogota';

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

// yyyy-mm-dd en hora local de Bogota (locale "en-CA" da formato ISO), para comparar si dos
// instantes caen en el mismo dia calendario en Bogota sin depender del huso horario del server.
function fechaBogotaYMD(fecha) {
  return fecha.toLocaleDateString('en-CA', { timeZone: ZONA_HORARIA_BOGOTA });
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

// `tipoAviso`: 'una_hora_antes' (hora de entrega explicita, aviso 1h antes) o
// 'fin_de_jornada' (sin hora explicita, tarea vence hoy, aviso a las 5pm Bogota).
//
// NOTA sobre menciones: se probo la mencion real de Teams (@) usando el AAD Object ID del
// responsable en un campo `entities` junto al texto `<at>Nombre</at>` (formato estandar de
// Bot Framework). Confirmado en vivo (2026-07-21) que el webhook de la app "Workflows" NO
// reenvia `entities` a la tarjeta — llega como texto plano `<at>Nombre</at>` sin notificar a
// la persona. Por eso aqui solo se usa un `@Nombre` en texto plano; una mencion real
// requeriria modificar el flujo de Power Automate o un Bot de Teams (Bot Framework),
// igual que los botones interactivos, ambos aplazados como fase futura.
async function construirTarjeta(tarea, cliente, responsablesPorId, { tipoAviso } = {}) {
  const nivelSig = nivelSiguiente(tarea.nivelActual);
  const idsNivelSig = nivelSig ? cliente[CAMPO_IDS_POR_NIVEL[nivelSig]] || [] : [];
  const nombresNivelSig = await nombresDePersonas(idsNivelSig, responsablesPorId);

  const lineaEscalamiento = nivelSig && nombresNivelSig.length
    ? `🪜 Si no se completa a tiempo, escala a **${nivelSig}**: ${nombresNivelSig.join(', ')}`
    : '🪜 Este es el nivel más alto de escalamiento para este cliente.';

  const responsableNombre = responsablesPorId.get(tarea.responsableId)?.nombre || tarea.responsableEmail;

  const titulo = tipoAviso === 'fin_de_jornada'
    ? '⏰ Recordatorio: la tarea vence hoy (fin de la jornada laboral)'
    : '⏰ Recordatorio de tarea próxima a vencer';

  const lineaResponsable = `👤 Responsable (${tarea.nivelActual}): @${responsableNombre}`;

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
            { type: 'TextBlock', text: titulo, weight: 'Bolder', size: 'Medium', color: 'Attention' },
            { type: 'TextBlock', text: `📋 ${tarea.tarea}`, wrap: true, weight: 'Bolder' },
            { type: 'TextBlock', text: `🏢 Cliente: ${cliente.nombre}`, wrap: true },
            { type: 'TextBlock', text: lineaResponsable, wrap: true },
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

// Revisa las tareas activas y envia el aviso a Teams a las que les corresponda segun su
// tipo (ver comentario del encabezado), sin repetir el mismo aviso (`avisoEnviado`).
async function revisarAvisosDeVencimiento() {
  if (!process.env.TEAMS_WEBHOOK_URL) return;

  const db = getDb();
  const ahora = Date.now();
  const hoyBogota = fechaBogotaYMD(new Date(ahora));

  const [snapTareas, responsables] = await Promise.all([
    db.collection('tareas').where('estado', '==', 'creada').get(),
    listarResponsables(),
  ]);
  const responsablesPorId = new Map(responsables.map((r) => [r.id, r]));
  const responsablesPorEmail = new Map(responsables.map((r) => [r.email, r]));

  for (const doc of snapTareas.docs) {
    const tarea = doc.data();
    if (tarea.avisoEnviado || !tarea.clienteId) continue;

    const vence = new Date(tarea.fechaLimite).getTime();
    let tipoAviso = null;

    if (tarea.horaLimiteExplicita) {
      const faltan = vence - ahora;
      if (faltan >= UNA_HORA_MS - MARGEN_AVISO_MS && faltan <= UNA_HORA_MS + MARGEN_AVISO_MS) {
        tipoAviso = 'una_hora_antes';
      }
    } else if (fechaBogotaYMD(new Date(vence)) === hoyBogota && Math.abs(vence - ahora) <= MARGEN_AVISO_MS) {
      // Sin hora explicita: fechaLimite ya quedo a las 5pm Bogota del dia limite (ver
      // parsearFechaLimiteConHora). Si ese dia es hoy, se avisa a esa misma hora.
      tipoAviso = 'fin_de_jornada';
    }

    if (!tipoAviso) continue;

    const clienteSnap = await db.collection('clientes').doc(tarea.clienteId).get();
    if (!clienteSnap.exists) continue;
    const cliente = clienteSnap.data();

    const responsableActual = responsablesPorEmail.get(tarea.responsableEmail);
    const tareaConId = { ...tarea, responsableId: responsableActual?.id };

    try {
      const tarjeta = await construirTarjeta(tareaConId, cliente, responsablesPorId, { tipoAviso });
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

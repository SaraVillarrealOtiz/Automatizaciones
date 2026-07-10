// Import Express.js
const express = require('express');

const { enviarMensajeTexto, descargarMedia } = require('./src/whatsapp/client');
const { transcribirAudio } = require('./src/openai/transcribirAudio');
const { extraerCampos } = require('./src/openai/extraerCampos');
const { combinarBorradorCrudo, validarBorrador } = require('./src/validacion/validarBorrador');
const { obtenerConversacion, guardarConversacion, agregarAlHistorial, reiniciarConversacion } = require('./src/conversacion/estado');
const { listarResponsables } = require('./src/firestore/responsables');
const { listarClientes } = require('./src/firestore/clientes');
const { crearTareaPlanner } = require('./src/planner/crearTarea');
const { crearTarea, registrarEvento } = require('./src/firestore/tareas');
const { registerReportesRoute } = require('./src/reportes/reporteTareas');

// Create an Express app
const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

// Set port and verify_token
const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;

// Route for GET requests
app.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('WEBHOOK VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

function formatearFechaBogota(fecha) {
  return fecha.toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: '2-digit', year: 'numeric' });
}

function mensajeConfirmacion(resuelto) {
  return `✅ *Tarea asignada correctamente*

📋 ${resuelto.tarea}
👤 Responsable: ${resuelto.responsable.nombre}
🏢 Cliente: ${resuelto.cliente.nombre}
📅 Vence: ${formatearFechaBogota(resuelto.fechaLimite)}`;
}

function extraerMensajeEntrante(body) {
  try {
    return body.entry[0].changes[0].value.messages[0];
  } catch {
    return null;
  }
}

// Nombre de perfil de WhatsApp del remitente, tal como lo entrega Meta junto al mensaje.
// Es el nombre que la persona configuró en su WhatsApp: no es una identidad verificada,
// solo referencia informativa para saber quién solicitó la tarea.
function extraerNombreContacto(body) {
  try {
    return body.entry[0].changes[0].value.contacts[0].profile.name || null;
  } catch {
    return null;
  }
}

async function procesarMensajeEntrante(mensaje, nombreSolicitante) {
  const telefono = mensaje.from;
  const conversacion = await obtenerConversacion(telefono);
  if (nombreSolicitante && conversacion.nombreSolicitante !== nombreSolicitante) {
    conversacion.nombreSolicitante = nombreSolicitante;
  }

  // Adjuntos (imagen/documento): por ahora no se almacenan (Firebase Storage aún no está
  // habilitado). Se informa al usuario y la tarea continúa su flujo normal sin el archivo.
  if (mensaje.type === 'image' || mensaje.type === 'document') {
    await enviarMensajeTexto(
      telefono,
      '📎 Por ahora no puedo guardar archivos adjuntos. Continúa describiendo la tarea por texto o audio y la creo sin el adjunto.'
    );
    return;
  }

  let texto;
  if (mensaje.type === 'text') {
    texto = mensaje.text.body;
  } else if (mensaje.type === 'audio') {
    const { buffer, mimeType } = await descargarMedia(mensaje.audio.id);
    const extension = mimeType && mimeType.includes('mpeg') ? 'mp3' : 'ogg';
    texto = await transcribirAudio(buffer, extension);
  } else {
    await enviarMensajeTexto(telefono, 'Por ahora solo puedo procesar mensajes de texto, audio, imagen o documento.');
    return;
  }

  const camposExtraidos = await extraerCampos(texto, conversacion.borrador, conversacion.campoPendiente);
  const borradorCombinado = combinarBorradorCrudo(conversacion.borrador, camposExtraidos);
  borradorCombinado.adjuntos = conversacion.borrador.adjuntos || [];

  const [responsables, clientes] = await Promise.all([listarResponsables(), listarClientes()]);
  const resultado = validarBorrador(borradorCombinado, { responsables, clientes });

  let conversacionActualizada = agregarAlHistorial({ ...conversacion, borrador: borradorCombinado }, 'usuario', texto);

  if (!resultado.valido) {
    conversacionActualizada.estado = 'recolectando';
    conversacionActualizada.campoPendiente = resultado.campoPendiente;
    await guardarConversacion(telefono, conversacionActualizada);
    await enviarMensajeTexto(telefono, resultado.mensaje);
    return;
  }

  const { resuelto } = resultado;

  let resultadoPlanner;
  let tareaId;
  try {
    resultadoPlanner = await crearTareaPlanner({ resuelto });
  } catch (err) {
    resultadoPlanner = { exito: false, motivo: 'error_planner', detalle: err.message };
  }

  const estadoTarea = resultadoPlanner.exito ? 'creada' : resultadoPlanner.motivo;

  tareaId = await crearTarea({
    telefonoSolicitante: telefono,
    nombreSolicitante: conversacionActualizada.nombreSolicitante || nombreSolicitante || null,
    tarea: resuelto.tarea,
    responsableEmail: resuelto.responsable.email,
    clienteId: resuelto.cliente.id,
    cliente: resuelto.cliente.nombre,
    nivelActual: resuelto.nivelActual,
    fechaLimite: resuelto.fechaLimite.toISOString(),
    tiempoEstimado: resuelto.tiempoEstimadoMinutos,
    urgencia: resuelto.urgencia,
    descripcion: resuelto.descripcion,
    adjuntos: (resuelto.adjuntos || []).map((a) => a.url),
    plannerPlanId: resultadoPlanner.plannerPlanId || null,
    plannerBucketId: resultadoPlanner.plannerBucketId || null,
    plannerTaskId: resultadoPlanner.plannerTaskId || null,
    estado: estadoTarea,
  });

  await registrarEvento(tareaId, resultadoPlanner.exito ? 'planner_creado' : 'planner_error', resultadoPlanner);

  if (resultadoPlanner.exito) {
    await reiniciarConversacion(telefono);
    await enviarMensajeTexto(telefono, mensajeConfirmacion(resuelto));
  } else {
    conversacionActualizada.estado = 'error';
    await guardarConversacion(telefono, conversacionActualizada);

    await enviarMensajeTexto(
      telefono,
      '⚠️ Hubo un problema técnico creando la tarea en Planner. Se registró internamente y el equipo lo revisará. Puedes intentar reenviar el mensaje en unos minutos.'
    );
  }
}

// Route for POST requests
app.post('/', (req, res) => {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`\n\nWebhook received ${timestamp}\n`);
  console.log(JSON.stringify(req.body, null, 2));

  // Responder 200 de inmediato (requisito de Meta); el procesamiento sigue en segundo plano.
  res.status(200).end();

  const mensaje = extraerMensajeEntrante(req.body);
  if (!mensaje) return; // notificaciones de estado u otros payloads sin mensaje de usuario

  const nombreSolicitante = extraerNombreContacto(req.body);

  procesarMensajeEntrante(mensaje, nombreSolicitante).catch((err) => {
    console.error('Error procesando mensaje entrante:', err);
  });
});

registerReportesRoute(app);

// Start the server
app.listen(port, () => {
  console.log(`\nListening on port ${port}\n`);
});

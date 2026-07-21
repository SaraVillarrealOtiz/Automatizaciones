// Import Express.js
const express = require('express');

const { enviarMensajeTexto, descargarMedia } = require('./src/whatsapp/client');
const { transcribirAudio } = require('./src/openai/transcribirAudio');
const { extraerCampos } = require('./src/openai/extraerCampos');
const { combinarBorradorCrudo, validarBorrador } = require('./src/validacion/validarBorrador');
const { verificarConflictoHorario } = require('./src/validacion/verificarConflictoHorario');
const { obtenerConversacion, guardarConversacion, agregarAlHistorial, reiniciarConversacion } = require('./src/conversacion/estado');
const { mencionaNuevaTarea, esRespuestaAfirmativa } = require('./src/interpretacion/normalizarTexto');
const { listarResponsables } = require('./src/firestore/responsables');
const { listarClientes } = require('./src/firestore/clientes');
const { crearTareaPlanner } = require('./src/planner/crearTarea');
const { crearTarea, registrarEvento } = require('./src/firestore/tareas');
const { registerReportesRoute } = require('./src/reportes/reporteTareas');
const { iniciarProgramadorDeAvisos } = require('./src/teams/avisosVencimiento');

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

function mensajeBienvenida() {
  return `👋 ¡Hola! Soy *ContaLigal*, tu asistente para asignar tareas del equipo.

Para crear una tarea necesito estos datos mínimos:

📝 Tarea (qué hay que hacer)
👤 Responsable (nombre de la persona)
🏢 Cliente
📅 Fecha límite
🚦 Urgencia (Alta, Media o Baja)
📌 Descripción

Puedes escribirlo todo en un solo mensaje o ir respondiendo mis preguntas paso a paso. (El tiempo estimado es opcional.)`;
}

function hayBorradorEnCurso(borrador) {
  return Object.keys(borrador || {}).some((campo) => campo !== 'adjuntos' && borrador[campo]);
}

function mensajeConfirmacion(resuelto) {
  return `✅ *Tarea asignada correctamente*

📋 ${resuelto.tarea}
👤 Responsable: ${resuelto.responsable.nombre}
🏢 Cliente: ${resuelto.cliente.nombre}
📅 Vence: ${formatearFechaBogota(resuelto.fechaLimite)}
🚦 Urgencia: ${resuelto.urgencia}`;
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

  // Si al usuario se le acaba de preguntar si de verdad quiere empezar una tarea nueva
  // (ver mas abajo), esta respuesta decide si se reinicia el borrador o se sigue con el
  // que ya tenia en curso. No pasa por la IA: es una confirmacion puntual, deterministica.
  if (conversacion.estado === 'confirmando_reinicio') {
    if (esRespuestaAfirmativa(texto)) {
      conversacion.borrador = {};
      conversacion.campoPendiente = null;
      conversacion.estado = 'recolectando';
      // No se retorna: el mismo mensaje de confirmacion (o lo que traiga ademas del "si")
      // sigue el flujo normal de extraccion, ahora contra un borrador vacio.
    } else {
      const conversacionCancelada = agregarAlHistorial(
        { ...conversacion, estado: 'recolectando' },
        'usuario',
        texto
      );
      await guardarConversacion(telefono, conversacionCancelada);
      await enviarMensajeTexto(telefono, 'Entendido, seguimos con la tarea que tenías en curso. 👍');
      return;
    }
  } else if (mencionaNuevaTarea(texto) && hayBorradorEnCurso(conversacion.borrador)) {
    // El usuario ya tiene datos de una tarea distinta en progreso: se confirma antes de
    // reiniciar, para no perder ese avance por accidente.
    const conversacionPendiente = agregarAlHistorial(
      { ...conversacion, estado: 'confirmando_reinicio' },
      'usuario',
      texto
    );
    await guardarConversacion(telefono, conversacionPendiente);
    await enviarMensajeTexto(
      telefono,
      '¿Confirmas que quieres iniciar la asignación de una *tarea nueva* (con un responsable y/o cliente diferente)? Esto reiniciará los datos que tenías en curso. Responde "sí" para continuar.'
    );
    return;
  }

  const camposExtraidos = await extraerCampos(texto, conversacion.borrador, conversacion.campoPendiente);

  // Saludo puro (no trae ningun dato de tarea): se presenta ContaLigal y se listan los
  // campos minimos, sea el primer mensaje de la conversacion o haya historial previo.
  // Si el mensaje ya trae datos de la tarea, se omite el saludo y se sigue directo con
  // la validacion de lo que falte.
  const noExtrajoNingunCampo = Object.values(camposExtraidos).every((v) => !v);
  if (noExtrajoNingunCampo) {
    const conversacionSaludo = agregarAlHistorial(
      { ...conversacion, estado: 'recolectando', campoPendiente: null },
      'usuario',
      texto
    );
    await guardarConversacion(telefono, conversacionSaludo);
    await enviarMensajeTexto(telefono, mensajeBienvenida());
    return;
  }

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

  // Si el usuario dio una hora especifica de entrega (no la hora por defecto), se revisa
  // si ese mismo responsable ya tiene otra tarea activa (sin completar en Planner) para
  // exactamente esa misma fecha y hora, sin importar el cliente (la persona solo tiene
  // una agenda). Si hay choque, no se crea la tarea: se le pide al usuario una hora distinta.
  const conflicto = await verificarConflictoHorario({ resuelto });
  if (conflicto.conflicto) {
    conversacionActualizada.estado = 'recolectando';
    conversacionActualizada.campoPendiente = 'fechaLimite';
    delete conversacionActualizada.borrador.fechaLimite;
    await guardarConversacion(telefono, conversacionActualizada);
    await enviarMensajeTexto(
      telefono,
      `⚠️ Este responsable ya tiene una tarea asignada para esa misma hora límite de entrega, es probable que no alcance a cumplir ambas. Te sugiero asignar una nueva hora para esta tarea. 📅 ¿Cuál sería la nueva fecha/hora límite?`
    );
    return;
  }

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
    horaLimiteExplicita: resuelto.horaLimiteExplicita,
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
  iniciarProgramadorDeAvisos();
});

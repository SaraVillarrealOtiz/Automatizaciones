const { resolverEntidad, resolverUrgencia } = require('../interpretacion/normalizarTexto');
const { parsearFechaLimiteConHora, parsearTiempoEstimadoMinutos } = require('../interpretacion/parsearTiempo');

// "tiempoEstimado" es opcional: si se menciona claramente se guarda para reportes,
// pero no bloquea la creacion de la tarea (no se usa para crearla en Planner).
const CAMPOS_OBLIGATORIOS_CRUDOS = ['tarea', 'responsable', 'cliente', 'fechaLimite', 'urgencia', 'descripcion'];

// Orden de la cadena de escalamiento: si "responsable" no contesta/avanza, escala al siguiente.
// "Coordinador" en el Excel de origen equivale a este nivel "Supervisor" (mismo rol,
// nombre distinto en la fuente). Cada nivel puede tener MAS DE UNA persona valida
// (ej. "Coordinador: Jose Bueno, Luisa"): se guarda como arreglo de ids, y cualquiera
// de las personas listadas es valida para ese nivel en ese cliente.
const NIVELES_ESCALAMIENTO = ['Auxiliar', 'Analista', 'Supervisor'];
const CAMPO_IDS_POR_NIVEL = { Auxiliar: 'auxiliarIds', Analista: 'analistaIds', Supervisor: 'supervisorIds' };

const PREGUNTAS = {
  tarea: '¿Cuál es el nombre/título de la tarea? 📝',
  responsable: '¿A quién se le asigna la tarea (nombre de la persona)? 👤',
  cliente: '¿Para qué cliente es esta tarea? 🏢',
  fechaLimite: '¿Cuál es la fecha límite? 📅',
  tiempoEstimado: '¿Cuánto tiempo estimado tomará la tarea? ⏱️',
  urgencia: '¿Cuál es la urgencia: Urgente, Importante, Media o Baja? 🚦',
  descripcion: '¿Puedes dar una breve descripción de la tarea? 📌',
};

/**
 * Determina en que nivel de la cadena de escalamiento del cliente (Auxiliar/Analista/
 * Supervisor) esta la persona dada. Solo mira los 3 roles configurados para ESE cliente
 * en particular (una misma persona puede tener roles distintos segun el cliente).
 * Devuelve null si la persona no esta en ninguno de los 3 roles de ese cliente.
 */
function resolverNivelEnCliente(personaId, clienteResuelto) {
  for (const nivel of NIVELES_ESCALAMIENTO) {
    const ids = clienteResuelto[CAMPO_IDS_POR_NIVEL[nivel]] || [];
    if (ids.includes(personaId)) {
      return nivel;
    }
  }
  return null;
}

/**
 * Combina el borrador previo (texto crudo por campo) con los campos recien extraidos.
 * Solo sobreescribe un campo si el nuevo valor no es null (nunca se borra un campo ya conocido).
 */
function combinarBorradorCrudo(previoCrudo = {}, nuevoCrudo = {}) {
  const combinado = { ...previoCrudo };
  for (const campo of Object.keys(nuevoCrudo)) {
    if (nuevoCrudo[campo] !== null && nuevoCrudo[campo] !== undefined && nuevoCrudo[campo] !== '') {
      combinado[campo] = nuevoCrudo[campo];
    }
  }
  return combinado;
}

/**
 * Valida y resuelve un borrador crudo (texto tal como lo extrajo OpenAI) contra las
 * listas reales de responsables/clientes de Firestore. Es puramente deterministico:
 * no usa IA ni adivina valores. Devuelve el primer problema encontrado, en el orden
 * fijo de CAMPOS_OBLIGATORIOS_CRUDOS, para pedirlo puntualmente por WhatsApp.
 */
function validarBorrador(borradorCrudo, { responsables = [], clientes = [] } = {}) {
  for (const campo of CAMPOS_OBLIGATORIOS_CRUDOS) {
    if (!borradorCrudo[campo]) {
      return { valido: false, campoPendiente: campo, mensaje: PREGUNTAS[campo] };
    }
  }

  const clienteResuelto = resolverEntidad(borradorCrudo.cliente, clientes);
  if (!clienteResuelto) {
    return {
      valido: false,
      campoPendiente: 'cliente',
      mensaje: `No reconozco "${borradorCrudo.cliente}" como cliente registrado. ${PREGUNTAS.cliente}`,
    };
  }

  const responsableResuelto = resolverEntidad(borradorCrudo.responsable, responsables);
  if (!responsableResuelto) {
    return {
      valido: false,
      campoPendiente: 'responsable',
      mensaje: `No reconozco "${borradorCrudo.responsable}" como persona registrada. ${PREGUNTAS.responsable}`,
    };
  }

  const nivelActual = resolverNivelEnCliente(responsableResuelto.id, clienteResuelto);
  if (!nivelActual) {
    return {
      valido: false,
      campoPendiente: 'responsable',
      mensaje: `"${responsableResuelto.nombre}" no forma parte de la cadena de escalamiento (Auxiliar/Analista/Supervisor) configurada para "${clienteResuelto.nombre}". ${PREGUNTAS.responsable}`,
    };
  }

  if (!responsableResuelto.activo || !responsableResuelto.email) {
    return {
      valido: false,
      campoPendiente: 'responsable',
      mensaje: `"${responsableResuelto.nombre}" está registrado pero su correo/acceso aún no está configurado; avisa al administrador. Mientras tanto, ${PREGUNTAS.responsable.toLowerCase()}`,
    };
  }

  if (!clienteResuelto.plannerPlanId || !clienteResuelto.bucketInicioId || !clienteResuelto.plannerGroupId) {
    return {
      valido: false,
      campoPendiente: 'cliente',
      mensaje: `"${clienteResuelto.nombre}" aún no tiene su Plan de Planner configurado. Avisa al administrador antes de crear tareas para este cliente.`,
    };
  }

  const fechaLimiteParseada = parsearFechaLimiteConHora(borradorCrudo.fechaLimite);
  if (!fechaLimiteParseada) {
    return {
      valido: false,
      campoPendiente: 'fechaLimite',
      mensaje: `No logré entender la fecha "${borradorCrudo.fechaLimite}". ${PREGUNTAS.fechaLimite} (ej: mañana, viernes, 20 de julio)`,
    };
  }
  const { fecha: fechaLimite, horaExplicita: horaLimiteExplicita } = fechaLimiteParseada;
  if (fechaLimite.getTime() < Date.now()) {
    return {
      valido: false,
      campoPendiente: 'fechaLimite',
      mensaje: `La fecha "${borradorCrudo.fechaLimite}" ya pasó. ${PREGUNTAS.fechaLimite}`,
    };
  }

  // Opcional: si no se menciono, se crea la tarea igual sin ese dato. Si SI se
  // menciono algo pero no se logra interpretar como duracion, se pregunta puntualmente
  // (no se descarta en silencio un dato que el usuario si quiso dar).
  let tiempoEstimadoMinutos = null;
  if (borradorCrudo.tiempoEstimado) {
    tiempoEstimadoMinutos = parsearTiempoEstimadoMinutos(borradorCrudo.tiempoEstimado);
    if (!tiempoEstimadoMinutos) {
      return {
        valido: false,
        campoPendiente: 'tiempoEstimado',
        mensaje: `No logré entender el tiempo estimado "${borradorCrudo.tiempoEstimado}". ${PREGUNTAS.tiempoEstimado} (ej: 2 horas, 30 minutos)`,
      };
    }
  }

  const urgencia = resolverUrgencia(borradorCrudo.urgencia);
  if (!urgencia) {
    return {
      valido: false,
      campoPendiente: 'urgencia',
      mensaje: `"${borradorCrudo.urgencia}" no es Urgente, Importante, Media ni Baja. ${PREGUNTAS.urgencia}`,
    };
  }

  return {
    valido: true,
    campoPendiente: null,
    mensaje: null,
    resuelto: {
      tarea: borradorCrudo.tarea,
      descripcion: borradorCrudo.descripcion,
      responsable: responsableResuelto,
      cliente: clienteResuelto,
      nivelActual,
      fechaLimite,
      horaLimiteExplicita,
      tiempoEstimadoMinutos,
      urgencia,
      adjuntos: borradorCrudo.adjuntos || [],
    },
  };
}

module.exports = { combinarBorradorCrudo, validarBorrador, CAMPOS_OBLIGATORIOS_CRUDOS, NIVELES_ESCALAMIENTO, CAMPO_IDS_POR_NIVEL, resolverNivelEnCliente };

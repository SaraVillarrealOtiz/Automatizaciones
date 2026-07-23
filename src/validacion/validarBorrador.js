const { resolverEntidad, resolverUrgencia, partirNombres } = require('../interpretacion/normalizarTexto');
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
  responsable: '¿A quién se le asigna la tarea (nombre de la persona; si son varias, sepáralas con "y")? 👤',
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
 * no usa IA ni adivina valores.
 *
 * El "responsable" puede traer una o mas personas (separadas por "y"/","/"&"/"+", ver
 * partirNombres) — se resuelve cada una por separado y todas quedan asignadas a la tarea.
 *
 * A diferencia de una version anterior, cada campo YA presente se valida de inmediato
 * (no se espera a que el usuario complete todos los campos obligatorios): si escribe un
 * responsable o cliente que no existe, se le avisa en el momento, no al final.
 */
function validarBorrador(borradorCrudo, { responsables = [], clientes = [] } = {}) {
  // 1) Validacion inmediata de cada campo que YA esta presente, en el orden fijo de la
  //    plantilla. No espera a que los demas campos obligatorios tambien esten presentes.
  if (borradorCrudo.responsable) {
    for (const nombreCrudo of partirNombres(borradorCrudo.responsable)) {
      if (!resolverEntidad(nombreCrudo, responsables)) {
        return {
          valido: false,
          campoPendiente: 'responsable',
          mensaje: `No reconozco "${nombreCrudo}" como persona registrada. ${PREGUNTAS.responsable}`,
        };
      }
    }
  }

  if (borradorCrudo.cliente && !resolverEntidad(borradorCrudo.cliente, clientes)) {
    return {
      valido: false,
      campoPendiente: 'cliente',
      mensaje: `No reconozco "${borradorCrudo.cliente}" como cliente registrado. ${PREGUNTAS.cliente}`,
    };
  }

  if (borradorCrudo.fechaLimite) {
    const fechaLimiteParseada = parsearFechaLimiteConHora(borradorCrudo.fechaLimite);
    if (!fechaLimiteParseada) {
      return {
        valido: false,
        campoPendiente: 'fechaLimite',
        mensaje: `No logré entender la fecha "${borradorCrudo.fechaLimite}". ${PREGUNTAS.fechaLimite} (ej: mañana, viernes, 20 de julio)`,
      };
    }
    if (fechaLimiteParseada.fecha.getTime() < Date.now()) {
      return {
        valido: false,
        campoPendiente: 'fechaLimite',
        mensaje: `La fecha "${borradorCrudo.fechaLimite}" ya pasó. ${PREGUNTAS.fechaLimite}`,
      };
    }
  }

  // Opcional: si no se menciono, se crea la tarea igual sin ese dato. Si SI se
  // menciono algo pero no se logra interpretar como duracion, se pregunta puntualmente
  // (no se descarta en silencio un dato que el usuario si quiso dar).
  if (borradorCrudo.tiempoEstimado && !parsearTiempoEstimadoMinutos(borradorCrudo.tiempoEstimado)) {
    return {
      valido: false,
      campoPendiente: 'tiempoEstimado',
      mensaje: `No logré entender el tiempo estimado "${borradorCrudo.tiempoEstimado}". ${PREGUNTAS.tiempoEstimado} (ej: 2 horas, 30 minutos)`,
    };
  }

  if (borradorCrudo.urgencia && !resolverUrgencia(borradorCrudo.urgencia)) {
    return {
      valido: false,
      campoPendiente: 'urgencia',
      mensaje: `"${borradorCrudo.urgencia}" no es Urgente, Importante, Media ni Baja. ${PREGUNTAS.urgencia}`,
    };
  }

  // 2) Todo lo presente es valido: si aun falta algun campo obligatorio, se pregunta por
  //    el primero que falte, en el orden fijo de la plantilla.
  for (const campo of CAMPOS_OBLIGATORIOS_CRUDOS) {
    if (!borradorCrudo[campo]) {
      return { valido: false, campoPendiente: campo, mensaje: PREGUNTAS[campo] };
    }
  }

  // 3) Todos los campos obligatorios estan presentes y son individualmente validos:
  //    resolucion final + chequeos que cruzan varios campos (rol de cada responsable en
  //    la cadena de ESTE cliente en particular, completitud del Plan del cliente, etc.)
  const clienteResuelto = resolverEntidad(borradorCrudo.cliente, clientes);

  const responsablesResueltos = [];
  for (const nombreCrudo of partirNombres(borradorCrudo.responsable)) {
    const responsableResuelto = resolverEntidad(nombreCrudo, responsables);
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
    responsablesResueltos.push({ ...responsableResuelto, nivelActual });
  }

  if (!clienteResuelto.plannerPlanId || !clienteResuelto.bucketInicioId || !clienteResuelto.plannerGroupId) {
    return {
      valido: false,
      campoPendiente: 'cliente',
      mensaje: `"${clienteResuelto.nombre}" aún no tiene su Plan de Planner configurado. Avisa al administrador antes de crear tareas para este cliente.`,
    };
  }

  const { fecha: fechaLimite, horaExplicita: horaLimiteExplicita } = parsearFechaLimiteConHora(borradorCrudo.fechaLimite);

  const tiempoEstimadoMinutos = borradorCrudo.tiempoEstimado
    ? parsearTiempoEstimadoMinutos(borradorCrudo.tiempoEstimado)
    : null;

  const urgencia = resolverUrgencia(borradorCrudo.urgencia);

  return {
    valido: true,
    campoPendiente: null,
    mensaje: null,
    resuelto: {
      tarea: borradorCrudo.tarea,
      descripcion: borradorCrudo.descripcion,
      responsables: responsablesResueltos,
      cliente: clienteResuelto,
      fechaLimite,
      horaLimiteExplicita,
      tiempoEstimadoMinutos,
      urgencia,
      adjuntos: borradorCrudo.adjuntos || [],
    },
  };
}

module.exports = { combinarBorradorCrudo, validarBorrador, CAMPOS_OBLIGATORIOS_CRUDOS, NIVELES_ESCALAMIENTO, CAMPO_IDS_POR_NIVEL, resolverNivelEnCliente };

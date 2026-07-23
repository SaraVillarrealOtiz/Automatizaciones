function limpiar(texto) {
  return (texto || '')
    .toString()
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ''); // quita tildes (marcas diacriticas combinantes)
}

/**
 * Busca en una lista de entidades ({ id, nombre, alias: string[] }) la que
 * coincide exactamente (o por alias) con el texto dado. No hace matching difuso:
 * si no hay coincidencia exacta contra nombre/alias, devuelve null en vez de adivinar.
 */
function resolverEntidad(textoCrudo, listaEntidades) {
  if (!textoCrudo) return null;
  const objetivo = limpiar(textoCrudo);

  for (const entidad of listaEntidades) {
    const candidatos = [entidad.nombre, ...(entidad.alias || [])].map(limpiar);
    if (candidatos.includes(objetivo)) {
      return entidad;
    }
  }

  return null;
}

// Los 4 niveles coinciden exactamente con la prioridad nativa de Planner
// (Urgent/Important/Medium/Low, ver src/planner/crearTarea.js). "Alta" ya no existe
// como nivel propio: quien diga "urgente" queda en Urgente, quien diga "importante"
// queda en Importante (antes "importante" era sinonimo de Media, ahora es su propio
// nivel, igual que en Planner).
const ALIAS_URGENCIA = {
  urgente: ['urgente', 'urgencia alta', 'critico', 'critica', 'ya', 'inmediato', 'alta'],
  importante: ['importante', 'prioritario', 'prioritaria'],
  media: ['media', 'normal', 'moderada', 'intermedia'],
  baja: ['baja', 'sin afan', 'no urgente', 'cuando se pueda', 'poca prioridad'],
};

const ETIQUETA_NIVEL = { urgente: 'Urgente', importante: 'Importante', media: 'Media', baja: 'Baja' };

function resolverUrgencia(textoCrudo) {
  if (!textoCrudo) return null;
  const objetivo = limpiar(textoCrudo);

  for (const [nivel, alias] of Object.entries(ALIAS_URGENCIA)) {
    if (alias.some((a) => limpiar(a) === objetivo)) {
      return ETIQUETA_NIVEL[nivel];
    }
  }

  return null;
}

// Separa el texto crudo de "responsable" en varios nombres cuando el usuario menciona mas
// de una persona (ej. "Natalia y Ruben", "Natalia, Ruben", "Natalia & Ruben"). Solo se
// activa con un separador explicito (coma, "y", "&", "+"); un nombre compuesto normal
// (ej. "Ana Maria") no trae ninguno de esos separadores, asi que queda como un solo
// nombre. No reconoce "e" (variante de "y" antes de palabras que empiezan con "i"/"hi")
// a proposito, para no arriesgar falsos cortes en nombres propios.
function partirNombres(textoCrudo) {
  if (!textoCrudo) return [];
  return textoCrudo
    .split(/\s*(?:,|&|\+|\by\b)\s*/i)
    .map((n) => n.trim())
    .filter(Boolean);
}

// Deteccion determinista (sin IA) de que el usuario quiere empezar a asignar una tarea
// nueva, distinta a la que tiene en curso (posiblemente para otro responsable/cliente).
const PATRON_NUEVA_TAREA = /\b(nueva tarea|otra tarea|agregar (una )?tarea|asignar (una )?(nueva|otra)|otra asignacion)\b/i;

function mencionaNuevaTarea(textoCrudo) {
  return PATRON_NUEVA_TAREA.test(limpiar(textoCrudo));
}

const PATRON_AFIRMATIVO = /^(si|s|dale|confirmo|correcto|claro|ok|listo|de una|eso)\b/i;

function esRespuestaAfirmativa(textoCrudo) {
  return PATRON_AFIRMATIVO.test(limpiar(textoCrudo));
}

module.exports = { limpiar, resolverEntidad, resolverUrgencia, partirNombres, mencionaNuevaTarea, esRespuestaAfirmativa };

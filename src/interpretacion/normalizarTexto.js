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

const ALIAS_URGENCIA = {
  alta: ['alta', 'urgente', 'urgencia alta', 'prioritario', 'critico', 'critica', 'ya', 'inmediato'],
  media: ['media', 'normal', 'moderada', 'intermedia', 'importante'],
  baja: ['baja', 'sin afan', 'no urgente', 'cuando se pueda', 'poca prioridad'],
};

function resolverUrgencia(textoCrudo) {
  if (!textoCrudo) return null;
  const objetivo = limpiar(textoCrudo);

  for (const [nivel, alias] of Object.entries(ALIAS_URGENCIA)) {
    if (alias.some((a) => limpiar(a) === objetivo)) {
      return nivel === 'alta' ? 'Alta' : nivel === 'media' ? 'Media' : 'Baja';
    }
  }

  return null;
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

module.exports = { limpiar, resolverEntidad, resolverUrgencia, mencionaNuevaTarea, esRespuestaAfirmativa };

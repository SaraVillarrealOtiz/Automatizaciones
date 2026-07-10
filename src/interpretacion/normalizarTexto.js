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
  media: ['media', 'normal', 'moderada', 'intermedia'],
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

module.exports = { limpiar, resolverEntidad, resolverUrgencia };

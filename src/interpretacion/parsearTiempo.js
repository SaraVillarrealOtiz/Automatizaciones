const ZONA_HORARIA_OFFSET_MINUTOS = -5 * 60; // America/Bogota, sin horario de verano

const DIAS_SEMANA = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
};

const MESES = {
  enero: 0,
  febrero: 1,
  marzo: 2,
  abril: 3,
  mayo: 4,
  junio: 5,
  julio: 6,
  agosto: 7,
  septiembre: 8,
  setiembre: 8,
  octubre: 9,
  noviembre: 10,
  diciembre: 11,
};

function limpiar(texto) {
  return (texto || '')
    .toString()
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function ahoraEnBogota() {
  const ahoraUtc = new Date();
  return new Date(ahoraUtc.getTime() + (ZONA_HORARIA_OFFSET_MINUTOS - ahoraUtc.getTimezoneOffset()) * 60000);
}

function construirFechaUtcDesdeBogota(anio, mes, dia, hora = 17, minuto = 0) {
  // Interpreta anio/mes/dia/hora/minuto como hora local de Bogota (UTC-5) y devuelve el Date UTC equivalente.
  return new Date(Date.UTC(anio, mes, dia, hora - ZONA_HORARIA_OFFSET_MINUTOS / 60, minuto));
}

/**
 * Calcula los componentes (anio, mes, dia) en hora local de Bogota que representa el
 * texto de fecha limite dado. Devuelve null si no logra interpretarlo con certeza
 * (nunca "adivina" una fecha arbitraria). Uso interno, compartido entre
 * parsearFechaLimite y parsearFechaLimiteConHora.
 */
function calcularComponentesFecha(texto) {
  const base = ahoraEnBogota();

  if (/\bhoy\b/.test(texto)) {
    return { anio: base.getFullYear(), mes: base.getMonth(), dia: base.getDate() };
  }

  if (/\bpasado\s+manana\b/.test(texto)) {
    const d = new Date(base);
    d.setDate(d.getDate() + 2);
    return { anio: d.getFullYear(), mes: d.getMonth(), dia: d.getDate() };
  }

  if (/\bmanana\b/.test(texto)) {
    const d = new Date(base);
    d.setDate(d.getDate() + 1);
    return { anio: d.getFullYear(), mes: d.getMonth(), dia: d.getDate() };
  }

  // "en 3 dias" / "en 2 semanas"
  const enPlazo = texto.match(/\ben\s+(\d+)\s+(dia|dias|semana|semanas)\b/);
  if (enPlazo) {
    const cantidad = parseInt(enPlazo[1], 10);
    const unidad = enPlazo[2].startsWith('semana') ? 7 : 1;
    const d = new Date(base);
    d.setDate(d.getDate() + cantidad * unidad);
    return { anio: d.getFullYear(), mes: d.getMonth(), dia: d.getDate() };
  }

  // dia de la semana: "el viernes", "para el lunes"
  for (const [nombreDia, indiceDia] of Object.entries(DIAS_SEMANA)) {
    if (new RegExp(`\\b${nombreDia}\\b`).test(texto)) {
      const d = new Date(base);
      const diferencia = (indiceDia - d.getDay() + 7) % 7 || 7; // siempre el proximo, nunca hoy mismo
      d.setDate(d.getDate() + diferencia);
      return { anio: d.getFullYear(), mes: d.getMonth(), dia: d.getDate() };
    }
  }

  // "20 de julio" o "20 de julio de 2026"
  const fechaConMes = texto.match(/\b(\d{1,2})\s+de\s+([a-z]+)(?:\s+de\s+(\d{4}))?\b/);
  if (fechaConMes) {
    const dia = parseInt(fechaConMes[1], 10);
    const mes = MESES[fechaConMes[2]];
    if (mes !== undefined) {
      const anio = fechaConMes[3] ? parseInt(fechaConMes[3], 10) : base.getFullYear();
      return { anio, mes, dia };
    }
  }

  // "20/07/2026" o "20/07"
  const fechaNumerica = texto.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (fechaNumerica) {
    const dia = parseInt(fechaNumerica[1], 10);
    const mes = parseInt(fechaNumerica[2], 10) - 1;
    let anio = fechaNumerica[3] ? parseInt(fechaNumerica[3], 10) : base.getFullYear();
    if (anio < 100) anio += 2000;
    if (mes >= 0 && mes <= 11 && dia >= 1 && dia <= 31) {
      return { anio, mes, dia };
    }
  }

  return null;
}

/**
 * Convierte un texto de fecha limite (en espanol, tal como lo dijo el usuario) a un Date UTC.
 * Devuelve null si no logra interpretarlo con certeza (nunca "adivina" una fecha arbitraria).
 * Usa una hora por defecto (5pm Bogota); para detectar una hora explicita ver
 * parsearFechaLimiteConHora.
 */
function parsearFechaLimite(textoCrudo) {
  const texto = limpiar(textoCrudo);
  if (!texto) return null;

  const componentes = calcularComponentesFecha(texto);
  if (!componentes) return null;
  return construirFechaUtcDesdeBogota(componentes.anio, componentes.mes, componentes.dia);
}

// Reconoce una hora especifica mencionada explicitamente por el usuario (ej. "a las 3pm",
// "3:00 pm", "15:00", "a las 9 de la noche", "medio dia"). Devuelve null si no hay
// ninguna hora explicita en el texto (nunca se "adivina" ni se asume una hora).
function parsearHoraExplicita(texto) {
  if (/\bmedio\s*dia\b/.test(texto)) return { hora: 12, minuto: 0 };
  if (/\bmedianoche\b/.test(texto)) return { hora: 0, minuto: 0 };

  let m = texto.match(/\ba las?\s+(\d{1,2})(?::(\d{2}))?\s+de la\s+(manana|tarde|noche)\b/);
  if (m) {
    let hora = parseInt(m[1], 10);
    const minuto = m[2] ? parseInt(m[2], 10) : 0;
    if ((m[3] === 'tarde' || m[3] === 'noche') && hora < 12) hora += 12;
    if (m[3] === 'manana' && hora === 12) hora = 0;
    return { hora, minuto };
  }

  m = texto.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)\b/);
  if (m) {
    let hora = parseInt(m[1], 10);
    const minuto = m[2] ? parseInt(m[2], 10) : 0;
    const esPM = m[3][0] === 'p';
    if (esPM && hora < 12) hora += 12;
    if (!esPM && hora === 12) hora = 0;
    return { hora, minuto };
  }

  m = texto.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) {
    return { hora: parseInt(m[1], 10), minuto: parseInt(m[2], 10) };
  }

  return null;
}

/**
 * Igual que parsearFechaLimite, pero ademas detecta si el usuario menciono una hora
 * especifica de entrega. Devuelve { fecha: Date, horaExplicita: boolean } o null si no
 * logra interpretar la fecha. Si no se menciona hora, "fecha" usa la hora por defecto
 * (5pm Bogota) igual que antes, y horaExplicita queda en false.
 */
function parsearFechaLimiteConHora(textoCrudo) {
  const texto = limpiar(textoCrudo);
  if (!texto) return null;

  const componentes = calcularComponentesFecha(texto);
  if (!componentes) return null;

  const hora = parsearHoraExplicita(texto);
  if (!hora) {
    return { fecha: construirFechaUtcDesdeBogota(componentes.anio, componentes.mes, componentes.dia), horaExplicita: false };
  }

  return {
    fecha: construirFechaUtcDesdeBogota(componentes.anio, componentes.mes, componentes.dia, hora.hora, hora.minuto),
    horaExplicita: true,
  };
}

/**
 * Convierte un texto de tiempo estimado ("2 horas", "medio dia", "30 minutos") a minutos totales.
 * Devuelve null si no logra interpretarlo.
 */
function parsearTiempoEstimadoMinutos(textoCrudo) {
  const texto = limpiar(textoCrudo);
  if (!texto) return null;

  if (/\bmedio\s+dia\b/.test(texto)) return 4 * 60;
  if (/\bun\s+dia\b|\b1\s+dia\b/.test(texto)) return 8 * 60;

  const horas = texto.match(/(\d+(?:[.,]\d+)?)\s*(?:h|hr|hrs|hora|horas)\b/);
  if (horas) return Math.round(parseFloat(horas[1].replace(',', '.')) * 60);

  const minutos = texto.match(/(\d+)\s*(?:min|mins|minuto|minutos)\b/);
  if (minutos) return parseInt(minutos[1], 10);

  const dias = texto.match(/(\d+(?:[.,]\d+)?)\s*(?:d|dia|dias)\b/);
  if (dias) return Math.round(parseFloat(dias[1].replace(',', '.')) * 8 * 60);

  return null;
}

module.exports = { parsearFechaLimite, parsearFechaLimiteConHora, parsearTiempoEstimadoMinutos };

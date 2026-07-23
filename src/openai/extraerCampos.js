const OpenAI = require('openai');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ESQUEMA_CAMPOS = {
  name: 'campos_tarea',
  schema: {
    type: 'object',
    properties: {
      tarea: { type: ['string', 'null'], description: 'Titulo/nombre corto de la tarea (campo 📝 Tarea). Si el usuario no da un titulo explicito pero si describe la tarea, genera aqui un titulo corto (maximo ~8 palabras) que resuma esa descripcion; deja null solo si no hay ni titulo ni descripcion suficiente para resumir.' },
      responsable: { type: ['string', 'null'], description: 'Nombre propio de la PERSONA (o personas) a quien se le asigna directamente la tarea (campo 👤 Responsable). Debe ser un nombre de persona, nunca un cargo (no "el analista", no "el auxiliar"): el sistema determina el cargo/nivel de esa persona automaticamente segun el cliente. Si el usuario menciona mas de una persona (ej. "Natalia y Ruben"), incluye todos los nombres tal como los dijo, unidos igual que en el mensaje original (no elijas solo uno).' },
      cliente: { type: ['string', 'null'], description: 'Cliente al que pertenece la tarea (campo 🏢 Cliente)' },
      fechaLimite: { type: ['string', 'null'], description: 'Fecha limite mencionada, en el texto original tal como la dijo el usuario (campo 📅 Fecha limite). No conviertas formato aqui.' },
      tiempoEstimado: { type: ['string', 'null'], description: 'Duracion estimada de la tarea, texto original (campo ⏱️ Tiempo estimado). Distinto de la fecha limite.' },
      urgencia: { type: ['string', 'null'], description: 'Urgencia mencionada tal cual la dijo el usuario, sin normalizar (campo 🚦 Urgencia)' },
      descripcion: { type: ['string', 'null'], description: 'Descripcion/detalle de la tarea (campo 📌 Descripcion)' },
    },
    required: ['tarea', 'responsable', 'cliente', 'fechaLimite', 'tiempoEstimado', 'urgencia', 'descripcion'],
    additionalProperties: false,
  },
  strict: true,
};

const PROMPT_SISTEMA = `Eres un asistente que extrae campos estructurados de mensajes de WhatsApp de un equipo de trabajo que reporta tareas.

El equipo suele usar esta plantilla con emojis (puede venir completa, parcial, o como texto libre transcrito de audio):

📝 Tarea:
👤 Responsable:
🏢 Cliente:
📅 Fecha límite:
⏱️ Tiempo estimado:
🚦 Urgencia:
📌 Descripción:
📎 Adjuntos:

El campo "Responsable" es el NOMBRE PROPIO de la persona a quien se le asigna la tarea
(ej. "Sofía", "Natalia", "Jose Bueno"), nunca un cargo genérico. El sistema determina
automáticamente si esa persona es Auxiliar, Analista o Supervisor según el cliente.
Puede haber MÁS DE UNA persona responsable (ej. "Natalia y Ruben", "Sofía, Jose"): en ese
caso incluye todos los nombres mencionados, no selecciones solo uno.

Reglas estrictas:
- Extrae SOLO lo que el usuario dijo explícitamente. Si un campo no se menciona (ni con la etiqueta ni de forma implícita clara), devuelve null para ese campo. NUNCA inventes ni infieras un valor razonable "por defecto".
- Excepción puntual para "tarea" (título): si el usuario no da un título corto explícito pero sí describe la tarea con suficiente detalle, SÍ debes generar tú un título corto que resuma esa descripción (no lo dejes null solo porque no vino etiquetado). Ejemplo: si dice "que solicite los extractos bancarios", el título puede ser "Solicitar extractos bancarios". Si no hay ni título ni descripción de la que resumir, ahí sí deja tarea en null.
- Un simple saludo ("hola", "buenas", "buenos días", "qué tal", etc.) SIN ninguna descripción de tarea NO cuenta como título: en ese caso todos los campos, incluido "tarea", deben quedar en null. No conviertas el saludo mismo en el título.
- No confundas "tiempo estimado" (duración, ej. "2 horas", "medio día") con "fecha límite" (una fecha/día concreto, ej. "mañana", "viernes", "20 de julio").
- Si hay un mensaje anterior de esta misma conversación (borrador previo) provisto como contexto, y el usuario ahora solo está respondiendo a un campo puntual que se le pidió, extrae ese campo del nuevo mensaje; no repitas ni alteres los demás campos del borrador (el sistema los combina después).
- Si el contexto indica que el sistema le acaba de preguntar puntualmente por un campo específico (ver "Campo que se le acaba de preguntar al usuario"), y el mensaje nuevo no contiene una etiqueta explícita de otro campo (ej. "Cliente:", "Responsable:"), interpreta el mensaje completo como la respuesta a ESE campo puntual, incluso si el texto por sí solo podría sonar como otro campo (ej. si se preguntó por la descripción y el usuario repite algo parecido al título, va en descripción, no en tarea).
- Devuelve los valores de urgencia y fechas tal como los dijo el usuario, en texto plano, SIN normalizar ni convertir formato: eso lo hace una capa posterior.`;

async function extraerCampos(mensajeTexto, borradorActual = {}, campoPendiente = null) {
  const contexto = Object.keys(borradorActual).length
    ? `Borrador actual de la conversacion (ya validado, no lo repitas salvo que el usuario lo corrija explicitamente):\n${JSON.stringify(borradorActual)}`
    : 'No hay borrador previo en esta conversacion.';

  const contextoPendiente = campoPendiente
    ? `\n\nCampo que se le acaba de preguntar al usuario: "${campoPendiente}"`
    : '';

  const respuesta = await client.chat.completions.create({
    model: 'gpt-4o-2024-08-06',
    messages: [
      { role: 'system', content: PROMPT_SISTEMA },
      { role: 'user', content: `${contexto}${contextoPendiente}\n\nMensaje nuevo del usuario:\n${mensajeTexto}` },
    ],
    response_format: { type: 'json_schema', json_schema: ESQUEMA_CAMPOS },
  });

  return JSON.parse(respuesta.choices[0].message.content);
}

module.exports = { extraerCampos };

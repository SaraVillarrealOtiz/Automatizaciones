const axios = require('axios');

const VERSION_API = 'v20.0';
const BASE_URL = `https://graph.facebook.com/${VERSION_API}`;

function headersAuth() {
  return { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` };
}

async function enviarMensajeTexto(telefonoDestino, texto) {
  const phoneNumberId = process.env.PHONE_NUMBER_ID;

  await axios.post(
    `${BASE_URL}/${phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      to: telefonoDestino,
      type: 'text',
      text: { body: texto },
    },
    { headers: headersAuth() }
  );
}

async function descargarMedia(mediaId) {
  const metaResp = await axios.get(`${BASE_URL}/${mediaId}`, { headers: headersAuth() });
  const { url, mime_type: mimeType } = metaResp.data;

  const archivoResp = await axios.get(url, {
    headers: headersAuth(),
    responseType: 'arraybuffer',
  });

  return { buffer: Buffer.from(archivoResp.data), mimeType };
}

module.exports = { enviarMensajeTexto, descargarMedia };

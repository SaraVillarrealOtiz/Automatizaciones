const crypto = require('crypto');
const { getBucket } = require('../firestore/firebaseAdmin');
const { descargarMedia } = require('../whatsapp/client');

const EXTENSION_POR_MIME = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
};

async function subirAdjuntoDesdeMeta(mediaId, telefono) {
  const { buffer, mimeType } = await descargarMedia(mediaId);
  const extension = EXTENSION_POR_MIME[mimeType] || 'bin';
  const nombreArchivo = `adjuntos/${telefono}/${Date.now()}-${crypto.randomUUID()}.${extension}`;

  const bucket = getBucket();
  const archivo = bucket.file(nombreArchivo);

  await archivo.save(buffer, { contentType: mimeType });
  await archivo.makePublic();

  return {
    url: `https://storage.googleapis.com/${bucket.name}/${nombreArchivo}`,
    mimeType,
    mediaId,
  };
}

module.exports = { subirAdjuntoDesdeMeta };

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const OpenAI = require('openai');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function transcribirAudio(bufferAudio, extension = 'ogg') {
  const tmpPath = path.join(os.tmpdir(), `audio-${crypto.randomUUID()}.${extension}`);
  fs.writeFileSync(tmpPath, bufferAudio);

  try {
    const respuesta = await client.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-1',
      language: 'es',
    });

    return respuesta.text;
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

module.exports = { transcribirAudio };

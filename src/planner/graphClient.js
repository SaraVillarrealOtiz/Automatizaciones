const axios = require('axios');

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

let tokenCache = { valor: null, expiraEn: 0 };

async function obtenerToken() {
  const ahora = Date.now();
  if (tokenCache.valor && ahora < tokenCache.expiraEn - 60000) {
    return tokenCache.valor;
  }

  const { TENANT_ID, CLIENT_ID, CLIENT_SECRET } = process.env;
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Faltan TENANT_ID, CLIENT_ID o CLIENT_SECRET (Azure AD) en las variables de entorno.');
  }

  const url = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const resp = await axios.post(url, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  tokenCache = {
    valor: resp.data.access_token,
    expiraEn: ahora + resp.data.expires_in * 1000,
  };

  return tokenCache.valor;
}

async function graphRequest(metodo, ruta, datos) {
  const token = await obtenerToken();
  const config = {
    method: metodo,
    url: `${GRAPH_BASE_URL}${ruta}`,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: datos,
  };

  if (metodo.toUpperCase() === 'PATCH' && datos && datos.__etag) {
    config.headers['If-Match'] = datos.__etag;
    delete datos.__etag;
  }

  const resp = await axios(config);
  return resp.data;
}

module.exports = { obtenerToken, graphRequest };

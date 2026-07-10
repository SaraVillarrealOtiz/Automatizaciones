const admin = require('firebase-admin');

let app;

function getFirebaseApp() {
  if (app) return app;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error('Falta la variable de entorno FIREBASE_SERVICE_ACCOUNT (JSON del service account de Firebase).');
  }

  const serviceAccount = JSON.parse(raw);

  app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });

  return app;
}

function getDb() {
  getFirebaseApp();
  return admin.firestore();
}

function getBucket() {
  getFirebaseApp();
  return admin.storage().bucket();
}

function getAuth() {
  getFirebaseApp();
  return admin.auth();
}

module.exports = { getFirebaseApp, getDb, getBucket, getAuth };

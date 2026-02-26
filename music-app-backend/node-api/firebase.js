const path = require('path');
const admin = require('firebase-admin');
require('dotenv').config();

function resolveCredential() {
    const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (jsonEnv) {
        return admin.credential.cert(JSON.parse(jsonEnv));
    }

    const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
        ? path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH)
        : path.join(__dirname, 'serviceAccountKey.json');

    // eslint-disable-next-line global-require, import/no-dynamic-require
    const serviceAccount = require(keyPath);
    return admin.credential.cert(serviceAccount);
}

if (!admin.apps.length) {
    const databaseURL = process.env.FIREBASE_DATABASE_URL;
    if (!databaseURL) {
        throw new Error('Missing FIREBASE_DATABASE_URL in environment');
    }

    admin.initializeApp({
        credential: resolveCredential(),
        databaseURL,
    });
}

const db = admin.database();

module.exports = db;

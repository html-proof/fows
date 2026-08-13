import admin from 'firebase-admin';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..', '..');

const databaseURL = process.env.FIREBASE_DATABASE_URL;
if (!databaseURL) {
    throw new Error('FIREBASE_DATABASE_URL environment variable is required');
}
const serviceAccountEnv = process.env.FIREBASE_SERVICE_ACCOUNT;

let serviceAccount = null;

if (serviceAccountEnv) {
    try {
        serviceAccount = JSON.parse(serviceAccountEnv);
        // Some platforms (Render, Railway, Heroku) double-escape newlines in env vars,
        // turning the PEM "-----BEGIN PRIVATE KEY-----\n..." into literal \\n.
        // Fix it before handing the key to the Admin SDK.
        if (serviceAccount?.private_key) {
            serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
        }
        console.log('✅ Firebase service account loaded from FIREBASE_SERVICE_ACCOUNT environment variable.');
    } catch (e) {
        console.error('❌ Failed to parse FIREBASE_SERVICE_ACCOUNT environment variable. Ensure it is valid JSON.');
    }
}

if (!serviceAccount) {
    const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || './serviceAccountKey.json';

    // Try multiple resolution strategies for file-based key
    const candidatePaths = [
        resolve(serviceAccountPath),
        resolve(projectRoot, serviceAccountPath),
    ];

    for (const candidate of candidatePaths) {
        if (existsSync(candidate)) {
            try {
                serviceAccount = JSON.parse(readFileSync(candidate, 'utf8'));
                console.log('✅ Firebase service account loaded from file:', candidate);
                break;
            } catch (e) {
                // continue
            }
        }
    }
}

admin.initializeApp({
    credential: serviceAccount ? admin.credential.cert(serviceAccount) : admin.credential.applicationDefault(),
    databaseURL: databaseURL
});

const db = admin.database();
const firestore = admin.firestore();
const auth = admin.auth();

if (process.env.DEBUG) {
    admin.app().options.credential.getAccessToken()
        .then(() => console.log('✅ Firebase Admin credential verified.'))
        .catch(err => console.error('Firebase Admin warning:', err?.message ?? err));
}

export { admin, db, firestore, auth };
export default admin;

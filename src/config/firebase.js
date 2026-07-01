import admin from 'firebase-admin';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..', '..');

const databaseURL = process.env.FIREBASE_DATABASE_URL || 'https://music-16f5c-default-rtdb.asia-southeast1.firebasedatabase.app';
const serviceAccountEnv = process.env.FIREBASE_SERVICE_ACCOUNT;

let serviceAccount = null;

if (serviceAccountEnv) {
    try {
        serviceAccount = JSON.parse(serviceAccountEnv);
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

if (!serviceAccount) {
    console.warn('⚠️  No Firebase service account found. Set FIREBASE_SERVICE_ACCOUNT env or provide a key file.');
}

admin.initializeApp({
    credential: serviceAccount ? admin.credential.cert(serviceAccount) : admin.credential.applicationDefault(),
    databaseURL: databaseURL
});


const db = admin.database(); // Realtime Database
const firestore = admin.firestore(); // Keep firestore for compatibility or transition if needed
const auth = admin.auth();

export { admin, db, firestore, auth };
export default admin;

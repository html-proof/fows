import admin from 'firebase-admin';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..', '..');

const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || './serviceAccountKey.json';

// Try multiple resolution strategies
const candidatePaths = [
    resolve(serviceAccountPath),                    // absolute or relative to cwd
    resolve(projectRoot, serviceAccountPath),        // relative to project root
];

let serviceAccount = null;
for (const candidate of candidatePaths) {
    if (existsSync(candidate)) {
        try {
            serviceAccount = JSON.parse(readFileSync(candidate, 'utf8'));
            console.log('✅ Firebase service account loaded from:', candidate);
            break;
        } catch (e) {
            // continue to next candidate
        }
    }
}

if (!serviceAccount) {
    console.warn('⚠️  Firebase service account key not found. Tried:', candidatePaths.join(', '));
    console.warn('   Auth middleware and Firestore will not work.');
    console.warn('   Download your service account key from Firebase Console.');
}

if (serviceAccount) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: 'https://music-16f5c-default-rtdb.asia-southeast1.firebasedatabase.app'
    });
} else {
    // Initialize without credentials for graceful degradation
    admin.initializeApp({
        databaseURL: 'https://music-16f5c-default-rtdb.asia-southeast1.firebasedatabase.app'
    });
}

const db = admin.database(); // Realtime Database
const firestore = admin.firestore(); // Keep firestore for compatibility or transition if needed
const auth = admin.auth();

export { admin, db, firestore, auth };
export default admin;

import { auth } from '../config/firebase.js';

/**
 * Authentication middleware that verifies Firebase ID tokens.
 * Extracts the token from the Authorization header (Bearer scheme).
 * On success, attaches user info to req.user.
 */
export const authenticateUser = async (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Missing or invalid Authorization header. Expected: Bearer <idToken>',
        });
    }

    const idToken = authHeader.split('Bearer ')[1];

    try {
        const decodedToken = await auth.verifyIdToken(idToken);
        req.user = {
            uid: decodedToken.uid,
            email: decodedToken.email || null,
            name: decodedToken.name || null,
            picture: decodedToken.picture || null,
        };
        next();
    } catch (error) {
        console.error('Auth verification failed:', error.message);
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Invalid or expired token.',
        });
    }
};

export default authenticateUser;

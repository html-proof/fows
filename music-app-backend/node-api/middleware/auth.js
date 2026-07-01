const { auth } = require('../firebase');

async function authenticateUser(req, res, next) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Missing or invalid Authorization header. Expected: Bearer <idToken>',
        });
    }

    const token = header.slice('Bearer '.length).trim();
    if (!token) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Missing Firebase ID token.',
        });
    }

    try {
        const decoded = await auth.verifyIdToken(token);
        req.user = {
            uid: decoded.uid,
            email: decoded.email || null,
            name: decoded.name || null,
        };
        return next();
    } catch (error) {
        console.error('Auth verification failed:', error.message);
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Invalid or expired token.',
        });
    }
}

module.exports = { authenticateUser };

import 'dotenv/config';
import app from './src/app.js';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🎵 Music Hub API server running on http://localhost:${PORT}`);
});

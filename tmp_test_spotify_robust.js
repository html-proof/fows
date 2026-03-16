import { parseSpotifyEmbedHtml } from './src/services/playlistMatcher.js';
import fs from 'fs';

async function testUrl(url) {
    console.log(`\nTesting URL: ${url}`);
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            },
            redirect: 'follow'
        });

        if (!response.ok) {
            console.log(`Failed with status: ${response.status}`);
            return;
        }

        const html = await response.text();
        const items = parseSpotifyEmbedHtml(html);
        console.log(`Extracted ${items.length} tracks.`);
        if (items.length > 0) {
            console.log(`First track: ${items[0].title} - ${items[0].artist}`);
        } else {
            console.log("No tracks found. Writing HTML to failure.html");
            fs.writeFileSync('failure.html', html);
        }
    } catch (err) {
        console.error(`Error testing ${url}:`, err.message);
    }
}

async function runTests() {
    // A regular playlist
    await testUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM3M');
    // An embed playlist
    await testUrl('https://open.spotify.com/embed/playlist/4q8VQxaTaV80xTacmJ170f');
}

runTests();

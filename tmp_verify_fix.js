import fs from 'fs';
import { parseSpotifyEmbedHtml } from './src/services/playlistMatcher.js';

function test() {
    const html = fs.readFileSync('tmp_spotify_page.html', 'utf8');
    const items = parseSpotifyEmbedHtml(html);
    
    console.log(`Extracted ${items.length} items.`);
    items.forEach((item, i) => {
        console.log(`${i + 1}. ${item.title} - ${item.artist}`);
    });
}

test();

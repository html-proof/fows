import fs from 'fs';

async function test() {
    const url = 'https://open.spotify.com/embed/playlist/4q8VQxaTaV80xTacmJ170f?si=NtOqKEelR0Odrcm_trvtHA';
    console.log(`Fetching ${url}...`);
    
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            },
        });
        
        console.log(`Status: ${res.status}`);
        const html = await res.text();
        fs.writeFileSync('tmp_spotify_page.html', html);
        console.log(`Saved to tmp_spotify_page.html (${html.length} bytes)`);
        
        // Analyze JSON blocks
        const jsonMatches = html.match(/<script[^>]*type="application\/(?:ld\+)?json"[^>]*>(.*?)<\/script>/gs) ?? [];
        const nextDataMatches = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/gs) ?? [];
        
        console.log(`JSON blocks found: ${jsonMatches.length}`);
        console.log(`NEXT_DATA blocks found: ${nextDataMatches.length}`);
        
        // Check for specific markers
        console.log('Includes MusicPlaylist:', html.includes('MusicPlaylist'));
        console.log('Includes MusicRecording:', html.includes('MusicRecording'));
        console.log('Includes ListItem:', html.includes('ListItem'));
        
    } catch (err) {
        console.error('Error:', err);
    }
}

test();

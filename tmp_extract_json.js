import fs from 'fs';

function extract() {
    const html = fs.readFileSync('tmp_spotify_page.html', 'utf8');
    const jsonMatches = html.match(/<script[^>]*type="application\/(?:ld\+)?json"[^>]*>(.*?)<\/script>/gs) ?? [];
    
    console.log(`Found ${jsonMatches.length} JSON-LD blocks.`);
    
    jsonMatches.forEach((match, i) => {
        const content = match.replace(/<\/?script[^>]*>/gs, '');
        console.log(`--- Block ${i} ---`);
        console.log(content.substring(0, 1000));
        fs.writeFileSync(`tmp_spotify_json_${i}.json`, content);
    });

    const nextDataMatches = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/gs) ?? [];
    console.log(`Found ${nextDataMatches.length} NEXT_DATA blocks.`);
    nextDataMatches.forEach((match, i) => {
        const content = match.replace(/<\/?script[^>]*>/gs, '');
        console.log(`--- NEXT_DATA ${i} ---`);
        console.log(content.substring(0, 1000));
        fs.writeFileSync(`tmp_spotify_next_${i}.json`, content);
    });
}

extract();

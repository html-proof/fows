import { request } from 'undici';
import { createDecipheriv } from 'crypto';

// Gaana stream decryption credentials
const KEY = Buffer.from('gy1t#b@jl(b$wtme', 'utf8');
const IV = Buffer.from('xC4dmVJAq14BfntX', 'utf8');
const HLS_BASE_URL = 'https://vodhlsgaana-ebw.akamaized.net/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

function decryptStreamPath(encryptedData) {
    try {
        const offset = parseInt(encryptedData[0], 10);
        if (isNaN(offset)) return '';

        const ciphertextB64 = encryptedData.substring(offset + 16);
        const ciphertext = Buffer.from(ciphertextB64 + '==', 'base64');

        const decipher = createDecipheriv('aes-128-cbc', KEY, IV);
        decipher.setAutoPadding(false);

        let decrypted = decipher.update(ciphertext);
        decrypted = Buffer.concat([decrypted, decipher.final()]);

        let rawText = decrypted.toString('utf8').replace(/\0/g, '').trim();
        rawText = rawText
            .split('')
            .filter((c) => {
                const code = c.charCodeAt(0);
                return code >= 32 && code <= 126;
            })
            .join('');

        if (rawText.includes('/hls/')) {
            const pathStart = rawText.indexOf('hls/');
            const cleanPath = rawText.substring(pathStart);
            return HLS_BASE_URL + cleanPath;
        }
        return '';
    } catch (error) {
        return '';
    }
}

async function fetchFromGaana(url, method = 'GET', body = null) {
    const headers = {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://gaana.com',
        'Referer': 'https://gaana.com/',
        'Host': 'gaana.com',
        'Connection': 'keep-alive'
    };

    if (body) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const { statusCode, body: resBody } = await request(url, {
        method,
        headers,
        body: body ? body.toString() : undefined
    });

    if (statusCode !== 200) {
        throw new Error(`Gaana API returned status code ${statusCode}`);
    }

    return resBody.json();
}

function _normalise(raw, id) {
    if (!raw) return null;
    
    const seokey = raw.seokey ?? id ?? '';
    if (!seokey) return null;

    const trackId = raw.track_id ?? raw.id ?? '';
    const name = raw.track_title ?? raw.title ?? '';
    const albumName = raw.album_title ?? raw.album_name ?? '';
    
    const artistsArr = Array.isArray(raw.artist) ? raw.artist : [];
    const primaryArtists = artistsArr.map(a => a.name).join(', ');
    const artistsObj = {
        primary: artistsArr.map(a => ({ id: a.e_id || null, name: a.name }))
    };

    const image = [
        { quality: '50x50', url: raw.artwork ?? '' },
        { quality: '150x150', url: raw.artwork_web ?? '' },
        { quality: '500x500', url: raw.artwork_large ?? '' }
    ].filter(i => i.url);

    return {
        id: String(seokey),
        provider: 'gaana',
        providerTrackId: String(trackId),
        seokey: String(seokey),
        name,
        title: name,
        primaryArtists,
        artists: artistsObj,
        album: { id: String(raw.album_id ?? ''), name: albumName },
        albumId: String(raw.album_id ?? ''),
        duration: String(raw.duration ?? ''),
        language: raw.language ?? '',
        year: raw.released ? String(raw.released).slice(-4) : '',
        label: '',
        image,
        downloadUrl: []
    };
}

async function _getStream(trackId) {
    if (!trackId) return null;
    try {
        const streamUrlEndpoint = 'https://gaana.com/api/stream-url';
        const streamParams = new URLSearchParams({
            quality: 'high',
            track_id: trackId,
            stream_format: 'mp4'
        });

        const streamResponse = await fetchFromGaana(streamUrlEndpoint, 'POST', streamParams);
        if (streamResponse.api_status === 'success' && streamResponse.data?.stream_path) {
            return decryptStreamPath(streamResponse.data.stream_path);
        }
    } catch (_) {}
    return null;
}

export async function getSongById(id) {
    try {
        console.log(`[gaanaApi] getSongById: ${id}`);
        const songDetailUrl = `https://gaana.com/apiv2?type=songDetail&seokey=${encodeURIComponent(id)}`;
        const songDetails = await fetchFromGaana(songDetailUrl, 'POST');

        if (songDetails.tracks && songDetails.tracks.length > 0) {
            const normalized = _normalise(songDetails.tracks[0], id);
            if (normalized) {
                const streamUrl = await _getStream(normalized.providerTrackId);
                if (streamUrl) {
                    normalized.downloadUrl = [
                        { quality: '320kbps', url: streamUrl },
                        { quality: '160kbps', url: streamUrl },
                        { quality: '96kbps', url: streamUrl }
                    ];
                }
                return { success: true, data: [normalized] };
            }
        }
    } catch (_) {}
    return { success: false, data: [] };
}

export async function searchSongsOnly(query, limit = 20) {
    try {
        console.log(`[gaanaApi] searchSongsOnly: "${query}"`);
        const searchUrl = `https://gaana.com/apiv2?country=IN&page=0&secType=track&type=search&keyword=${encodeURIComponent(query)}`;
        const searchResult = await fetchFromGaana(searchUrl, 'POST');

        const gr = searchResult.gr ?? [];
        if (!gr.length || !gr[0].gd) return [];

        const trackSeokeys = [];
        for (let i = 0; i < Math.min(limit, gr[0].gd.length); i++) {
            const track = gr[0].gd[i];
            if (track.seo) {
                trackSeokeys.push(track.seo);
            }
        }

        if (trackSeokeys.length === 0) return [];

        // Fetch song details in parallel
        const songPromises = trackSeokeys.map(async (seokey) => {
            try {
                const songDetailUrl = `https://gaana.com/apiv2?type=songDetail&seokey=${seokey}`;
                const detailResult = await fetchFromGaana(songDetailUrl, 'POST');
                if (detailResult.tracks && detailResult.tracks.length > 0) {
                    const normalized = _normalise(detailResult.tracks[0], seokey);
                    if (normalized) {
                        const streamUrl = await _getStream(normalized.providerTrackId);
                        if (streamUrl) {
                            normalized.downloadUrl = [
                                { quality: '320kbps', url: streamUrl },
                                { quality: '160kbps', url: streamUrl },
                                { quality: '96kbps', url: streamUrl }
                            ];
                        }
                        return normalized;
                    }
                }
                return null;
            } catch {
                return null;
            }
        });

        const songResults = await Promise.allSettled(songPromises);
        return songResults
            .filter(r => r.status === 'fulfilled' && r.value !== null)
            .map(r => r.value);
    } catch (_) {
        return [];
    }
}

export async function resolveSongStream(song) {
    const trackId = String(song?.providerTrackId ?? song?.track_id ?? song?.id ?? '').trim();
    const streamUrl = await _getStream(trackId);
    if (!streamUrl) return null;
    return { quality: '320kbps', url: streamUrl };
}

export default {
    getSongById,
    searchSongsOnly,
    resolveSongStream,
};

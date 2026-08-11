/**
 * Direct JioSaavn API client — last-resort fallback.
 *
 * Uses jiosaavn.com/api.php directly so the backend works from any region
 * (Singapore, EU, US) without depending on third-party proxy availability.
 *
 * Download URLs from JioSaavn are DES-ECB encrypted and are decrypted here
 * using the well-known community key "38346591".
 *
 * Response shapes are normalised to match the saavn.sumit.co proxy format so
 * the rest of the codebase can treat this as a drop-in fallback.
 */

import crypto from 'crypto';
import { request } from 'undici';

const DIRECT_BASE    = 'https://www.jiosaavn.com/api.php';
const CONNECT_TIMEOUT = 6000;
const BODY_TIMEOUT    = 8000;
const MAX_REQUEST_ATTEMPTS = 2;

// ─── DES decryption ───────────────────────────────────────────────────────────

function _decryptMediaUrl(encrypted) {
    try {
        const desKey = Buffer.from('38346591');
        // OpenSSL 3 (used by current Node releases) no longer exposes single
        // DES.  3DES with the same 8-byte key repeated three times is exactly
        // equivalent to DES-EDE/ECB, which is what JioSaavn uses here.
        const key = Buffer.concat([desKey, desKey, desKey]);
        const decipher = crypto.createDecipheriv('des-ede3-ecb', key, null);
        decipher.setAutoPadding(false);
        const decoded   = Buffer.from((encrypted ?? '').trim(), 'base64');
        const decrypted = Buffer.concat([decipher.update(decoded), decipher.final()]);
        // Extract the first http(s) URL in the decrypted bytes
        const match = decrypted.toString('latin1').match(/https?:\/\/[^\x00-\x1F\x7F\s]+/);
        return match?.[0] ?? null;
    } catch {
        return null;
    }
}

function _buildDownloadUrls(encrypted, has320) {
    const baseUrl = _decryptMediaUrl(encrypted);
    if (!baseUrl) return [];

    // Detect the bitrate token in the URL (e.g. _96, _160, _320, _48, _12)
    // Pattern: _(digits)(optional suffix like _p or _v4).mp4
    const bitrateMatch = baseUrl.match(/_(12|48|96|160|320)(?:_[^./]*)?\.mp4/);
    const detectedBitrate = bitrateMatch ? bitrateMatch[1] : '96';

    const _swap = (kbps) =>
        baseUrl.replace(
            new RegExp(`_${detectedBitrate}((?:_[^./]*)?\\.mp4)$`),
            `_${kbps}$1`,
        );

    const urls = [];
    if (has320) urls.push({ quality: '320kbps', url: _swap('320') });
    urls.push({ quality: '160kbps', url: _swap('160') });
    urls.push({ quality:  '96kbps', url: _swap('96')  });
    urls.push({ quality:  '48kbps', url: _swap('48')  });
    urls.push({ quality:  '12kbps', url: _swap('12')  });
    return urls;
}

// ─── Response normalisation ───────────────────────────────────────────────────

function _normalise(raw) {
    // Search and detail endpoints return the same fields in two different
    // layouts. Search currently puts them at the top level, while some older
    // endpoints nest them under `more_info`.
    const info = { ...(raw ?? {}), ...(raw?.more_info ?? {}) };
    const encrypted = info.encrypted_media_url ?? '';
    const has320    = info['320kbps'] === 'true' || info['320kbps'] === true;
    const downloadUrl = encrypted ? _buildDownloadUrls(encrypted, has320) : [];

    // Image: JioSaavn returns 150x150; build quality variants
    const imgRaw = raw.image ?? '';
    const imgBase = imgRaw.replace(/\d+x\d+\.jpg$/, '{q}.jpg').replace(/\d+x\d+\.webp$/, '{q}.jpg');
    const image = imgBase.includes('{q}') ? [
        { quality: '50x50',  url: imgBase.replace('{q}', '50x50')  },
        { quality: '150x150', url: imgBase.replace('{q}', '150x150') },
        { quality: '500x500', url: imgBase.replace('{q}', '500x500') },
    ] : [{ quality: '150x150', url: imgRaw }];

    const name    = _htmlDecode(raw.song ?? raw.title ?? raw.name ?? '');
    const artist  = _htmlDecode(info.primary_artists ?? info.singers ?? raw.subtitle?.split(' - ')[0] ?? '');
    const albumNm = _htmlDecode(info.album ?? raw.album ?? '');

    return {
        id:             String(raw.id ?? ''),
        name,
        title:          name,
        primaryArtists: artist,
        artists: { primary: artist ? [{ id: null, name: artist }] : [] },
        album:   { id: String(info.album_id ?? info.albumid ?? ''), name: albumNm },
        albumId: String(info.album_id ?? info.albumid ?? ''),
        duration: String(info.duration ?? raw.duration ?? ''),
        language: info.language ?? '',
        year:    info.release_date ? String(info.release_date).slice(0, 4) : String(info.year ?? raw.year ?? ''),
        label:   info.label ?? '',
        image,
        downloadUrl,
    };
}

function _htmlDecode(str) {
    return (str ?? '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function _apiCall(params) {
    const url = new URL(DIRECT_BASE);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('_format', 'json');
    url.searchParams.set('_marker', '0');
    url.searchParams.set('ctx', 'web6dot0');

    let lastError;
    for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt++) {
        try {
            const { statusCode, body } = await request(url.toString(), {
                method: 'GET',
                headers: {
                    'Accept':     'application/json, text/plain, */*',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                    'Referer':    'https://www.jiosaavn.com/',
                    'Origin':     'https://www.jiosaavn.com',
                },
                connectTimeout: CONNECT_TIMEOUT,
                bodyTimeout:    BODY_TIMEOUT,
            });

            if (statusCode !== 200) {
                throw new Error(`JioSaavn direct API: HTTP ${statusCode}`);
            }
            return await body.json();
        } catch (error) {
            lastError = error;
            // A rejected request can have an empty message (notably some
            // abort/socket errors on hosted runtimes). Retry once before
            // surfacing it to the fallback chain.
            if (attempt < MAX_REQUEST_ATTEMPTS) continue;
        }
    }

    const message = lastError?.message?.trim();
    const detail = message || lastError?.code || lastError?.name || 'unknown network error';
    throw new Error(`JioSaavn direct API request failed after ${MAX_REQUEST_ATTEMPTS} attempts: ${detail}`, {
        cause: lastError,
    });
}

// ─── Public exports ───────────────────────────────────────────────────────────

/**
 * Fetch full album details (including track list) via JioSaavn's direct API.
 * Returns a normalised object shaped like the saavn.sumit.co proxy response:
 * { success: true, data: { id, name, songs: [...] } }
 */
export async function getAlbumByIdDirect(albumId) {
    const data = await _apiCall({
        '__call': 'content.getAlbumDetails',
        'albumid': String(albumId),
    });

    // Direct API returns tracks under `list` (array of raw song objects)
    const list = Array.isArray(data?.list) ? data.list
        : Array.isArray(data?.songs) ? data.songs
        : [];

    const songs = list.map(raw => {
        const info = { ...(raw ?? {}), ...(raw?.more_info ?? {}) };
        const encrypted = info.encrypted_media_url ?? '';
        const has320 = info['320kbps'] === 'true' || info['320kbps'] === true;
        const downloadUrl = encrypted ? _buildDownloadUrls(encrypted, has320) : [];
        const imgRaw = raw.image ?? '';
        const imgBase = imgRaw.replace(/\d+x\d+\.jpg$/, '{q}.jpg').replace(/\d+x\d+\.webp$/, '{q}.jpg');
        const image = imgBase.includes('{q}') ? [
            { quality: '50x50',   url: imgBase.replace('{q}', '50x50')   },
            { quality: '150x150', url: imgBase.replace('{q}', '150x150') },
            { quality: '500x500', url: imgBase.replace('{q}', '500x500') },
        ] : [{ quality: '150x150', url: imgRaw }];

        const name   = _htmlDecode(raw.song ?? raw.title ?? raw.name ?? '');
        const artist = _htmlDecode(info.primary_artists ?? info.singers ?? '');
        return {
            id:             String(raw.id ?? ''),
            name,
            title:          name,
            primaryArtists: artist,
            artists: { primary: artist ? [{ id: null, name: artist }] : [] },
            album:   { id: String(albumId), name: _htmlDecode(info.album ?? data.title ?? '') },
            albumId: String(albumId),
            duration: String(info.duration ?? raw.duration ?? ''),
            language: info.language ?? data.language ?? '',
            image,
            downloadUrl,
        };
    }).filter(s => s.name);

    if (songs.length === 0) throw new Error('No songs in direct album response');

    return {
        success: true,
        data: {
            id:       String(data.albumid ?? data.id ?? albumId),
            name:     _htmlDecode(data.title ?? data.name ?? ''),
            language: (data.language ?? '').toLowerCase(),
            year:     data.year ?? null,
            songs,
        },
    };
}

/**
 * Fetch trending songs or albums via JioSaavn's content.getTrending endpoint.
 * Returns an array of normalised objects { id, name, type, image, url, language, year, artists }.
 */
export async function getTrendingDirect(type = 'song', language = 'hindi', limit = 20) {
    const data = await _apiCall({
        '__call':          'content.getTrending',
        'entity_type':     type,
        'entity_language': language,
    });

    // Response is either an array or an object with numeric keys
    const list = Array.isArray(data)
        ? data
        : Object.values(data ?? {}).filter(v => v && typeof v === 'object' && !Array.isArray(v));

    return list.slice(0, limit).map(item => ({
        id:       String(item.id ?? ''),
        name:     _htmlDecode(item.title ?? item.name ?? ''),
        type:     item.type ?? type,
        image:    item.image ?? null,
        url:      item.perma_url ?? item.url ?? null,
        language: item.language ?? language,
        year:     item.year ?? null,
        artists:  item.subtitle ?? item.more_info?.music ?? null,
    })).filter(item => item.name);
}

/**
 * Search songs via JioSaavn's own API endpoint.
 * Returns normalised song objects matching the saavn.sumit.co proxy format.
 */
export async function searchSongsDirect(query, limit = 20) {
    const data = await _apiCall({
        '__call': 'search.getResults',
        'q':      query,
        // JioSaavn accepts lowercase `n`. Uppercase `N` is ignored and the
        // provider silently falls back to ten results.
        'n':      String(Math.min(limit, 40)),
        'p':      '1',
    });

    const results = (data?.results ?? []).filter(r =>
        // Only songs — type '1' or entries with an encrypted_media_url
        String(r.type) === 'song' || String(r.j_object_type) === '1' ||
        r.encrypted_media_url || r.more_info?.encrypted_media_url
    );

    return results.map(_normalise);
}

/**
 * Get full song details (including stream URL) for one JioSaavn song ID.
 * Returns a normalised song object or null.
 */
export async function getSongDirect(id) {
    const data = await _apiCall({
        '__call': 'song.getDetails',
        'pids':   id,
    });

    // The direct API can also return under `songs` key
    const raw = data?.songs?.[0] ?? data?.[id] ?? null;
    return raw ? _normalise(raw) : null;
}

/**
 * Wrap direct search results in the paginated envelope that searchSongsOnly
 * callers expect: { data: { results, start, total } }
 */
export async function searchSongsOnlyDirect(query, limit = 20) {
    const songs = await searchSongsDirect(query, limit);
    return {
        data: {
            results: songs,
            start:   1,
            total:   songs.length,
        },
    };
}

/**
 * Search albums via JioSaavn's own search.getAlbumResults endpoint.
 * Returns results shaped like the saavn.sumit.co proxy: { data: { results } }
 * This endpoint correctly ranks albums (e.g. "Chotta Mumbai" → the film album,
 * not a coincidentally-named OST from a different film).
 */
/**
 * Use JioSaavn's autocomplete endpoint to find the best-matching album.
 * Returns a normalised album object (id, name, url, language) or null.
 * Autocomplete handles transliteration variants (e.g. "udayananu tharam" →
 * "Udayananu Tharam") far better than the search.getAlbumResults endpoint.
 */
export async function autocompleteAlbumSearch(query) {
    const url = new URL(DIRECT_BASE);
    url.searchParams.set('__call', 'autocomplete.get');
    url.searchParams.set('_format', 'json');
    url.searchParams.set('_marker', '0');
    url.searchParams.set('ctx', 'wap6dot0');
    url.searchParams.set('query', query);

    let data;
    try {
        const { statusCode, body } = await request(url.toString(), {
            method: 'GET',
            headers: {
                'Accept':     'application/json, text/plain, */*',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                'Referer':    'https://www.jiosaavn.com/',
                'Origin':     'https://www.jiosaavn.com',
            },
            connectTimeout: CONNECT_TIMEOUT,
            bodyTimeout:    BODY_TIMEOUT,
        });
        if (statusCode !== 200) return null;
        data = await body.json();
    } catch (_) {
        return null;
    }

    // topquery is the most reliable signal — JioSaavn picks it automatically.
    const topAlbum = data?.topquery?.data?.[0]?.type === 'album'
        ? data.topquery.data[0]
        : null;
    const albumFromAlbums = data?.albums?.data?.[0] ?? null;
    const candidate = topAlbum ?? albumFromAlbums;
    if (!candidate) return null;

    return {
        id:       String(candidate.id ?? ''),
        name:     _htmlDecode(candidate.title ?? candidate.name ?? ''),
        url:      candidate.url ?? candidate.perma_url ?? null,
        language: (candidate.more_info?.language ?? '').toLowerCase(),
        year:     candidate.more_info?.year ?? null,
        image:    candidate.image ? [{ quality: '150x150', url: candidate.image }] : [],
    };
}

export async function searchAlbumsDirect(query, limit = 10) {
    const data = await _apiCall({
        '__call': 'search.getAlbumResults',
        'q':      query,
        'n':      String(Math.min(limit, 20)),
        'p':      '1',
    });

    const results = (data?.results ?? []).map(r => ({
        // search.getAlbumResults uses `albumid` rather than `id`. Returning
        // an empty ID makes the mobile client unable to fetch the album tracks.
        id:             String(r.id ?? r.albumid ?? r.more_info?.album_id ?? ''),
        name:           _htmlDecode(r.title ?? r.name ?? ''),
        language:       (r.language ?? '').toLowerCase(),
        year:           r.year ?? null,
        url:            r.perma_url ?? null,
        image:          r.image ? [{ quality: '150x150', url: r.image }] : [],
        primaryArtists: _htmlDecode(
            r.primary_artists ?? r.subtitle ?? r.music ?? r.more_info?.music ?? ''
        ),
        songCount:      parseInt(r.more_info?.song_count ?? 0, 10),
    }));

    return { data: { results, total: data?.total ?? results.length } };
}

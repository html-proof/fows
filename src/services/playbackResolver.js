/**
 * Playback Resolver — resolves a canonical track_id to a streamable URL.
 *
 * Resolution order:
 *   1. Valid cached stream URL (SQLite stream_cache, 25 min TTL)
 *   2. JioSaavn exact mapping  (provider_maps → getSongById)
 *   3. JioSaavn search fallback (title + artist, re-verify identity)
 *   4. Failure (throw PlaybackResolveError)
 *
 * The Flutter app never calls JioSaavn directly.
 * This is the single choke point where JioSaavn stream URLs are produced.
 */

import {
    getTrack,
    getProviderTrackId,
    getCachedStreamUrl,
    cacheStreamUrl,
    invalidateStreamCache,
    resolveOrCreate,
} from './identityResolver.js';
import { getSongById, searchSongsOnly } from './saavnApi.js';
import { bigramSimilarity, normText } from './searchEngine.js';

// ─── Error type ───────────────────────────────────────────────────────────────

export class PlaybackResolveError extends Error {
    constructor(message, code = 'UNRESOLVABLE') {
        super(message);
        this.name = 'PlaybackResolveError';
        this.code = code;
    }
}

// ─── Identity confidence for fallback matching ────────────────────────────────

const IDENTITY_CONFIDENCE_MIN = 55; // accept fallback only above this

function _scoreMatch(canonical, saavnSong) {
    const ct = normText(canonical.title);
    const ca = normText(canonical.artist_name ?? '');

    const saavnTitle  = normText(saavnSong.name ?? saavnSong.title ?? '');
    const saavnArtist = normText(
        Array.isArray(saavnSong.artists?.primary)
            ? saavnSong.artists.primary.map(a => a.name ?? '').join(' ')
            : (saavnSong.primaryArtists ?? '')
    );

    const ts = bigramSimilarity(ct, saavnTitle);
    const as = bigramSimilarity(ca, saavnArtist);
    if (ts < 0.65) return 0;

    let score = ts * 60 + as * 30;

    if (canonical.duration_ms && saavnSong.duration) {
        const diff = Math.abs(canonical.duration_ms / 1000 - parseInt(saavnSong.duration, 10));
        if (diff <= 5)       score += 15;
        else if (diff <= 20) score += 5;
        else if (diff > 90)  score -= 20;
    }

    return score;
}

function _bestStreamUrl(saavnSong) {
    // downloadUrl or streamUrl, prefer 320kbps
    const urls = saavnSong?.downloadUrl ?? saavnSong?.streamUrl ?? [];
    if (!Array.isArray(urls) || !urls.length) return null;
    const sorted = [...urls].sort((a, b) => {
        const qa = parseInt(a.quality ?? '0', 10);
        const qb = parseInt(b.quality ?? '0', 10);
        return qb - qa;
    });
    return { url: sorted[0].url, quality: sorted[0].quality ?? '96kbps' };
}

// ─── Main resolver ────────────────────────────────────────────────────────────

/**
 * Resolve a canonical track ID to a stream URL.
 *
 * @param {string} canonicalId
 * @param {{ preferQuality?: '96kbps'|'160kbps'|'320kbps' }} [opts]
 * @returns {Promise<{ url: string, quality: string, provider: string, canonicalId: string }>}
 * @throws {PlaybackResolveError}
 */
export async function resolveStream(canonicalId, opts = {}) {
    // 1. Cache hit
    const cached = getCachedStreamUrl(canonicalId);
    if (cached) {
        return { ...cached, provider: 'jiosaavn', canonicalId };
    }

    // 2. Load canonical track data
    const track = getTrack(canonicalId);
    if (!track) {
        throw new PlaybackResolveError(`Unknown canonical ID: ${canonicalId}`, 'NOT_FOUND');
    }

    // 3. JioSaavn exact mapping
    const jiosaavnId = getProviderTrackId(canonicalId, 'jiosaavn');
    if (jiosaavnId) {
        try {
            const resp = await getSongById(jiosaavnId);
            const song = (resp?.data?.[0] ?? resp?.data ?? null);
            if (song) {
                const stream = _bestStreamUrl(song);
                if (stream) {
                    cacheStreamUrl(canonicalId, stream.url, stream.quality);
                    return { ...stream, provider: 'jiosaavn', canonicalId };
                }
            }
        } catch (_) {
            // fall through to search
        }
    }

    // 4. JioSaavn search fallback
    const query = `${track.title} ${track.artist_name ?? ''}`.trim();
    let results;
    try {
        results = await searchSongsOnly(query, 1, 10);
    } catch (err) {
        throw new PlaybackResolveError(`JioSaavn search failed: ${err.message}`, 'PROVIDER_ERROR');
    }

    for (const song of results ?? []) {
        const score = _scoreMatch(track, song);
        if (score < IDENTITY_CONFIDENCE_MIN) continue;

        const stream = _bestStreamUrl(song);
        if (!stream) continue;

        // Register this JioSaavn song as a mapping
        resolveOrCreate(
            { title: track.title, artist: track.artist_name, durationMs: track.duration_ms },
            'jiosaavn', song.id ?? song.songId ?? '',
        );

        cacheStreamUrl(canonicalId, stream.url, stream.quality);
        return { ...stream, provider: 'jiosaavn', canonicalId };
    }

    throw new PlaybackResolveError(
        `No playable source found for "${track.title}" (${canonicalId})`,
        'UNRESOLVABLE',
    );
}

/**
 * Force-invalidate the cached stream URL for a track so the next
 * resolveStream() call fetches a fresh one.
 */
export function evictStream(canonicalId) {
    invalidateStreamCache(canonicalId);
}

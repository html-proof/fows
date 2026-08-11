/**
 * Canonical playback-source resolver.
 *
 * A canonical track is catalog identity. A stream URL is an expiring playback
 * source. This module only ever replaces the latter.
 */

import {
    getTrack,
    getProviderTrackId,
    getCachedStreamUrl,
    cacheStreamUrl,
    invalidateStreamCache,
} from './identityResolver.js';
import { getSongById, searchSongsOnly } from './saavnApi.js';
import { searchSongsDirect, getSongDirect } from './jiosaavnDirect.js';
import { bigramSimilarity, normText } from './searchEngine.js';

export class PlaybackResolveError extends Error {
    constructor(message, code = 'UNRESOLVABLE') {
        super(message);
        this.name = 'PlaybackResolveError';
        this.code = code;
    }
}

const IDENTITY_CONFIDENCE_MIN = 78;
const FAILED_URL_TTL_MS = 10 * 60 * 1000;

// Error callbacks frequently arrive in bursts. Keep recovery keyed by canonical
// identity so every callback awaits one shared background search.
const recoveryLocks = new Map();
const failedUrls = new Map();

function _songArtist(song) {
    return Array.isArray(song.artists?.primary)
        ? song.artists.primary.map(a => a.name ?? '').join(' ')
        : (song.primaryArtists ?? song.artist ?? '');
}

function _songAlbum(song) {
    return typeof song.album === 'string'
        ? song.album
        : (song.album?.name ?? song.albumName ?? '');
}

function _versionKind(value) {
    const normalized = normText(value ?? '');
    const markers = ['remix', 'cover', 'live', 'acoustic', 'unplugged',
        'instrumental', 'karaoke', 'slowed', 'reverb', 'sped up', 'nightcore',
        'lofi', 'lo fi', 'remastered', 'extended', 'radio edit', 'reprise'];
    return markers.find(marker => normalized.includes(marker)) ?? 'original';
}

function _fieldSimilarity(left, right) {
    const a = normText(left ?? '');
    const b = normText(right ?? '');
    if (!a || !b) return 0.5; // unknown is neutral, never a positive match
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) return 0.86;
    return bigramSimilarity(a, b);
}

function _scoreMatch(canonical, candidate) {
    const titleMatch = _fieldSimilarity(canonical.title, candidate.name ?? candidate.title);
    if (titleMatch < 0.72) return 0;
    if (_versionKind(canonical.title) !== _versionKind(candidate.name ?? candidate.title)) return 0;

    const artistMatch = _fieldSimilarity(canonical.artist_name, _songArtist(candidate));
    if (normText(canonical.artist_name ?? '') && artistMatch < 0.45) return 0;

    const movieMatch = _fieldSimilarity(canonical.album_name, _songAlbum(candidate));
    const languageMatch = _fieldSimilarity(canonical.language, candidate.language);
    let durationMatch = 0.5;
    if (canonical.duration_ms && candidate.duration) {
        const diff = Math.abs(canonical.duration_ms / 1000 - parseInt(candidate.duration, 10));
        if (diff <= 5) durationMatch = 1;
        else if (diff <= 20) durationMatch = 0.7;
        else if (diff <= 45) durationMatch = 0.25;
        else return 0;
    }

    return (titleMatch * 0.35 + artistMatch * 0.30 + movieMatch * 0.15 +
        languageMatch * 0.10 + durationMatch * 0.10) * 100;
}

function _bestStreamUrl(song) {
    const urls = song?.downloadUrl ?? song?.streamUrl ?? [];
    if (!Array.isArray(urls) || urls.length === 0) return null;
    const sorted = [...urls].sort((a, b) =>
        parseInt(b.quality ?? '0', 10) - parseInt(a.quality ?? '0', 10));
    const best = sorted.find(item => typeof item?.url === 'string' && item.url.trim());
    return best ? { url: best.url, quality: best.quality ?? '96kbps' } : null;
}

/**
 * Normal playback lookup: return a cached source when valid, then try the
 * provider's exact mapping. If those miss, run the recovery search pipeline.
 */
export async function resolveStream(canonicalId, opts = {}) {
    if (opts.forceRefresh) return resolveReplacementStream(canonicalId, opts);

    const cached = getCachedStreamUrl(canonicalId);
    if (cached) return { ...cached, provider: 'jiosaavn', canonicalId };

    const track = getTrack(canonicalId);
    if (!track) throw new PlaybackResolveError(`Unknown canonical ID: ${canonicalId}`, 'NOT_FOUND');

    const providerId = getProviderTrackId(canonicalId, 'jiosaavn');
    if (providerId) {
        try {
            const response = await getSongById(providerId);
            const stream = _bestStreamUrl(response?.data?.[0] ?? response?.data);
            if (stream && !_isFailedUrl(stream.url)) {
                cacheStreamUrl(canonicalId, stream.url, stream.quality);
                return { ...stream, provider: 'jiosaavn', canonicalId };
            }
        } catch (_) {
            // The parallel resolver below is the intended fallback.
        }
    }

    return resolveReplacementStream(canonicalId, opts);
}

/**
 * Resolve a fresh source while retaining the original canonical track. Search
 * candidates may come from another album/movie/catalog entry, but their
 * metadata never escapes this method.
 */
export async function resolveReplacementStream(canonicalId, opts = {}) {
    const active = recoveryLocks.get(canonicalId);
    if (active) return active;

    const operation = _resolveReplacementStream(canonicalId, opts)
        .finally(() => recoveryLocks.delete(canonicalId));
    recoveryLocks.set(canonicalId, operation);
    return operation;
}

async function _resolveReplacementStream(canonicalId, opts) {
    const track = getTrack(canonicalId);
    if (!track) throw new PlaybackResolveError(`Unknown canonical ID: ${canonicalId}`, 'NOT_FOUND');

    invalidateStreamCache(canonicalId);
    const failedUrl = String(opts.failedUrl ?? '').trim();
    if (failedUrl) failedUrls.set(failedUrl, Date.now() + FAILED_URL_TTL_MS);
    _pruneFailedUrls();

    const queries = _buildRecoveryQueries(track);
    const providerId = getProviderTrackId(canonicalId, 'jiosaavn');
    const settled = await Promise.allSettled([
        ...queries.map(query => searchSongsOnly(query, 1)),
        ...queries.map(query => searchSongsDirect(query, 20)),
        ...(providerId ? [getSongById(providerId), getSongDirect(providerId)] : []),
    ]);

    const candidates = new Map();
    for (const result of settled) {
        if (result.status !== 'fulfilled') continue;
        const value = result.value;
        const songs = Array.isArray(value)
            ? value
            : (value?.data?.results ?? (value?.data ? [value.data] : (value ? [value] : [])));
        for (const song of songs) {
            if (!song || typeof song !== 'object') continue;
            const stream = _bestStreamUrl(song);
            if (!stream?.url || _isFailedUrl(stream.url)) continue;
            const key = `${song.id ?? song.songId ?? ''}|${stream.url}`;
            if (!candidates.has(key)) candidates.set(key, { song, stream });
        }
    }

    const winner = [...candidates.values()]
        .map(candidate => ({ ...candidate, score: _scoreMatch(track, candidate.song) }))
        .filter(candidate => candidate.score >= IDENTITY_CONFIDENCE_MIN)
        .sort((a, b) => b.score - a.score)[0];
    if (!winner) {
        throw new PlaybackResolveError(
            `No replacement source found for "${track.title}" (${canonicalId})`,
            'UNRESOLVABLE',
        );
    }

    cacheStreamUrl(canonicalId, winner.stream.url, winner.stream.quality);
    return {
        ...winner.stream,
        provider: 'jiosaavn-recovery',
        canonicalId,
        confidence: Math.round(winner.score),
        resolvedAt: new Date().toISOString(),
        validationStatus: 'pending-client-validation',
    };
}

function _buildRecoveryQueries(track) {
    const title = String(track.title ?? '').trim();
    const artist = String(track.artist_name ?? '').trim();
    const album = String(track.album_name ?? '').trim();
    const language = String(track.language ?? '').trim();
    const queries = [
        [title, artist],
        [title, album],
        [title, artist, album],
        [title, language],
        [title, artist, language],
        [artist, title, album],
        [album, 'songs'], // catalog/album lane
    ].map(parts => parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim());
    return [...new Set(queries.filter(Boolean))];
}

function _pruneFailedUrls() {
    const now = Date.now();
    for (const [url, expiresAt] of failedUrls) {
        if (expiresAt <= now) failedUrls.delete(url);
    }
}

function _isFailedUrl(url) {
    const expiresAt = failedUrls.get(url);
    return !!expiresAt && expiresAt > Date.now();
}

/** Force-invalidate a cached source before the next normal resolution. */
export function evictStream(canonicalId) {
    invalidateStreamCache(canonicalId);
}

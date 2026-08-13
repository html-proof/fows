/**
 * Canonical playback-source resolver.
 *
 * A canonical track is catalog identity. A stream URL is an expiring playback
 * source. This module resolves verified playable stream URLs by querying
 * JioSaavn and Gaana in parallel, testing accuracy matches, validating headers
 * and byte reads, and falling back to parallel multi-attribute search.
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
import { getSongById as getGaanaSongById, searchSongsOnly as searchGaanaSongsOnly } from './gaanaApi.js';
import { bigramSimilarity, normText } from './searchEngine.js';
import { validatePlayableStream } from './streamValidator.js';

export class PlaybackResolveError extends Error {
    constructor(message, code = 'UNRESOLVABLE') {
        super(message);
        this.name = 'PlaybackResolveError';
        this.code = code;
    }
}

const IDENTITY_CONFIDENCE_MIN = 70;
const FAILED_URL_TTL_MS = 10 * 60 * 1000;

// Error callbacks frequently arrive in bursts. Keep recovery keyed by canonical
// identity so every callback awaits one shared background search.
const recoveryLocks = new Map();
const failedUrls = new Map();

function _songArtist(song) {
    return Array.isArray(song?.artists?.primary)
        ? song.artists.primary.map(a => a.name ?? '').join(' ')
        : (song?.primaryArtists ?? song?.artist ?? '');
}

function _songAlbum(song) {
    return typeof song?.album === 'string'
        ? song.album
        : (song?.album?.name ?? song?.albumName ?? '');
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

function _cleanTextForMatch(text) {
    return normText(text ?? '')
        .replace(/\b(song|audio|video|full|track|ost|soundtrack|malayalam|tamil|telugu|hindi)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function _scoreMatch(canonical, candidate) {
    const canonicalTitleClean = _cleanTextForMatch(canonical.title);
    const candidateTitleClean = _cleanTextForMatch(candidate.name ?? candidate.title);

    const titleMatch = _fieldSimilarity(canonicalTitleClean || canonical.title, candidateTitleClean || candidate.name || candidate.title);
    if (titleMatch < 0.60) return 0;
    if (_versionKind(canonical.title) !== _versionKind(candidate.name ?? candidate.title)) return 0;

    const artistMatch = _fieldSimilarity(canonical.artist_name ?? canonical.artist, _songArtist(candidate));
    if (normText(canonical.artist_name ?? canonical.artist ?? '') && artistMatch < 0.30) return 0;

    const movieMatch = _fieldSimilarity(canonical.album_name ?? canonical.album, _songAlbum(candidate));
    const languageMatch = _fieldSimilarity(canonical.language, candidate.language);
    let durationMatch = 0.5;
    if (canonical.duration_ms && candidate.duration) {
        const diff = Math.abs((canonical.duration_ms / 1000) - parseInt(candidate.duration, 10));
        if (diff <= 5) durationMatch = 1.0;
        else if (diff <= 20) durationMatch = 0.75;
        else if (diff <= 45) durationMatch = 0.35;
        else return 0;
    }

    // Weights: Title 40%, Artist 25%, Album/Movie 20%, Duration 10%, Language 5%
    return (titleMatch * 0.40 + artistMatch * 0.25 + movieMatch * 0.20 +
        durationMatch * 0.10 + languageMatch * 0.05) * 100;
}

function _bestStreamUrl(song) {
    const urls = song?.downloadUrl ?? song?.streamUrl ?? [];
    if (!Array.isArray(urls) || urls.length === 0) return null;
    const sorted = [...urls].sort((a, b) =>
        parseInt(b.quality ?? '0', 10) - parseInt(a.quality ?? '0', 10));
    const best = sorted.find(item => typeof item?.url === 'string' && item.url.trim());
    return best ? { url: best.url, quality: best.quality ?? '320kbps' } : null;
}

/**
 * Normal playback lookup:
 * 1. Return cached source when validated.
 * 2. Send parallel requests to JioSaavn and Gaana.
 * 3. Pick the most accurate match, validate headers and small byte read, return playable URL.
 * 4. If both fail, run fallback parallel search.
 */
export async function resolveStream(canonicalId, opts = {}) {
    if (opts.forceRefresh || opts.overrideTrack) return resolveReplacementStream(canonicalId, opts);

    const cached = getCachedStreamUrl(canonicalId);
    if (cached) {
        const isPlayable = await validatePlayableStream(cached.url);
        if (isPlayable) {
            return { ...cached, provider: 'cached', canonicalId, validationStatus: 'cached-verified' };
        }
        invalidateStreamCache(canonicalId);
    }

    const track = opts.overrideTrack || getTrack(canonicalId);
    if (!track) throw new PlaybackResolveError(`Unknown canonical ID: ${canonicalId}`, 'NOT_FOUND');

    const jioProviderId = getProviderTrackId(canonicalId, 'jiosaavn');
    const gaanaProviderId = getProviderTrackId(canonicalId, 'gaana');

    // Parallel lookup to both providers if IDs are registered
    if (jioProviderId || gaanaProviderId) {
        const directPromises = [
            jioProviderId ? getSongById(jioProviderId).catch(() => null) : Promise.resolve(null),
            gaanaProviderId ? getGaanaSongById(gaanaProviderId).catch(() => null) : Promise.resolve(null),
        ];

        const settled = await Promise.allSettled(directPromises);
        const candidates = [];

        for (const result of settled) {
            if (result.status !== 'fulfilled' || !result.value) continue;
            const value = result.value;
            const song = value?.data?.[0] ?? value?.data ?? value;
            if (!song || typeof song !== 'object') continue;

            const stream = _bestStreamUrl(song);
            if (!stream?.url || _isFailedUrl(stream.url)) continue;

            const score = _scoreMatch(track, song);
            if (score >= IDENTITY_CONFIDENCE_MIN) {
                const provider = song.provider === 'gaana' ? 'gaana' : 'jiosaavn';
                candidates.push({ song, stream, score, provider });
            }
        }

        // Sort by match accuracy score descending
        candidates.sort((a, b) => b.score - a.score);

        // Validate top candidate with headers + small byte read
        for (const candidate of candidates) {
            const isPlayable = await validatePlayableStream(candidate.stream.url);
            if (isPlayable) {
                cacheStreamUrl(canonicalId, candidate.stream.url, candidate.stream.quality, candidate.provider);
                return {
                    url: candidate.stream.url,
                    quality: candidate.stream.quality,
                    provider: candidate.provider,
                    canonicalId,
                    confidence: Math.round(candidate.score),
                    validationStatus: 'verified-playable',
                    resolvedAt: new Date().toISOString(),
                };
            }
        }
    }

    // Fall back to multi-variant parallel search
    return resolveReplacementStream(canonicalId, opts);
}

/**
 * Resolve a fresh source while retaining the original canonical track.
 */
export async function resolveReplacementStream(canonicalId, opts = {}) {
    const active = recoveryLocks.get(canonicalId);
    if (active) return active;

    const operation = _resolveReplacementStream(canonicalId, opts)
        .finally(() => recoveryLocks.delete(canonicalId));
    recoveryLocks.set(canonicalId, operation);
    return operation;
}

/**
 * Safe parallel multi-source search wrapper
 */
async function _safeParallelSearch(queries, providerId, gaanaProviderId) {
    const searchPromises = [
        ...queries.map(q => searchSongsOnly(q, 1).catch(() => null)),
        ...queries.map(q => searchSongsDirect(q, 15).catch(() => null)),
        ...queries.map(q => searchGaanaSongsOnly(q, 15).catch(() => null)),
        ...(providerId ? [getSongById(providerId).catch(() => null), getSongDirect(providerId).catch(() => null)] : []),
        ...(gaanaProviderId ? [getGaanaSongById(gaanaProviderId).catch(() => null)] : []),
    ];

    const settled = await Promise.allSettled(searchPromises);
    const rawSongs = [];

    for (const result of settled) {
        if (result.status !== 'fulfilled' || !result.value) continue;
        const value = result.value;
        const songs = Array.isArray(value)
            ? value
            : (value?.data?.results ?? (value?.data ? [value.data] : (value ? [value] : [])));
        for (const s of songs) {
            if (s && typeof s === 'object') {
                rawSongs.push(s);
            }
        }
    }
    return rawSongs;
}

async function _resolveReplacementStream(canonicalId, opts) {
    const track = opts.overrideTrack || getTrack(canonicalId);
    if (!track) throw new PlaybackResolveError(`Unknown canonical ID: ${canonicalId}`, 'NOT_FOUND');

    invalidateStreamCache(canonicalId);
    const failedUrl = String(opts.failedUrl ?? '').trim();
    if (failedUrl) failedUrls.set(failedUrl, Date.now() + FAILED_URL_TTL_MS);
    _pruneFailedUrls();

    const queries = _buildRecoveryQueries(track);
    const providerId = getProviderTrackId(canonicalId, 'jiosaavn');
    const gaanaProviderId = getProviderTrackId(canonicalId, 'gaana');

    const songs = await _safeParallelSearch(queries, providerId, gaanaProviderId);
    const candidates = [];

    for (const song of songs) {
        const stream = _bestStreamUrl(song);
        if (!stream?.url || _isFailedUrl(stream.url)) continue;

        const score = _scoreMatch(track, song);
        if (score < IDENTITY_CONFIDENCE_MIN) continue;

        const provider = song.provider === 'gaana' ? 'gaana' : 'jiosaavn';
        candidates.push({ song, stream, score, provider });
    }

    // Sort candidates by match accuracy score descending
    candidates.sort((a, b) => b.score - a.score);

    if (candidates.length === 0) {
        throw new PlaybackResolveError(
            `No replacement source found for "${track.title}" (${canonicalId})`,
            'UNRESOLVABLE',
        );
    }

    // Validate candidates in order of score, returning the FIRST valid playable stream
    for (const cand of candidates) {
        const isPlayable = await validatePlayableStream(cand.stream.url);
        if (isPlayable) {
            cacheStreamUrl(canonicalId, cand.stream.url, cand.stream.quality, cand.provider);
            return {
                url: cand.stream.url,
                quality: cand.stream.quality,
                provider: cand.provider,
                canonicalId,
                confidence: Math.round(cand.score),
                resolvedAt: new Date().toISOString(),
                validationStatus: 'verified-playable',
            };
        }
    }

    throw new PlaybackResolveError(
        `No playable stream passed validation for "${track.title}" (${canonicalId})`,
        'UNRESOLVABLE',
    );
}

function _buildRecoveryQueries(track) {
    const title = String(track.title ?? '').trim();
    const artist = String(track.artist_name ?? track.artist ?? '').trim();
    const album = String(track.album_name ?? track.album ?? '').trim();
    const language = String(track.language ?? '').trim();
    const queries = [
        [title, artist],
        [title, album],
        [title, artist, album],
        [title, language],
        [title, artist, language],
        [artist, title, album],
        [album, 'songs'],
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

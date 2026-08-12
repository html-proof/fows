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
import { getSongById as getGaanaSongById, searchSongsOnly as searchGaanaSongsOnly } from './gaanaApi.js';
import { bigramSimilarity, normText } from './searchEngine.js';
import { request } from 'undici';

async function validateUrl(url) {
    if (!url) return false;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1200);

        const { statusCode } = await request(url, {
            method: 'HEAD',
            signal: controller.signal,
            headersTimeout: 1200,
            bodyTimeout: 1200,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://gaana.com/',
            },
        });

        clearTimeout(timeout);
        return statusCode >= 200 && statusCode < 400;
    } catch (e) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 1200);

            const { statusCode } = await request(url, {
                method: 'GET',
                signal: controller.signal,
                headersTimeout: 1200,
                bodyTimeout: 1200,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': 'https://gaana.com/',
                    'Range': 'bytes=0-8',
                },
            });

            clearTimeout(timeout);
            return statusCode >= 200 && statusCode < 400;
        } catch (_) {
            return false;
        }
    }
}

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
    if (titleMatch < 0.65) return 0;
    if (_versionKind(canonical.title) !== _versionKind(candidate.name ?? candidate.title)) return 0;

    const artistMatch = _fieldSimilarity(canonical.artist_name, _songArtist(candidate));
    if (normText(canonical.artist_name ?? '') && artistMatch < 0.35) return 0;

    const movieMatch = _fieldSimilarity(canonical.album_name, _songAlbum(candidate));
    const languageMatch = _fieldSimilarity(canonical.language, candidate.language);
    let durationMatch = 0.5;
    if (canonical.duration_ms && candidate.duration) {
        const diff = Math.abs(canonical.duration_ms / 1000 - parseInt(candidate.duration, 10));
        if (diff <= 5) durationMatch = 1;
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
    return best ? { url: best.url, quality: best.quality ?? '96kbps' } : null;
}

/**
 * Normal playback lookup: return a cached source when valid, then try the
 * provider's exact mapping. If those miss, run the recovery search pipeline.
 */
export async function resolveStream(canonicalId, opts = {}) {
    if (opts.forceRefresh || opts.overrideTrack) return resolveReplacementStream(canonicalId, opts);

    const cached = getCachedStreamUrl(canonicalId);
    if (cached) {
        const isPlayable = await validateUrl(cached.url);
        if (isPlayable) {
            return { ...cached, provider: 'jiosaavn', canonicalId, validationStatus: 'cached-verified' };
        }
        invalidateStreamCache(canonicalId);
    }

    const track = opts.overrideTrack || getTrack(canonicalId);
    if (!track) throw new PlaybackResolveError(`Unknown canonical ID: ${canonicalId}`, 'NOT_FOUND');

    const providerId = getProviderTrackId(canonicalId, 'jiosaavn');
    if (providerId) {
        try {
            const response = await getSongById(providerId);
            const stream = _bestStreamUrl(response?.data?.[0] ?? response?.data);
            if (stream && !_isFailedUrl(stream.url)) {
                const isPlayable = await validateUrl(stream.url);
                if (isPlayable) {
                    cacheStreamUrl(canonicalId, stream.url, stream.quality);
                    return { ...stream, provider: 'jiosaavn', canonicalId, validationStatus: 'verified-playable' };
                }
            }
        } catch (_) {
            // Fall through to parallel resolver
        }
    }

    const gaanaProviderId = getProviderTrackId(canonicalId, 'gaana');
    if (gaanaProviderId) {
        try {
            const gaanaSong = await getGaanaSongById(gaanaProviderId);
            const stream = _bestStreamUrl(gaanaSong);
            if (stream && !_isFailedUrl(stream.url)) {
                const isPlayable = await validateUrl(stream.url);
                if (isPlayable) {
                    cacheStreamUrl(canonicalId, stream.url, stream.quality);
                    return { ...stream, provider: 'gaana', canonicalId, validationStatus: 'verified-playable' };
                }
            }
        } catch (_) {
            // Fall through to parallel resolver
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
    const track = opts.overrideTrack || getTrack(canonicalId);
    if (!track) throw new PlaybackResolveError(`Unknown canonical ID: ${canonicalId}`, 'NOT_FOUND');

    invalidateStreamCache(canonicalId);
    const failedUrl = String(opts.failedUrl ?? '').trim();
    if (failedUrl) failedUrls.set(failedUrl, Date.now() + FAILED_URL_TTL_MS);
    _pruneFailedUrls();

    const queries = _buildRecoveryQueries(track);
    const providerId = getProviderTrackId(canonicalId, 'jiosaavn');
    const gaanaProviderId = getProviderTrackId(canonicalId, 'gaana');
    const settled = await Promise.allSettled([
        ...queries.map(query => searchSongsOnly(query, 1)),
        ...queries.map(query => searchSongsDirect(query, 20)),
        ...queries.map(query => searchGaanaSongsOnly(query, 20)),
        ...(providerId ? [getSongById(providerId), getSongDirect(providerId)] : []),
        ...(gaanaProviderId ? [getGaanaSongById(gaanaProviderId)] : []),
    ]);

    const jioCandidates = [];
    const gaanaCandidates = [];

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
            
            const score = _scoreMatch(track, song);
            if (score < IDENTITY_CONFIDENCE_MIN) continue;

            const provider = song.provider === 'gaana' ? 'gaana' : 'jiosaavn';
            const candidate = { song, stream, score };

            if (provider === 'gaana') {
                gaanaCandidates.push(candidate);
            } else {
                jioCandidates.push(candidate);
            }
        }
    }

    jioCandidates.sort((a, b) => b.score - a.score);
    gaanaCandidates.sort((a, b) => b.score - a.score);

    const bestJio = jioCandidates[0];
    const bestGaana = gaanaCandidates[0];

    if (!bestJio && !bestGaana) {
        throw new PlaybackResolveError(
            `No replacement source found for "${track.title}" (${canonicalId})`,
            'UNRESOLVABLE',
        );
    }

    const [jioPlayable, gaanaPlayable] = await Promise.all([
        bestJio ? validateUrl(bestJio.stream.url) : Promise.resolve(false),
        bestGaana ? validateUrl(bestGaana.stream.url) : Promise.resolve(false),
    ]);

    let primary = null;
    let fallback = null;

    if (bestJio && bestGaana) {
        if (jioPlayable && gaanaPlayable) {
            primary = bestJio;
            fallback = bestGaana;
        } else if (gaanaPlayable) {
            primary = bestGaana;
            fallback = bestJio;
        } else if (jioPlayable) {
            primary = bestJio;
            fallback = bestGaana;
        } else {
            if (bestJio.score >= bestGaana.score) {
                primary = bestJio;
                fallback = bestGaana;
            } else {
                primary = bestGaana;
                fallback = bestJio;
            }
        }
    } else if (bestJio) {
        primary = bestJio;
    } else if (bestGaana) {
        primary = bestGaana;
    }

    const primaryUrl = primary.stream.url;
    const primaryQuality = primary.stream.quality;
    const primaryProvider = primary.song.provider === 'gaana' ? 'gaana' : 'jiosaavn';

    cacheStreamUrl(canonicalId, primaryUrl, primaryQuality);

    return {
        url: primaryUrl,
        quality: primaryQuality,
        provider: primaryProvider,
        fallbackUrl: fallback?.stream?.url ?? null,
        fallbackProvider: fallback ? (fallback.song.provider === 'gaana' ? 'gaana' : 'jiosaavn') : null,
        canonicalId,
        confidence: Math.round(primary.score),
        resolvedAt: new Date().toISOString(),
        validationStatus: (jioPlayable || gaanaPlayable) ? 'verified-playable' : 'fallback-unverified',
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

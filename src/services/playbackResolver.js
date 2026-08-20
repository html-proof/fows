/**
 * Canonical playback-source resolver & unified streaming engine.
 *
 * A canonical track is catalog identity. A stream URL is an expiring playback
 * source. This module resolves verified playable stream URLs by querying
 * JioSaavn and Gaana in parallel, testing candidate streams with fast probe
 * validation (HEAD / Range GET), and caching verified URLs with short TTLs.
 */

import {
    getTrack,
    getProviderTrackId,
} from './identityResolver.js';
import { getSongById, searchSongsOnly, requestJsonWithTimeoutExported } from './saavnApi.js';
import { searchSongsDirect, getSongDirect } from './jiosaavnDirect.js';
import { getSongById as getGaanaSongById, searchSongsOnly as searchGaanaSongsOnly } from './gaanaApi.js';
import { bigramSimilarity, normText } from './searchEngine.js';
import { probeStreamUrl, getHeadersForStreamUrl, validatePlayableStream } from './streamValidator.js';

const SAAVN_PROXY_BASE = 'https://saavn.sumit.co';

export class PlaybackResolveError extends Error {
    constructor(message, code = 'UNRESOLVABLE') {
        super(message);
        this.name = 'PlaybackResolveError';
        this.code = code;
    }
}

// ─── Spotify-style data-saver quality tiers ────────────────────────────────────
// Each song's download URL exists at 320/160/96/48/12 kbps. Streaming the top
// bitrate uses ~8 MB for a 3.5-minute song; the lower tiers keep mobile-data
// use in Spotify's ~1-4 MB range. A tier defines the bitrate ladder the resolver
// walks — the FIRST bitrate the CDN actually serves for that tier wins, so an
// unavailable bitrate transparently falls through to the next best one.
//
//   Tier      Target   ~Data / 3.5-min song    (Spotify equivalent)
//   ────────  ───────  ──────────────────────  ────────────────────
//   low        48kbps  ~1.3 MB                 Low
//   normal     96kbps  ~2.5 MB                 Normal   (default)
//   high      160kbps  ~4.2 MB                 High
//   max       320kbps  ~8.4 MB                 Very High
// The selected tier is a CEILING on data spent, so each ladder exhausts every
// bitrate at or below it before considering a larger one.
//
// They used to climb: `normal` tried 96 then 160, and `low` tried 48 then 96 —
// so a track missing the requested bitrate was served a BIGGER file than the
// setting allowed. Choosing 96 kbps and receiving 160 or 320 is what made one
// song cost several megabytes.
//
// Bitrates above the ceiling stay on the ladder as a last resort, after every
// smaller one has been tried: some tracks are only published at one bitrate,
// and silence is worse than an oversized stream. Order within that tail is
// ascending, so the overshoot is as small as it can be.
export const QUALITY_LADDERS = {
    low:    ['48kbps', '12kbps', '96kbps', '160kbps', '320kbps'],
    normal: ['96kbps', '48kbps', '12kbps', '160kbps', '320kbps'],
    high:   ['160kbps', '96kbps', '48kbps', '12kbps', '320kbps'],
    max:    ['320kbps', '160kbps', '96kbps', '48kbps', '12kbps'],
};

export const DEFAULT_QUALITY = 'normal';

/**
 * Coerce any client-supplied quality hint into a canonical tier name.
 * Accepts tier names (low/normal/high/max), Spotify-style aliases
 * (data_saver, very_high, auto), or a raw bitrate ('96', '160kbps', 320).
 */
export function normalizeQuality(input) {
    if (input === undefined || input === null || input === '') return DEFAULT_QUALITY;
    const s = String(input).trim().toLowerCase();
    if (QUALITY_LADDERS[s]) return s;
    switch (s) {
        case 'auto':
        case 'automatic':
        case 'standard':
        case 'medium':
            return 'normal';
        case 'data_saver':
        case 'datasaver':
        case 'saver':
        case 'lowest':
        case 'economy':
            return 'low';
        case 'very_high':
        case 'veryhigh':
        case 'highest':
        case 'lossless':
        case 'best':
            return 'max';
    }
    // Raw bitrate hint, e.g. "96", "160kbps", "320".
    //
    // A numeric hint is a CEILING — the client sends the bitrate it has decided
    // to spend on this connection — so pick the richest tier that stays within
    // it, never the nearest one. Rounding up defeated the point: a Data Saver
    // client asking for 64 kbps was handed the 96 kbps tier, spending 50% more
    // data than it had budgeted.
    const kbps = parseInt(s, 10);
    if (Number.isFinite(kbps)) {
        if (kbps >= 320) return 'max';
        if (kbps >= 160) return 'high';
        if (kbps >= 96) return 'normal';
        return 'low';
    }
    return DEFAULT_QUALITY;
}

// ─── Short TTL Memory Stream URL Cache ─────────────────────────────────────────
// JioSaavn & Gaana CDN tokens typically expire in 20-60 mins.
// We set a 15-minute TTL to ensure fresh playable URLs.
// Cache entries are keyed per quality tier so a "low" request never returns a
// previously cached "max" (320kbps) URL and vice-versa.
const STREAM_CACHE_TTL_MS = 15 * 60 * 1000;
const memoryStreamCache = new Map();

function _cacheKey(trackKey, quality) {
    return `${trackKey}::${normalizeQuality(quality)}`;
}

// ─── URL outcome memory ────────────────────────────────────────────────────────
// Remembers which concrete CDN URLs actually played and which ones failed, so
// the resolver stops re-learning the same lesson on every request.
//
// Two costs this removes from the tap-to-audio path:
//   * A URL known to be dead is dropped before any probe is fired. Previously a
//     404'd URL sat at the top of the bitrate ladder and every later play of
//     that track paid its probe timeout again before moving on.
//   * A URL known to be good is returned WITHOUT probing at all, which is a
//     whole network round-trip saved on the common repeat-play path.
//
// Kept deliberately short-lived: CDN tokens expire, so "good" is only trusted
// briefly, while "dead" is remembered longer because a 404 rarely heals.
const URL_OK_TTL_MS   = 5 * 60 * 1000;
const URL_DEAD_TTL_MS = 30 * 60 * 1000;
const URL_OUTCOME_MAX = 5000;
const urlOutcomes = new Map(); // url -> { ok: boolean, at: number }

function _pruneUrlOutcomes() {
    if (urlOutcomes.size <= URL_OUTCOME_MAX) return;
    // Map preserves insertion order — drop the oldest quarter in one pass.
    const drop = Math.ceil(URL_OUTCOME_MAX / 4);
    let i = 0;
    for (const key of urlOutcomes.keys()) {
        urlOutcomes.delete(key);
        if (++i >= drop) break;
    }
}

/**
 * Records how a URL actually behaved. Callers that stream bytes (the playback
 * gateway) should report here: a real 200/206 or a real 404 is far stronger
 * evidence than a HEAD probe.
 */
export function markStreamUrlOutcome(url, ok) {
    const u = String(url || '').trim();
    if (!u.startsWith('http')) return;
    urlOutcomes.set(u, { ok: !!ok, at: Date.now() });
    _pruneUrlOutcomes();
}

/** 'ok' | 'dead' | null (unknown / expired). */
function _urlOutcome(url) {
    const entry = urlOutcomes.get(url);
    if (!entry) return null;
    const ttl = entry.ok ? URL_OK_TTL_MS : URL_DEAD_TTL_MS;
    if (Date.now() - entry.at > ttl) {
        urlOutcomes.delete(url);
        return null;
    }
    return entry.ok ? 'ok' : 'dead';
}

// In-flight resolution deduplication locks (keyed by track key)
const inFlightResolves = new Map();

// ─── Resolution deadline ───────────────────────────────────────────────────────
// The caller is released after RESOLVE_BUDGET_MS, so any work still running past
// that point is orphaned: nobody reads its result, but it keeps holding sockets
// and probing CDNs. Every sequential step below checks the shared deadline and
// bails, and probe timeouts are clamped to whatever budget is left. Without this
// an abandoned resolve could keep grinding for a minute or more.
//
// The budget is a ceiling on failure, not a target: a cold resolve should land
// in ~1-3s. Every stage below is either raced or hedged so the ceiling is the
// slowest single upstream call, never the sum of them.
const RESOLVE_BUDGET_MS = 5000;

// Direct-by-ID is the accurate lane, so it gets a head start — but only a short
// one. Past this point the search lane is started alongside it and whichever
// produces a playable URL first wins, so a stalled provider lookup can no
// longer eat the whole budget before the fallback has even been attempted.
const SEARCH_HEDGE_AFTER_MS = 1200;

// Budget for a resolve that is recovering from a URL the client already saw
// fail. It is wider than the normal one because the cheap answers have been
// ruled out by definition: what is left is a cross-provider search, and cutting
// it off at the ordinary budget is what left the player with nothing to fail
// over to.
const RECOVERY_BUDGET_MS = 8000;

// How many wide-net query variants may run concurrently on the recovery path.
// Each variant fans out to three provider searches, so this is the knob that
// keeps a failing track from turning into a request storm. Four is enough to
// cover title+album, title+artist+album, artist+album and title+language.
const WIDE_SEARCH_MAX_VARIANTS = 4;

function _msLeft(deadlineAt) {
    if (!deadlineAt) return Infinity;
    return deadlineAt - Date.now();
}

function _expired(deadlineAt) {
    return _msLeft(deadlineAt) <= 0;
}

/**
 * Stop waiting on `promise` once the deadline passes and yield `onExpiry`
 * instead. Upstream search clients carry their own 6-8s connect/body timeouts,
 * which on their own can outlive the whole resolution budget.
 */
function _withDeadline(promise, deadlineAt, onExpiry = null) {
    const left = _msLeft(deadlineAt);
    if (!Number.isFinite(left)) return promise;
    if (left <= 0) return Promise.resolve(onExpiry);
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(onExpiry), left);
        if (typeof timer.unref === 'function') timer.unref();
        promise.then(
            (v) => { clearTimeout(timer); resolve(v); },
            () => { clearTimeout(timer); resolve(onExpiry); },
        );
    });
}

/**
 * Resolve with the first promise to yield a truthy value; null if the deadline
 * passes or every promise settles empty. Unlike Promise.any this ignores falsy
 * fulfilments (a lane that finished but found nothing) instead of accepting
 * them as the answer.
 */
function _firstTruthy(promises, deadlineAt) {
    return new Promise((resolve) => {
        let remaining = promises.length;
        let settled = false;
        const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
        if (remaining === 0) return finish(null);
        const left = _msLeft(deadlineAt);
        if (Number.isFinite(left)) {
            const timer = setTimeout(() => finish(null), Math.max(0, left));
            if (typeof timer.unref === 'function') timer.unref();
        }
        for (const p of promises) {
            Promise.resolve(p)
                .then((v) => { if (v) finish(v); })
                .catch(() => {})
                .finally(() => { remaining -= 1; if (remaining === 0) finish(null); });
        }
    });
}

export function getCachedStream(trackKey, quality = DEFAULT_QUALITY) {
    if (!trackKey) return null;
    const entry = memoryStreamCache.get(_cacheKey(trackKey, quality));
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        memoryStreamCache.delete(_cacheKey(trackKey, quality));
        return null;
    }
    // A cached URL that has since been observed dead is worse than no cache at
    // all: the gateway would hand it straight back — or 302 the player at it —
    // and the track would fail again for everyone until the TTL ran out.
    if (entry.streamUrl && _urlOutcome(entry.streamUrl) === 'dead') {
        memoryStreamCache.delete(_cacheKey(trackKey, quality));
        return null;
    }
    return entry;
}

export function setCachedStream(trackKey, streamData, quality = DEFAULT_QUALITY) {
    if (!trackKey || !streamData?.streamUrl) return;
    memoryStreamCache.set(_cacheKey(trackKey, quality), {
        ...streamData,
        expiresAt: Date.now() + STREAM_CACHE_TTL_MS,
        cachedAt: Date.now(),
    });
}

export function invalidateStreamCache(trackKey, quality) {
    if (!trackKey) return;
    // No tier given → drop every cached tier for this track.
    if (quality === undefined) {
        for (const tier of Object.keys(QUALITY_LADDERS)) {
            memoryStreamCache.delete(_cacheKey(trackKey, tier));
        }
        return;
    }
    memoryStreamCache.delete(_cacheKey(trackKey, quality));
}

export function generateTrackKey(id, title = '', artist = '', album = '', language = '') {
    if (id && String(id).trim().length > 0) {
        return String(id).trim();
    }
    // Language is part of the identity when there is no id to key on. A film
    // released in several languages reuses its songs' titles, so title + artist
    // + album alone let the Tamil and Malayalam recordings share one cache
    // entry — and whichever resolved first was then served for both.
    const clean = normText(`${title} ${artist} ${album} ${language}`);
    let hash = 0;
    for (let i = 0; i < clean.length; i++) {
        hash = (Math.imul(31, hash) + clean.charCodeAt(i)) | 0;
    }
    return `trk_${Math.abs(hash).toString(36)}`;
}

/**
 * Return every playable download URL for a song, ordered best-quality first.
 *
 * JioSaavn download URLs are fabricated by string-swapping the bitrate token
 * (see jiosaavnDirect._buildDownloadUrls), so a `_320`/`_160` URL is NOT
 * guaranteed to exist on the CDN — some tracks only encode lower bitrates.
 * Returning the full ordered list lets the caller probe down the ladder and
 * pick the first bitrate the CDN actually serves, instead of blindly handing
 * the player a 320kbps URL that 404s.
 */
/**
 * Read the bitrate a CDN URL encodes, as a quality label ('96kbps', …).
 *
 * Matches the bitrate TOKEN — `_96.mp4`, `_320_v4.mp4` — not any occurrence of
 * the digits. A bare substring test (the previous behaviour) also matched the
 * random hash in the filename and the numeric CDN directory, so a URL like
 * `.../606/8dd6da86c5eab7e6483b3e854cfd61d1_96.mp4` reported "48kbps" purely
 * because its hash happened to contain "48". Mislabelled candidates then
 * shuffled the quality ladder and the resolver handed back the wrong bitrate.
 *
 * Falls back to the top bitrate when no token is present, so an unlabelled URL
 * is never mistaken for a cheap one.
 */
export function bitrateLabelForStreamUrl(url) {
    // JioSaavn encodes the bitrate as a `_320` suffix on the filename; Gaana
    // makes it the filename itself (`.../769403/128.mp4.master.m3u8`) and offers
    // a different ladder. Accept both separators and both ladders -- an
    // unrecognised URL falls back to 320kbps, which would file a Gaana stream
    // under the `max` tier and hand every client the richest rendition.
    const match = String(url || '').match(/[_/](12|48|64|96|128|160|320)(?:_[^./]*)?\.(?:mp4|m4a|mp3|aac)/i);
    return match ? `${match[1]}kbps` : '320kbps';
}

function _labelForUrl(u) {
    return bitrateLabelForStreamUrl(u);
}

function _extractDownloadCandidates(song, quality = DEFAULT_QUALITY) {
    if (!song) return [];
    const urls = Array.isArray(song.downloadUrl) ? song.downloadUrl : [];

    // Collect one URL per available bitrate label.
    const byQuality = new Map();
    const add = (url, q) => {
        if (typeof url !== 'string') return;
        const u = url.trim();
        if (!u.startsWith('http')) return;
        const label = q || _labelForUrl(u);
        if (!byQuality.has(label)) byQuality.set(label, u);
    };
    for (const entry of urls) add(entry?.url, entry?.quality);
    // Legacy single-string shapes.
    add(song.streamUrl);
    add(song.stream_url);
    if (typeof song.downloadUrl === 'string') add(song.downloadUrl);

    // Order by the requested tier's ladder so the target bitrate is probed
    // first and the resolver settles on the lowest-data URL that actually plays.
    const ladder = QUALITY_LADDERS[normalizeQuality(quality)] || QUALITY_LADDERS[DEFAULT_QUALITY];
    const ordered = [];
    const seenUrl = new Set();
    for (const q of ladder) {
        const u = byQuality.get(q);
        if (u && !seenUrl.has(u)) { seenUrl.add(u); ordered.push({ url: u, quality: q }); }
    }
    // Any bitrate labels not covered by the ladder, appended last.
    for (const [q, u] of byQuality) {
        if (!seenUrl.has(u)) { seenUrl.add(u); ordered.push({ url: u, quality: q }); }
    }
    return ordered;
}

/**
 * Walk a song's download candidates best-quality first and return the first
 * one the CDN actually serves (probe-verified 200/206). Restores the module's
 * "verified playable URLs only" guarantee for the direct-by-ID lane, so the
 * 302 fast-path never redirects the player to a dead/404 CDN URL.
 *
 * Bounded to the top few bitrates so cold-start latency stays low: a valid
 * top-of-ladder hit returns after a single probe RTT.
 *
 * The probes are fired together and then consumed in ladder order. Walking them
 * one at a time made a cold resolve cost the SUM of up to three probe timeouts
 * per lane, which on its own could exhaust the whole resolution budget; fired
 * together the cost is one probe timeout while the preferred bitrate still wins
 * whenever it is playable.
 */
async function _firstPlayableCandidate(song, provider, { maxCandidates = 3, timeoutMs = 1800, quality = DEFAULT_QUALITY, deadlineAt = null, excludeUrls = null } = {}) {
    let candidates = _extractDownloadCandidates(song, quality);
    // Drop URLs a caller already knows are dead. Without this, re-resolving
    // after a stream failure just handed back the same URL that had failed
    // moments earlier — the retry could never reach a different source.
    if (excludeUrls && excludeUrls.size > 0) {
        candidates = candidates.filter(c => !excludeUrls.has(c.url));
    }
    // Drop URLs remembered as dead from an earlier attempt, so their probe
    // timeout is never paid twice.
    candidates = candidates.filter(c => _urlOutcome(c.url) !== 'dead');
    candidates = candidates.slice(0, maxCandidates);
    if (candidates.length === 0) return null;

    // Fast path: a URL that recently played needs no probe at all. This is the
    // repeat-play case, and skipping the probe removes a full round-trip from
    // the time between the tap and the first audio byte.
    // Only the PREFERRED candidate may take this path.
    //
    // This used to scan the whole ladder for anything remembered as good, which
    // let a bitrate the track had been played at moments earlier be returned
    // without the requested one ever being probed. It went wrong in both
    // directions: a 96 kbps setting was handed a remembered 320 kbps URL, and a
    // 160 kbps setting was handed a remembered 96. The ladder's own order is
    // the decision; the memory is only there to skip a probe, never to change
    // the answer.
    //
    // The repeat-play case this exists for is unaffected: playing the same
    // track again at the same quality asks for the same bitrate, which is
    // candidates[0] and is exactly the URL remembered as good.
    const preferred = candidates[0];
    const known = _urlOutcome(preferred.url) === 'ok' ? preferred : null;
    if (known) {
        return {
            streamUrl: known.url,
            quality: known.quality,
            contentType: known.url.includes('.mp4') ? 'audio/mp4' : 'audio/mpeg',
            isHls: known.url.includes('.m3u8'),
            provider,
            song,
        };
    }

    // Never start probes we have no budget left to finish.
    const budget = Math.min(timeoutMs, _msLeft(deadlineAt));
    if (budget <= 0) return null;

    const probes = candidates.map(c =>
        probeStreamUrl(c.url, { timeoutMs: budget }).catch(() => ({ isValid: false })),
    );

    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const probe = await probes[i];
        // Remember the verdict either way so the next play of this track can
        // skip the probe (valid) or skip the URL entirely (invalid).
        markStreamUrlOutcome(c.url, probe.isValid);
        if (probe.isValid) {
            return {
                streamUrl: c.url,
                quality: c.quality,
                contentType: probe.contentType || (c.url.includes('.mp4') ? 'audio/mp4' : 'audio/mpeg'),
                isHls: probe.isHls || c.url.includes('.m3u8'),
                provider,
                song,
            };
        }
    }
    return null;
}

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

/**
 * Whether a search candidate is in a DIFFERENT language than the one asked for.
 *
 * A film released in several languages reuses its title and its songs' titles
 * across all of them, so title and artist alone cannot separate the Tamil
 * recording from the Malayalam one — they score identically, and whichever the
 * providers happened to return first won. Tapping a Tamil track then played the
 * Malayalam one under the right name.
 *
 * Only a stated disagreement counts. A candidate the provider left unlabelled
 * is not evidence of the wrong language and is still allowed through, so this
 * can never empty a result set that would otherwise have resolved.
 */
function _languageConflicts(wanted, candidate) {
    const norm = v => String(v ?? '').trim().toLowerCase();
    const want = norm(wanted);
    if (!want) return false;
    const got = norm(candidate?.language);
    if (!got) return false;
    return got !== want;
}

function _scoreCandidate(targetTitle, targetArtist, candidate) {
    const candTitle = normText(candidate.name || candidate.title || '');
    const candArtist = normText(_songArtist(candidate));
    const titleSim = bigramSimilarity(normText(targetTitle || ''), candTitle);
    const artistSim = targetArtist ? bigramSimilarity(normText(targetArtist), candArtist) : 0.6;
    let score = titleSim * 0.7 + artistSim * 0.3;
    // Boost direct progressive download candidates (JioSaavn MP4/AAC) for instant universal compatibility
    if (Array.isArray(candidate?.downloadUrl) && candidate.downloadUrl.length > 0) {
        score += 0.20;
    }
    return score;
}

/**
 * Direct parallel lookup for a song on JioSaavn (direct + proxy) and Gaana by ID.
 *
 * Runs three lanes in parallel:
 *   Lane A: JioSaavn direct API (fast when server is in India; may lack encrypted_media_url otherwise)
 *   Lane B: saavn.sumit.co proxy (geo-transparent; returns pre-decrypted CDN URLs)
 *   Lane C: Gaana direct API
 *
 * First lane to return a usable stream wins.
 */
async function _resolveDirectById(songId, quality = DEFAULT_QUALITY, deadlineAt = null, excludeUrls = null) {
    if (!songId) return null;

    let jioId = songId;
    let gaanaId = songId;

    // If songId is a canonical ID (trk_...), look up mapped provider IDs from SQLite
    if (songId.startsWith('trk_')) {
        try {
            const mappedJio = getProviderTrackId(songId, 'jiosaavn');
            if (mappedJio) jioId = mappedJio;
            const mappedGaana = getProviderTrackId(songId, 'gaana');
            if (mappedGaana) gaanaId = mappedGaana;
            if (!mappedJio && !mappedGaana) return null;
        } catch (_) {
            return null;
        }
    }

    // Probe-verify the chosen CDN URL (walking bitrates best→worst) before a
    // lane is allowed to win. Without this, an unverified 320kbps URL that the
    // CDN never encoded 404s straight through the 302 fast-path to the player.
    const makeResult = (song, provider) => _firstPlayableCandidate(song, provider, { quality, deadlineAt, excludeUrls });

    // Detail lookups get roughly half the remaining budget: whatever they
    // return still has to be probe-verified before the lane can win.
    const detailTimeoutMs = Math.max(1, Math.min(2500, Math.round(_msLeft(deadlineAt) / 2)));

    const lanes = [
        // Lane A: JioSaavn direct API (fastest when running from Indian region)
        (async () => {
            if (!jioId || jioId.startsWith('trk_')) return null;
            const song = await getSongDirect(jioId, { timeoutMs: detailTimeoutMs }).catch(() => null);
            return makeResult(song, 'jiosaavn');
        })(),

        // Lane B: saavn.sumit.co proxy — geo-transparent third-party wrapper.
        // Returns pre-decrypted CDN URLs so no DES/encryption step needed here.
        // The proxy may be cold, but it is the most reliable non-Indian path —
        // it still only gets its share of the budget, since a 5 s wait here used
        // to outlive the entire resolution it was supposed to serve.
        (async () => {
            if (!jioId || jioId.startsWith('trk_')) return null;
            try {
                const res = await requestJsonWithTimeoutExported(
                    `${SAAVN_PROXY_BASE}/api/songs/${encodeURIComponent(jioId)}`,
                    { timeoutMs: detailTimeoutMs, label: 'saavn-proxy song' },
                );
                // Proxy may return { data: song } or { data: [song] }
                const song = Array.isArray(res?.data) ? res.data[0] : res?.data;
                return makeResult(song, 'jiosaavn');
            } catch (_) {
                return null;
            }
        })(),

        // Lane C: Gaana direct API
        (async () => {
            if (!gaanaId || gaanaId.startsWith('trk_')) return null;
            const detail = await _withDeadline(
                getGaanaSongById(gaanaId).catch(() => null),
                Date.now() + detailTimeoutMs,
                null,
            );
            const song = detail?.data?.[0] || detail?.data;
            return makeResult(song, 'gaana');
        })(),
    ];

    // TRUE RACE: return the first lane that yields a usable progressive (non-HLS)
    // stream the instant it arrives — do NOT wait for the slowest lane's 5s timeout.
    // If no lane produces a non-HLS source, fall back to the first HLS/any result
    // once every lane has settled. This is the single biggest cold-start win:
    // a fast JioSaavn-direct hit (~300ms) is no longer blocked behind the proxy.
    return new Promise((resolve) => {
        let remaining = lanes.length;
        let fallback = null;
        let settled = false;
        const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
        // Hard stop: if a lane hangs past the deadline, stop waiting for it.
        const left = _msLeft(deadlineAt);
        if (Number.isFinite(left)) {
            const capTimer = setTimeout(() => finish(fallback), Math.max(0, left));
            if (typeof capTimer.unref === 'function') capTimer.unref();
        }
        for (const lane of lanes) {
            lane.then((r) => {
                if (r && !r.isHls) {
                    finish(r);               // best case — return immediately
                } else if (r && !fallback) {
                    fallback = r;            // keep first HLS/any as a fallback
                }
            }).catch(() => {}).finally(() => {
                remaining -= 1;
                if (remaining === 0) finish(fallback);
            });
        }
    });
}

/**
 * Fallback parallel search across JioSaavn and Gaana for song title + artist.
 */
/**
 * One search round: query every provider in parallel for a single query
 * string, score the candidates against the requested track, and probe the
 * best few. Returns a playable source, or null.
 *
 * Scoring is always done against the ORIGINAL title and artist, never against
 * the query variant that found the candidate, so a track discovered via
 * "artist + movie" still has to look like the song the user actually asked
 * for. Only the stream URL is ever taken from the result; the caller keeps
 * its own metadata untouched.
 */
async function _runSearchRound(query, title, artist, quality, deadlineAt, excludeUrls, language = '') {
    if (_expired(deadlineAt)) return null;
    try {
            const [jioRes, gaanaRes, proxyRes] = await Promise.allSettled([
                _withDeadline(searchSongsDirect(query, 3).catch(() => [])
                    .then(async res => {
                        if (Array.isArray(res) && res.length > 0) return res;
                        const fallback = await searchSongsOnly(query, 1).catch(() => null);
                        return fallback?.data?.results || [];
                    }), deadlineAt, []),
                _withDeadline(searchGaanaSongsOnly(query, 3).catch(() => []), deadlineAt, []),
                // saavn.sumit.co proxy search — geo-transparent; returns pre-decrypted URLs
                requestJsonWithTimeoutExported(
                    `${SAAVN_PROXY_BASE}/api/search/songs?query=${encodeURIComponent(query)}&limit=3`,
                    { timeoutMs: Math.max(1, Math.min(5000, _msLeft(deadlineAt))), label: 'saavn-proxy search' },
                ).then(r => r?.data?.results || []).catch(() => []),
            ]);
            if (_expired(deadlineAt)) return null;

            const jioCandidates  = (jioRes.status   === 'fulfilled' && Array.isArray(jioRes.value))   ? jioRes.value   : [];
            const gaanaCandidates = (gaanaRes.status === 'fulfilled' && Array.isArray(gaanaRes.value)) ? gaanaRes.value : [];
            const proxyCandidates = (proxyRes.status === 'fulfilled' && Array.isArray(proxyRes.value)) ? proxyRes.value : [];

            const scoredCandidates = [];
            // A candidate that states a different language than the track being
            // resolved is a different recording, however well its title scores.
            const accept = cand => !_languageConflicts(language, cand);
            for (const cand of jioCandidates) {
                if (!accept(cand)) continue;
                const score = _scoreCandidate(title, artist, cand);
                if (score >= 0.45) scoredCandidates.push({ cand, score, provider: 'jiosaavn' });
            }
            for (const cand of gaanaCandidates) {
                if (!accept(cand)) continue;
                const score = _scoreCandidate(title, artist, cand);
                if (score >= 0.45) scoredCandidates.push({ cand, score, provider: 'gaana' });
            }
            // Proxy results already have pre-decrypted URLs — give them a small boost
            for (const cand of proxyCandidates) {
                if (!accept(cand)) continue;
                const score = _scoreCandidate(title, artist, cand);
                if (score >= 0.45) scoredCandidates.push({ cand, score: score + 0.05, provider: 'jiosaavn' });
            }

            // Collect top candidates from each distinct provider so a dead provider doesn't crowd out valid ones
            const topJio   = scoredCandidates.filter(c => c.provider === 'jiosaavn').slice(0, 2);
            const topGaana = scoredCandidates.filter(c => c.provider === 'gaana').slice(0, 2);
            const topCandidates = [...topJio, ...topGaana];

            if (topCandidates.length === 0) return null;

            // Race probes in parallel — return the first valid result (non-HLS preferred).
            // 2000ms timeout: CDN URLs need slightly more time than local probes.
            const probePromises = topCandidates.map(({ cand, provider }) =>
                _firstPlayableCandidate(cand, provider, { maxCandidates: 2, timeoutMs: 2000, quality, deadlineAt, excludeUrls })
            );

            // Race probes — resolve as soon as the first valid result arrives.
            // Prefer non-HLS (progressive MP4/AAC); fall back to HLS if that's all that's available.
            // This is a true race: we don't wait for slow/failing probes.
            const winner = await Promise.any(
                probePromises.map(p => p.then(r => { if (!r || r.isHls) throw new Error('skip'); return r; }))
            ).catch(() =>
                Promise.any(probePromises.map(p => p.then(r => { if (!r) throw new Error('skip'); return r; })))
                    .catch(() => null)
            );
            return winner || null;
    } catch (_) {}
    return null;
}

async function _resolveBySearch(title, artist = '', album = '', quality = DEFAULT_QUALITY, deadlineAt = null, excludeUrls = null, language = '') {
    const clean = v => String(v || '').replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '').replace(/[,\-_]/g, ' ').replace(/\s+/g, ' ').trim();
    const cleanTitle = clean(title);
    const primaryArtist = clean(String(artist || '').split(',')[0].split('&')[0]);
    // Album doubles as the film name for soundtrack releases, which is how most
    // regional cinema tracks are actually indexed.
    const cleanAlbum = clean(String(album || '').replace(/original motion picture soundtrack/ig, ''));
    const cleanLanguage = clean(language);

    const dedupe = list => [...new Set(list.filter(q => q && q.trim().length > 1))];

    // Round 1 — the cheap, high-precision queries. Unchanged in cost and order,
    // so the common path pays exactly what it paid before.
    const primaryQueries = dedupe([
        [cleanTitle, primaryArtist].filter(Boolean).join(' '),
        cleanTitle,
    ]);

    for (const query of primaryQueries) {
        if (_expired(deadlineAt)) return null;
        const winner = await _runSearchRound(query, title, artist, quality, deadlineAt, excludeUrls, cleanLanguage);
        if (winner) return winner;
    }

    // Round 2 — the wide net, and only reached when round 1 found nothing.
    //
    // A track missing under "title artist" is usually not missing from the
    // catalogues at all: it is filed under a compilation, a soundtrack release,
    // or a differently-transliterated artist credit. These variants approach it
    // from the other directions the providers actually index -- the film name,
    // the album, the language -- and they run CONCURRENTLY rather than one
    // after another, because at this point the resolution budget is nearly
    // spent and sequential rounds would simply run out of time.
    //
    // Deliberately gated behind round 1 so the extra fan-out is paid only by
    // requests that genuinely need it, never by an ordinary play.
    // Ordered most-discriminating first, because the cap below keeps the head of
    // this list. Every field the caller actually knows is used — title, artist,
    // the film (which is what `album` holds for a soundtrack) and the language —
    // and the combinations that name more of them are tried before the ones that
    // name fewer.
    //
    // Language earns its place at the top: a film released in several languages
    // reuses its songs' titles, so "title artist" alone cannot separate the Tamil
    // recording from the Malayalam one, and the provider decides which to return.
    //
    // "artist album" is last on purpose. It is the only variant with no title in
    // it, so it asks for *any* song by that artist on that release — the loosest
    // question here, and the one most able to return a different song.
    //
    // A variant whose fields are missing collapses to a shorter string, which is
    // then dropped as a duplicate of an earlier query or of round 1, so nothing
    // is wasted when metadata is thin.
    const wideQueries = dedupe([
        [cleanTitle, primaryArtist, cleanLanguage].filter(Boolean).join(' '),
        [cleanTitle, cleanAlbum, cleanLanguage].filter(Boolean).join(' '),
        [cleanTitle, primaryArtist, cleanAlbum].filter(Boolean).join(' '),
        [cleanTitle, cleanAlbum].filter(Boolean).join(' '),
        [cleanTitle, cleanLanguage].filter(Boolean).join(' '),
        [primaryArtist, cleanAlbum].filter(Boolean).join(' '),
    ]).filter(q => !primaryQueries.includes(q)).slice(0, WIDE_SEARCH_MAX_VARIANTS);

    if (wideQueries.length === 0 || _expired(deadlineAt)) return null;

    const rounds = wideQueries.map(q =>
        _runSearchRound(q, title, artist, quality, deadlineAt, excludeUrls, cleanLanguage),
    );
    return _firstTruthy(rounds, deadlineAt);
}

/**
 * Unified Stream Resolution Engine
 *
 * Resolves a validated, playable direct audio stream URL with headers.
 * Guaranteed response time under 2.5s when upstream source is active.
 *
 * @param {object} params - { id, title, artist, album, language }
 * @returns {Promise<object>}
 */
export async function resolvePlayableStream(params = {}) {
    const startTime = Date.now();
    const songId = String(params.id || '').trim();
    const songTitle = String(params.title || '').trim();
    const songArtist = String(params.artist || '').trim();
    const songAlbum = String(params.album || '').trim();
    // Language is a retrieval hint for the wide-net recovery search only; it
    // never affects the metadata returned to the caller.
    const songLanguage = String(params.language || '').trim();
    const quality = normalizeQuality(params.quality);

    // URLs the caller has already seen fail. Everything downstream skips them,
    // so a re-resolve after a dead stream is guaranteed to try a different
    // candidate — a different bitrate, or a different provider entirely —
    // rather than confidently handing back the URL that just 404'd.
    const excludeUrls = new Set(
        (Array.isArray(params.excludeUrls) ? params.excludeUrls : [])
            .map(u => String(u || '').trim())
            .filter(Boolean),
    );

    if (!songId && !songTitle) {
        throw new PlaybackResolveError('Song ID or title is required for resolution', 'BAD_REQUEST');
    }

    const trackKey = generateTrackKey(songId, songTitle, songArtist, songAlbum, songLanguage);
    const lockKey = _cacheKey(trackKey, quality);

    // 1. Fast Memory Cache Check (Instant 0ms) — per quality tier
    // Skipped when the cached URL is one of the failed ones: serving it again
    // would turn the retry into an instant repeat of the same failure.
    const cached = getCachedStream(trackKey, quality);
    if (cached && cached.streamUrl && excludeUrls.has(cached.streamUrl)) {
        invalidateStreamCache(trackKey, quality);
    } else if (cached && cached.streamUrl) {
        return {
            id: trackKey,
            title: songTitle || cached.title,
            artist: songArtist || cached.artist,
            streamUrl: cached.streamUrl,
            proxyUrl: `/api/stream/${trackKey}`,
            bitrate: cached.bitrate || '320kbps',
            quality,
            contentType: cached.contentType || 'audio/mp4',
            isHls: cached.isHls || false,
            headers: getHeadersForStreamUrl(cached.streamUrl),
            isPlayable: true,
            provider: cached.provider || 'jiosaavn',
            expiresIn: Math.max(60, Math.round(((cached.expiresAt || 0) - Date.now()) / 1000)),
            resolvedAt: new Date(cached.cachedAt || Date.now()).toISOString(),
            cached: true,
        };
    }

    // 2. Single-flight lock: deduplicate concurrent requests for the same track+tier
    //
    // A retry carrying exclusions must NOT join an in-flight resolve: that
    // resolve was started without them and can only return the very URL the
    // caller is retrying away from. Such requests run on their own so the
    // failover is real, and they do not publish a lock of their own either —
    // their answer is deliberately narrower than the general one.
    if (excludeUrls.size === 0) {
        const activeLock = inFlightResolves.get(lockKey);
        if (activeLock) {
            return activeLock;
        }
    }

    // A recovery resolve — one carrying URLs the client has already watched
    // fail — is both more urgent and less likely to be answered by the direct
    // lane, so it gets the wider budget and skips the head start below.
    const isRecovery = excludeUrls.size > 0;
    const deadlineAt = startTime + (isRecovery ? RECOVERY_BUDGET_MS : RESOLVE_BUDGET_MS);

    const workPromise = (async () => {
        // Step A: Direct lookup by ID if available.
        const directPromise = _resolveDirectById(songId, quality, deadlineAt, excludeUrls).catch(() => null);

        // Give the accurate lane a short head start of its own — but not on a
        // recovery resolve. There, the direct lane has already produced a URL
        // that did not play; spending the head start waiting for it to offer
        // another one is exactly the delay the client is trying to escape, so
        // the cross-provider search starts in the same tick.
        let winner = isRecovery
            ? null
            : await _withDeadline(
                directPromise,
                Math.min(startTime + SEARCH_HEDGE_AFTER_MS, deadlineAt),
                null,
            );

        // Step B: Hedge with a fallback search. This runs ALONGSIDE the direct
        // lookup rather than after it — waiting for direct to fully give up
        // meant a slow provider consumed the entire budget and the search never
        // ran at all, which is what turned a resolvable track into a timeout.
        if (!winner) {
            let searchTitle = songTitle;
            let searchArtist = songArtist;
            let searchAlbum = songAlbum;

            if (!searchTitle && songId) {
                let dbTrack = null;
                try { dbTrack = getTrack(songId); } catch (_) {}
                if (dbTrack) {
                    searchTitle = dbTrack.title || dbTrack.name || '';
                    searchArtist = dbTrack.artist || '';
                    searchAlbum = dbTrack.album || '';
                }
            }

            const racers = [directPromise];
            if (searchTitle.length > 0 || searchArtist.length > 0) {
                racers.push(
                    _resolveBySearch(searchTitle, searchArtist, searchAlbum, quality, deadlineAt, excludeUrls, songLanguage)
                        .catch(() => null),
                );
            }
            winner = await _firstTruthy(racers, deadlineAt);
        }

        if (!winner || !winner.streamUrl) {
            const elapsed = Date.now() - startTime;
            const code = elapsed >= RESOLVE_BUDGET_MS ? 'TIMEOUT' : 'STREAM_NOT_FOUND';
            console.error(`[StreamResolver] No stream found for "${songTitle || songId}" after ${elapsed}ms (${code})`);
            throw new PlaybackResolveError(
                code === 'TIMEOUT'
                    ? `Resolution timed out for "${songTitle || songId}"`
                    : `No playable stream found for "${songTitle || songId}"`,
                code,
            );
        }

        const headers = getHeadersForStreamUrl(winner.streamUrl);
        const resolvedData = {
            id: trackKey,
            title: songTitle,
            artist: songArtist,
            streamUrl: winner.streamUrl,
            proxyUrl: `/api/stream/${trackKey}`,
            bitrate: winner.quality || '320kbps',
            quality,
            contentType: winner.contentType || 'audio/mp4',
            isHls: winner.isHls || false,
            headers,
            isPlayable: true,
            provider: winner.provider,
            expiresIn: Math.round(STREAM_CACHE_TTL_MS / 1000),
            resolvedAt: new Date().toISOString(),
            cached: false,
        };

        // Cache the verified playable stream under its quality tier
        setCachedStream(trackKey, {
            ...resolvedData,
            title: songTitle,
            artist: songArtist,
        }, quality);

        return resolvedData;
    })();

    // The lock is held for the lifetime of the real work, not just until the
    // caller's timeout fires — otherwise a client retry at 7s would start a
    // second full pipeline while the first is still running, and each retry
    // would pile more concurrent upstream work onto the same track.
    workPromise.catch(() => {}).finally(() => {
        inFlightResolves.delete(lockKey);
    });
    // Only a general (exclusion-free) resolve may be shared with other callers.
    if (excludeUrls.size === 0) {
        inFlightResolves.set(lockKey, workPromise);
    }
    return workPromise;
}

/**
 * Backward compatibility wrapper for canonical catalog routes (`/v1/catalog/resolve/:id`)
 */
export async function resolveStream(canonicalId, opts = {}) {
    let track;
    try {
        track = opts.overrideTrack || getTrack(canonicalId);
    } catch (_) {
        track = null;
    }
    const resolved = await resolvePlayableStream({
        id: canonicalId,
        title: track?.title ?? opts.overrideTrack?.title ?? '',
        artist: track?.artist_name ?? track?.artist ?? opts.overrideTrack?.artist_name ?? '',
        album: track?.album_name ?? track?.album ?? opts.overrideTrack?.album_name ?? '',
        language: track?.language ?? opts.overrideTrack?.language ?? '',
        quality: opts.quality,
    });

    return {
        url: resolved.streamUrl,
        quality: resolved.bitrate,
        provider: resolved.provider,
        canonicalId,
        confidence: 100,
        validationStatus: 'verified-playable',
        resolvedAt: resolved.resolvedAt,
    };
}

export function evictStream(trackKey) {
    invalidateStreamCache(trackKey);
}

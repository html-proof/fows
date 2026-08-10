/**
 * Identity Resolver — canonical track/artist/album catalog with provider mappings.
 *
 * Owns a SQLite database that is the single source of truth for track identity.
 * Every song that passes through the system gets a canonical ID.
 * Provider-specific IDs (iTunes, JioSaavn) are stored as secondary mappings.
 *
 * Canonical ID format:
 *   trk_<12-hex>   artist_<12-hex>   alb_<12-hex>
 */

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normText, bigramSimilarity } from './searchEngine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'catalog.db');

mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ─── Open DB ──────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
    CREATE TABLE IF NOT EXISTS artists (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        norm_name   TEXT NOT NULL,
        image_url   TEXT,
        genres      TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS albums (
        id           TEXT PRIMARY KEY,
        artist_id    TEXT REFERENCES artists(id),
        title        TEXT NOT NULL,
        norm_title   TEXT NOT NULL,
        artwork_url  TEXT,
        release_year INTEGER,
        genre        TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tracks (
        id           TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        norm_title   TEXT NOT NULL,
        artist_id    TEXT REFERENCES artists(id),
        album_id     TEXT REFERENCES albums(id),
        artist_name  TEXT,
        album_name   TEXT,
        artwork_url  TEXT,
        duration_ms  INTEGER,
        isrc         TEXT,
        release_year INTEGER,
        language     TEXT,
        genre        TEXT,
        is_explicit  INTEGER DEFAULT 0,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_isrc
        ON tracks(isrc) WHERE isrc IS NOT NULL AND isrc != '';

    CREATE INDEX IF NOT EXISTS idx_tracks_norm
        ON tracks(norm_title, artist_name);

    CREATE TABLE IF NOT EXISTS provider_maps (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id           TEXT NOT NULL REFERENCES tracks(id),
        provider           TEXT NOT NULL,
        provider_track_id  TEXT NOT NULL,
        provider_album_id  TEXT,
        provider_artist_id TEXT,
        confidence         INTEGER NOT NULL DEFAULT 0,
        last_verified_at   INTEGER,
        UNIQUE(provider, provider_track_id)
    );

    CREATE INDEX IF NOT EXISTS idx_pmap_track ON provider_maps(track_id, provider);

    CREATE TABLE IF NOT EXISTS stream_cache (
        track_id   TEXT NOT NULL,
        provider   TEXT NOT NULL DEFAULT 'jiosaavn',
        url        TEXT NOT NULL,
        quality    TEXT,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (track_id, provider)
    );
`);

// ─── Prepared statements ──────────────────────────────────────────────────────

const stmts = {
    getProviderMap:   db.prepare('SELECT track_id, confidence FROM provider_maps WHERE provider = ? AND provider_track_id = ?'),
    touchProviderMap: db.prepare('UPDATE provider_maps SET last_verified_at = ? WHERE provider = ? AND provider_track_id = ?'),
    getByIsrc:        db.prepare('SELECT id FROM tracks WHERE isrc = ?'),
    getCandidates:    db.prepare('SELECT id, norm_title, artist_name, album_name, duration_ms FROM tracks WHERE norm_title LIKE ? LIMIT 20'),
    insertArtist:     db.prepare('INSERT OR IGNORE INTO artists (id, name, norm_name, image_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'),
    insertAlbum:      db.prepare('INSERT OR IGNORE INTO albums (id, artist_id, title, norm_title, artwork_url, release_year, genre, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    insertTrack:      db.prepare('INSERT OR IGNORE INTO tracks (id, title, norm_title, artist_id, album_id, artist_name, album_name, artwork_url, duration_ms, isrc, release_year, language, genre, is_explicit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    insertProviderMap:db.prepare('INSERT OR IGNORE INTO provider_maps (track_id, provider, provider_track_id, provider_album_id, provider_artist_id, confidence, last_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    upgradeIsrc:      db.prepare("UPDATE tracks SET isrc = ?, updated_at = ? WHERE id = ? AND (isrc IS NULL OR isrc = '')"),
    upgradeArtwork:   db.prepare('UPDATE tracks SET artwork_url = ?, updated_at = ? WHERE id = ? AND artwork_url IS NULL'),
    upgradeGenre:     db.prepare('UPDATE tracks SET genre = ?, updated_at = ? WHERE id = ? AND genre IS NULL'),
    getTrack:         db.prepare('SELECT * FROM tracks WHERE id = ?'),
    getMappings:      db.prepare('SELECT * FROM provider_maps WHERE track_id = ?'),
    getProviderTrackId: db.prepare('SELECT provider_track_id FROM provider_maps WHERE track_id = ? AND provider = ?'),
    getStreamCache:   db.prepare('SELECT url, quality, expires_at FROM stream_cache WHERE track_id = ? AND provider = ?'),
    upsertStreamCache:db.prepare('INSERT OR REPLACE INTO stream_cache (track_id, provider, url, quality, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    delStreamCache:   db.prepare('DELETE FROM stream_cache WHERE track_id = ? AND provider = ?'),
};

// ─── ID helpers ───────────────────────────────────────────────────────────────

function sha1hex(s) { return createHash('sha1').update(s).digest('hex'); }
function makeTrackId(seed)         { return 'trk_'  + sha1hex(seed).slice(0, 12); }
function makeArtistId(normName)    { return 'art_'  + sha1hex(normName).slice(0, 12); }
function makeAlbumId(artId, title) { return 'alb_'  + sha1hex(artId + ':' + normText(title)).slice(0, 12); }

// ─── Core: resolve or create ──────────────────────────────────────────────────

/**
 * Map any provider song to a canonical track ID, creating one if needed.
 *
 * @param {object} meta  - { title, artist, album, durationMs, isrc, releaseYear, language, genre, artworkUrl, isExplicit }
 * @param {string} provider         - 'jiosaavn' | 'itunes'
 * @param {string} providerTrackId
 * @param {string} [providerAlbumId]
 * @param {string} [providerArtistId]
 * @returns {{ canonicalId: string, confidence: number, isNew: boolean }}
 */
export function resolveOrCreate(meta, provider, providerTrackId, providerAlbumId = null, providerArtistId = null) {
    // Already mapped?
    const existing = stmts.getProviderMap.get(provider, providerTrackId);
    if (existing) {
        stmts.touchProviderMap.run(Date.now(), provider, providerTrackId);
        return { canonicalId: existing.track_id, confidence: existing.confidence, isNew: false };
    }

    const found = _findExisting(meta);

    let canonicalId, confidence, isNew;

    if (found) {
        canonicalId = found.id;
        confidence  = found.score;
        isNew       = false;
        _upgradeIfBetter(canonicalId, meta);
    } else {
        canonicalId = _create(meta);
        confidence  = 100;
        isNew       = true;
    }

    stmts.insertProviderMap.run(canonicalId, provider, providerTrackId, providerAlbumId, providerArtistId, confidence, Date.now());
    return { canonicalId, confidence, isNew };
}

function _findExisting(meta) {
    const nt = normText(meta.title ?? '');
    const na = normText(meta.artist ?? '');

    if (meta.isrc) {
        const r = stmts.getByIsrc.get(meta.isrc);
        if (r) return { id: r.id, score: 100 };
    }

    const prefix = nt.slice(0, 15);
    const candidates = stmts.getCandidates.all(`${prefix}%`);

    let best = null, bestScore = -1;
    for (const c of candidates) {
        const ts = bigramSimilarity(nt, normText(c.norm_title));
        const as = bigramSimilarity(na, normText(c.artist_name ?? ''));
        if (ts < 0.72 || as < 0.45) continue;

        let score = ts * 55 + as * 35;
        if (meta.durationMs && c.duration_ms) {
            const diff = Math.abs((meta.durationMs - c.duration_ms) / 1000);
            if (diff <= 5)       score += 15;
            else if (diff <= 20) score += 8;
            else if (diff > 60)  score -= 20;
        }
        if (score > bestScore) { bestScore = score; best = { id: c.id, score }; }
    }

    return (best && best.score >= 50) ? best : null;
}

function _create(meta) {
    const now = Date.now();
    const nt = normText(meta.title ?? '');

    const artistId = makeArtistId(normText(meta.artist ?? 'unknown'));
    stmts.insertArtist.run(artistId, meta.artist ?? '', normText(meta.artist ?? ''), null, now, now);

    let albumId = null;
    if (meta.album) {
        albumId = makeAlbumId(artistId, meta.album);
        stmts.insertAlbum.run(albumId, artistId, meta.album, normText(meta.album),
            meta.artworkUrl ?? null, meta.releaseYear ?? null, meta.genre ?? null, now, now);
    }

    const seed = meta.isrc || `${nt}|${normText(meta.artist ?? '')}|${meta.durationMs ?? 0}`;
    const trackId = makeTrackId(seed);

    stmts.insertTrack.run(
        trackId, meta.title ?? '', nt, artistId, albumId,
        meta.artist ?? '', meta.album ?? '',
        meta.artworkUrl ?? null,
        meta.durationMs ?? null,
        meta.isrc || null,
        meta.releaseYear ?? null,
        meta.language ?? null,
        meta.genre ?? null,
        meta.isExplicit ? 1 : 0,
        now, now,
    );
    return trackId;
}

function _upgradeIfBetter(trackId, meta) {
    const now = Date.now();
    if (meta.isrc)       stmts.upgradeIsrc.run(meta.isrc, now, trackId);
    if (meta.artworkUrl) stmts.upgradeArtwork.run(meta.artworkUrl, now, trackId);
    if (meta.genre)      stmts.upgradeGenre.run(meta.genre, now, trackId);
}

// ─── Lookups ──────────────────────────────────────────────────────────────────

export function getTrack(canonicalId) {
    return stmts.getTrack.get(canonicalId) ?? null;
}

export function getProviderMappings(canonicalId) {
    return stmts.getMappings.all(canonicalId);
}

export function getProviderTrackId(canonicalId, provider) {
    return stmts.getProviderTrackId.get(canonicalId, provider)?.provider_track_id ?? null;
}

// ─── Stream cache ─────────────────────────────────────────────────────────────

const STREAM_TTL_MS = 25 * 60 * 1000; // 25 min (JioSaavn URLs expire ~30 min)

export function cacheStreamUrl(canonicalId, url, quality = '96kbps', provider = 'jiosaavn') {
    stmts.upsertStreamCache.run(canonicalId, provider, url, quality, Date.now() + STREAM_TTL_MS, Date.now());
}

export function getCachedStreamUrl(canonicalId, provider = 'jiosaavn') {
    const row = stmts.getStreamCache.get(canonicalId, provider);
    if (!row || row.expires_at < Date.now()) return null;
    return { url: row.url, quality: row.quality };
}

export function invalidateStreamCache(canonicalId, provider = 'jiosaavn') {
    stmts.delStreamCache.run(canonicalId, provider);
}

// ─── Batch helper ─────────────────────────────────────────────────────────────

/**
 * Attach canonical IDs to an array of enriched JioSaavn songs.
 * Safe to call in a hot search path — uses SQLite transactions for perf.
 *
 * @param {object[]} songs - JioSaavn song objects (with optional itunesMeta)
 * @returns {object[]} - same songs with `canonicalId` string added
 */
export function attachCanonicalIds(songs) {
    const attach = db.transaction((songs) => songs.map(song => {
        const provId = song.id ?? song.songId ?? '';
        if (!provId) return { ...song, canonicalId: null };

        const meta = _saavnToMeta(song);
        const { canonicalId } = resolveOrCreate(
            meta, 'jiosaavn', provId,
            song.albumId ?? song.album?.id ?? null,
            song.artistId ?? null,
        );

        // Also register iTunes mapping if enriched
        if (song.itunesMeta?.id) {
            resolveOrCreate(
                { ...meta, artworkUrl: song.itunesMeta.artwork, genre: song.itunesMeta.genre, releaseYear: song.itunesMeta.year },
                'itunes', String(song.itunesMeta.id),
            );
        }

        return { ...song, canonicalId };
    }));

    return attach(songs);
}

function _saavnToMeta(song) {
    const artist = Array.isArray(song.artists?.primary)
        ? song.artists.primary.map(a => a.name ?? '').join(', ')
        : (song.primaryArtists ?? song.artist ?? '');

    const album = typeof song.album === 'string' ? song.album
        : (song.album?.name ?? song.albumName ?? '');

    const artworkUrl = song.itunesMeta?.artwork
        ?? (Array.isArray(song.image)
            ? (song.image.find(i => i.quality === '500x500')?.url ?? song.image[0]?.url)
            : null)
        ?? song.image ?? null;

    return {
        title:       song.name ?? song.title ?? '',
        artist,
        album,
        durationMs:  (parseInt(song.duration ?? 0, 10) || 0) * 1000,
        language:    song.language ?? null,
        genre:       song.itunesMeta?.genre ?? null,
        artworkUrl,
        releaseYear: song.itunesMeta?.year ?? (song.year ? parseInt(song.year, 10) : null),
        isExplicit:  song.itunesMeta?.isExplicit ?? false,
    };
}

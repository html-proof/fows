/**
 * Single Canonical Metadata Service
 *
 * Provides a single source of truth for normalizing song, album, and artist
 * metadata across all API endpoints (search, catalog, albums, trending, recommendations).
 */

/**
 * Normalize any raw song metadata object into the single canonical schema.
 *
 * @param {object} rawSong
 * @param {object} [options]
 * @returns {object|null}
 */
export function normalizeSongMetadata(rawSong, options = {}) {
    if (!rawSong || typeof rawSong !== 'object') return null;

    // 1. Standardize IDs
    const canonicalId = rawSong.canonicalId || rawSong.canonicalSongId || null;
    const providerId = rawSong.id || rawSong.songId || rawSong.track_id || rawSong.providerTrackId || '';
    const id = canonicalId || providerId || '';

    // 2. Standardize Title / Name
    const title = String(rawSong.name || rawSong.title || rawSong.song_title || 'Unknown').trim();

    // 3. Standardize Artists
    let artistName = '';
    let artistsArray = [];
    if (Array.isArray(rawSong.artists?.primary)) {
        artistsArray = rawSong.artists.primary.map(a => ({
            id: a.id || null,
            name: String(a.name || '').trim(),
            role: a.role || 'primary_artists',
        }));
        artistName = artistsArray.map(a => a.name).filter(Boolean).join(', ');
    } else if (Array.isArray(rawSong.primaryArtists)) {
        artistsArray = rawSong.primaryArtists.map(a => ({
            id: a.id || null,
            name: String(typeof a === 'string' ? a : a.name || '').trim(),
            role: 'primary_artists',
        }));
        artistName = artistsArray.map(a => a.name).filter(Boolean).join(', ');
    } else if (typeof rawSong.primaryArtists === 'string') {
        artistName = rawSong.primaryArtists.trim();
        artistsArray = [{ id: null, name: artistName, role: 'primary_artists' }];
    } else if (typeof rawSong.artist === 'string') {
        artistName = rawSong.artist.trim();
        artistsArray = [{ id: null, name: artistName, role: 'primary_artists' }];
    } else if (typeof rawSong.artist_name === 'string') {
        artistName = rawSong.artist_name.trim();
        artistsArray = [{ id: null, name: artistName, role: 'primary_artists' }];
    }

    // 4. Standardize Album
    let albumName = '';
    let albumId = null;
    if (typeof rawSong.album === 'object' && rawSong.album !== null) {
        albumName = String(rawSong.album.name || rawSong.album.title || '').trim();
        albumId = rawSong.album.id || null;
    } else if (typeof rawSong.album === 'string') {
        albumName = rawSong.album.trim();
    } else if (typeof rawSong.album_name === 'string') {
        albumName = rawSong.album_name.trim();
    }
    albumId = albumId || rawSong.albumId || rawSong.sourceAlbumId || null;

    // 5. Standardize Duration
    let durationSeconds = 0;
    if (Number.isFinite(rawSong.duration)) {
        durationSeconds = Math.max(0, Math.round(rawSong.duration));
    } else if (typeof rawSong.duration === 'string') {
        durationSeconds = Math.max(0, parseInt(rawSong.duration, 10) || 0);
    } else if (rawSong.duration_ms || rawSong.durationMs) {
        durationSeconds = Math.max(0, Math.round((rawSong.duration_ms || rawSong.durationMs) / 1000));
    }

    // 6. Standardize Artwork / Image (preferred high-resolution)
    let imageUrl = '';
    if (typeof rawSong.artwork_max === 'string' && rawSong.artwork_max.trim()) {
        imageUrl = rawSong.artwork_max.trim();
    } else if (typeof rawSong.itunesArtwork === 'string' && rawSong.itunesArtwork.trim()) {
        imageUrl = rawSong.itunesArtwork.trim();
    } else if (typeof rawSong.artworkUrl === 'string' && rawSong.artworkUrl.trim()) {
        imageUrl = rawSong.artworkUrl.trim();
    } else if (typeof rawSong.artwork === 'string' && rawSong.artwork.trim()) {
        imageUrl = rawSong.artwork.trim();
    } else if (typeof rawSong.album_art === 'string' && rawSong.album_art.trim()) {
        imageUrl = rawSong.album_art.trim();
    } else if (Array.isArray(rawSong.image) && rawSong.image.length > 0) {
        const found500 = rawSong.image.find(img => img?.quality === '500x500' || img?.quality === 'high');
        const candidate = found500?.url
            || (typeof rawSong.image[rawSong.image.length - 1] === 'string' ? rawSong.image[rawSong.image.length - 1] : rawSong.image[rawSong.image.length - 1]?.url)
            || (typeof rawSong.image[0] === 'string' ? rawSong.image[0] : rawSong.image[0]?.url)
            || '';
        imageUrl = String(candidate).trim();
    } else if (typeof rawSong.imageUrl === 'string') {
        imageUrl = rawSong.imageUrl.trim();
    } else if (typeof rawSong.image_url === 'string') {
        imageUrl = rawSong.image_url.trim();
    } else if (typeof rawSong.image === 'string') {
        imageUrl = rawSong.image.trim();
    }

    if (imageUrl.startsWith('http://')) {
        imageUrl = imageUrl.replace(/^http:\/\//, 'https://');
    }
    if (imageUrl.includes('50x50.jpg') || imageUrl.includes('150x150.jpg')) {
        imageUrl = imageUrl.replace(/(50x50|150x150)\.jpg/g, '500x500.jpg');
    }

    // 7. Standardize Stream and Download URLs
    let streamUrl = rawSong.streamUrl || rawSong.stream_url || null;
    let downloadUrl = Array.isArray(rawSong.downloadUrl) ? rawSong.downloadUrl : [];
    if (!streamUrl && downloadUrl.length > 0) {
        streamUrl = downloadUrl.find(d => d.quality === '320kbps')?.url
            || downloadUrl[downloadUrl.length - 1]?.url
            || null;
    }
    if (streamUrl && downloadUrl.length === 0) {
        downloadUrl = [
            { quality: '320kbps', url: streamUrl },
            { quality: '160kbps', url: streamUrl },
            { quality: '96kbps', url: streamUrl },
        ];
    }

    const isExplicit = Boolean(
        rawSong.isExplicit || rawSong.explicitContent || rawSong.explicit_content || rawSong.is_explicit
    );

    const isAvailable = rawSong.isPlayable !== false &&
        rawSong.isAvailable !== false &&
        rawSong.status !== 'unavailable';

    return {
        id,
        canonicalId: canonicalId || (id.startsWith('trk_') ? id : null),
        providerId: providerId || id,
        name: title,
        title,
        artist: artistName || 'Unknown Artist',
        primaryArtists: artistName || 'Unknown Artist',
        artists: artistsArray,
        album: albumName,
        albumId,
        duration: durationSeconds,
        durationMs: durationSeconds * 1000,
        imageUrl,
        image: Array.isArray(rawSong.image)
            ? rawSong.image
            : (imageUrl ? [{ quality: '500x500', url: imageUrl }] : []),
        artwork: imageUrl,
        language: rawSong.language || null,
        year: rawSong.year ? String(rawSong.year) : (rawSong.release_year ? String(rawSong.release_year) : null),
        isExplicit,
        isOfficial: rawSong.isOfficial !== false && rawSong.is_official !== false,
        isPlayable: isAvailable,
        isAvailable,
        streamUrl,
        downloadUrl,
        hasLyrics: Boolean(rawSong.hasLyrics || rawSong.has_lyrics),
        isrc: rawSong.isrc || null,
    };
}

/**
 * Normalize an array of songs.
 */
export function normalizeSongList(songs) {
    if (!Array.isArray(songs)) return [];
    return songs
        .map(song => normalizeSongMetadata(song))
        .filter(Boolean);
}

/**
 * Normalize an album metadata object into the single canonical schema.
 */
export function normalizeAlbumMetadata(rawAlbum) {
    if (!rawAlbum || typeof rawAlbum !== 'object') return null;

    const id = String(rawAlbum.id || rawAlbum.albumId || rawAlbum.album_id || '').trim();
    const name = String(rawAlbum.name || rawAlbum.title || rawAlbum.album || 'Unknown Album').trim();

    let artist = '';
    if (Array.isArray(rawAlbum.artists?.primary)) {
        artist = rawAlbum.artists.primary.map(a => a.name || '').filter(Boolean).join(', ');
    } else if (Array.isArray(rawAlbum.primaryArtists)) {
        artist = rawAlbum.primaryArtists.map(a => typeof a === 'string' ? a : a.name || '').filter(Boolean).join(', ');
    } else if (typeof rawAlbum.primaryArtists === 'string') {
        artist = rawAlbum.primaryArtists.trim();
    } else if (typeof rawAlbum.artist === 'string') {
        artist = rawAlbum.artist.trim();
    } else if (typeof rawAlbum.artist_name === 'string') {
        artist = rawAlbum.artist_name.trim();
    }

    let imageUrl = '';
    if (typeof rawAlbum.artwork_max === 'string' && rawAlbum.artwork_max.trim()) {
        imageUrl = rawAlbum.artwork_max.trim();
    } else if (typeof rawAlbum.artworkUrl === 'string' && rawAlbum.artworkUrl.trim()) {
        imageUrl = rawAlbum.artworkUrl.trim();
    } else if (typeof rawAlbum.artwork === 'string' && rawAlbum.artwork.trim()) {
        imageUrl = rawAlbum.artwork.trim();
    } else if (Array.isArray(rawAlbum.image) && rawAlbum.image.length > 0) {
        const found500 = rawAlbum.image.find(img => img?.quality === '500x500' || img?.quality === 'high');
        const candidate = found500?.url
            || (typeof rawAlbum.image[rawAlbum.image.length - 1] === 'string' ? rawAlbum.image[rawAlbum.image.length - 1] : rawAlbum.image[rawAlbum.image.length - 1]?.url)
            || (typeof rawAlbum.image[0] === 'string' ? rawAlbum.image[0] : rawAlbum.image[0]?.url)
            || '';
        imageUrl = String(candidate).trim();
    } else if (typeof rawAlbum.imageUrl === 'string') {
        imageUrl = rawAlbum.imageUrl.trim();
    } else if (typeof rawAlbum.image === 'string') {
        imageUrl = rawAlbum.image.trim();
    }

    if (!imageUrl && Array.isArray(rawAlbum.songs) && rawAlbum.songs.length > 0) {
        const firstSong = rawAlbum.songs[0];
        if (typeof firstSong.imageUrl === 'string' && firstSong.imageUrl.trim()) {
            imageUrl = firstSong.imageUrl.trim();
        } else if (typeof firstSong.artwork === 'string' && firstSong.artwork.trim()) {
            imageUrl = firstSong.artwork.trim();
        } else if (Array.isArray(firstSong.image) && firstSong.image.length > 0) {
            const found500 = firstSong.image.find(img => img?.quality === '500x500' || img?.quality === 'high');
            const candidate = found500?.url
                || (typeof firstSong.image[firstSong.image.length - 1] === 'string' ? firstSong.image[firstSong.image.length - 1] : firstSong.image[firstSong.image.length - 1]?.url)
                || (typeof firstSong.image[0] === 'string' ? firstSong.image[0] : firstSong.image[0]?.url)
                || '';
            imageUrl = String(candidate).trim();
        }
    }

    if (imageUrl.startsWith('http://')) {
        imageUrl = imageUrl.replace(/^http:\/\//, 'https://');
    }
    if (imageUrl.includes('50x50.jpg') || imageUrl.includes('150x150.jpg')) {
        imageUrl = imageUrl.replace(/(50x50|150x150)\.jpg/g, '500x500.jpg');
    }

    const year = rawAlbum.year ? String(rawAlbum.year) : (rawAlbum.release_year ? String(rawAlbum.release_year) : null);
    const songCount = Number(rawAlbum.songCount || rawAlbum.song_count || (Array.isArray(rawAlbum.songs) ? rawAlbum.songs.length : 0)) || 0;
    const songs = Array.isArray(rawAlbum.songs) ? normalizeSongList(rawAlbum.songs) : [];

    return {
        id,
        name,
        title: name,
        artist: artist || 'Various Artists',
        primaryArtists: artist || 'Various Artists',
        year,
        language: rawAlbum.language || null,
        songCount: songCount || songs.length,
        imageUrl,
        artwork: imageUrl,
        image: Array.isArray(rawAlbum.image)
            ? rawAlbum.image
            : (imageUrl ? [{ quality: '500x500', url: imageUrl }] : []),
        songs,
        type: rawAlbum.type || rawAlbum.header_desc || 'album',
        url: rawAlbum.url || rawAlbum.perma_url || null,
    };
}

export function normalizeAlbumList(albums) {
    if (!Array.isArray(albums)) return [];
    return albums.map(a => normalizeAlbumMetadata(a)).filter(Boolean);
}

/**
 * Normalize artist metadata into canonical schema.
 */
export function normalizeArtistMetadata(rawArtist) {
    if (!rawArtist || typeof rawArtist !== 'object') return null;

    const id = String(rawArtist.id || rawArtist.artistId || rawArtist.artist_id || '').trim();
    const name = String(rawArtist.name || rawArtist.title || 'Unknown Artist').trim();

    let imageUrl = '';
    if (Array.isArray(rawArtist.image) && rawArtist.image.length > 0) {
        const found500 = rawArtist.image.find(img => img?.quality === '500x500' || img?.quality === 'high');
        const candidate = found500?.url
            || (typeof rawArtist.image[rawArtist.image.length - 1] === 'string' ? rawArtist.image[rawArtist.image.length - 1] : rawArtist.image[rawArtist.image.length - 1]?.url)
            || (typeof rawArtist.image[0] === 'string' ? rawArtist.image[0] : rawArtist.image[0]?.url)
            || '';
        imageUrl = String(candidate).trim();
    } else if (typeof rawArtist.imageUrl === 'string') {
        imageUrl = rawArtist.imageUrl.trim();
    } else if (typeof rawArtist.image === 'string') {
        imageUrl = rawArtist.image.trim();
    }

    if (imageUrl.startsWith('http://')) {
        imageUrl = imageUrl.replace(/^http:\/\//, 'https://');
    }
    if (imageUrl.includes('50x50.jpg') || imageUrl.includes('150x150.jpg')) {
        imageUrl = imageUrl.replace(/(50x50|150x150)\.jpg/g, '500x500.jpg');
    }

    return {
        id,
        name,
        role: rawArtist.role || 'artist',
        imageUrl,
        image: Array.isArray(rawArtist.image)
            ? rawArtist.image
            : (imageUrl ? [{ quality: '500x500', url: imageUrl }] : []),
        followerCount: Number(rawArtist.followerCount || rawArtist.follower_count || 0),
        isRadioPresent: Boolean(rawArtist.isRadioPresent || rawArtist.is_radio_present),
    };
}

export function normalizeArtistList(artists) {
    if (!Array.isArray(artists)) return [];
    return artists.map(a => normalizeArtistMetadata(a)).filter(Boolean);
}

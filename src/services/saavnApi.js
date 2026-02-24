import { request } from 'undici';

const BASE_URL = 'https://saavn.sumit.co';
const FALLBACK_BASE_URL = 'https://saavnapi-nine.vercel.app';

export async function searchSongs(query, page = 1) {
    const { statusCode, body } = await request(
        `${BASE_URL}/api/search?query=${encodeURIComponent(query)}&page=${page}`
    );
    if (statusCode !== 200) throw new Error(`Saavn search failed with status ${statusCode}`);
    return body.json();
}

export async function searchSongsOnly(query, page = 1) {
    const { statusCode, body } = await request(
        `${BASE_URL}/api/search/songs?query=${encodeURIComponent(query)}&page=${page}`
    );
    if (statusCode !== 200) throw new Error(`Saavn song search failed with status ${statusCode}`);
    return body.json();
}

/**
 * Fallback song search using alternate provider.
 * Response is normalized into the same shape expected by current clients.
 *
 * @param {string} query
 * @returns {Promise<object[]>}
 */
export async function searchSongsOnlyFallback(query) {
    const { statusCode, body } = await request(
        `${FALLBACK_BASE_URL}/result/?query=${encodeURIComponent(query)}`
    );
    if (statusCode !== 200) {
        throw new Error(`Fallback song search failed with status ${statusCode}`);
    }

    const payload = await body.json();
    if (!Array.isArray(payload)) return [];

    return payload
        .map(normalizeFallbackSong)
        .filter(song => song && song.id && song.name);
}

/**
 * Get song details by ID.
 * @param {string} id - Song ID
 * @returns {Promise<object>} Song details
 */
export async function getSongById(id) {
    const { statusCode, body } = await request(
        `${BASE_URL}/api/songs/${encodeURIComponent(id)}`
    );
    if (statusCode !== 200) throw new Error(`Saavn song fetch failed with status ${statusCode}`);
    return body.json();
}

/**
 * Get album details by ID.
 * @param {string} id - Album ID
 * @returns {Promise<object>} Album details
 */
export async function getAlbumById(id) {
    const { statusCode, body } = await request(
        `${BASE_URL}/api/albums?id=${encodeURIComponent(id)}`
    );
    if (statusCode !== 200) throw new Error(`Saavn album fetch failed with status ${statusCode}`);
    return body.json();
}

/**
 * Search for albums.
 * @param {string} query - Search query
 * @returns {Promise<object>} Album search results
 */
export async function searchAlbums(query) {
    const { statusCode, body } = await request(
        `${BASE_URL}/api/search/albums?query=${encodeURIComponent(query)}`
    );
    if (statusCode !== 200) throw new Error(`Saavn album search failed with status ${statusCode}`);
    return body.json();
}

/**
 * Search for artists.
 * @param {string} query - Artist name or query
 * @returns {Promise<object>} Artist search results
 */
export async function searchArtists(query) {
    const { statusCode, body } = await request(
        `${BASE_URL}/api/search/artists?query=${encodeURIComponent(query)}`
    );
    if (statusCode !== 200) throw new Error(`Saavn artist search failed with status ${statusCode}`);
    return body.json();
}

/**
 * Get an artist's songs by artist ID.
 * @param {string} artistId - Artist ID
 * @returns {Promise<object>} Artist's songs
 */
export async function getArtistSongs(artistId) {
    const { statusCode, body } = await request(
        `${BASE_URL}/api/artists/${encodeURIComponent(artistId)}/songs`
    );
    if (statusCode !== 200) throw new Error(`Saavn artist songs failed with status ${statusCode}`);
    return body.json();
}

/**
 * Get artist details by ID.
 * @param {string} artistId - Artist ID
 * @returns {Promise<object>} Artist details
 */
export async function getArtistById(artistId) {
    const { statusCode, body } = await request(
        `${BASE_URL}/api/artists/${encodeURIComponent(artistId)}`
    );
    if (statusCode !== 200) throw new Error(`Saavn artist fetch failed with status ${statusCode}`);
    return body.json();
}

/**
 * Get popular artists for a specific language.
 * This is used during onboarding to show a list of artists for selection.
 * @param {string} language - Language name (e.g. "hindi", "malayalam")
 * @returns {Promise<object[]>} List of artists
 */
export async function getArtistsByLanguage(language) {
    // Saavn API doesn't have a direct 'popular artists by language' endpoint.
    // We'll search for 'Top <language> Artists' and 'Popular <language> Artists'
    // to gather a good candidate list.
    const queries = [`Top ${language} Artists`, `Popular ${language} Artists`];

    const results = await Promise.allSettled(
        queries.map(q => searchArtists(q))
    );

    const artistMap = new Map();
    for (const result of results) {
        if (result.status === 'fulfilled' && result.value?.data?.results) {
            for (const artist of result.value.data.results) {
                if (artist.id) artistMap.set(artist.id, artist);
            }
        }
    }

    return Array.from(artistMap.values());
}

export default {
    searchSongs,
    searchSongsOnly,
    searchSongsOnlyFallback,
    getSongById,
    getAlbumById,
    searchAlbums,
    searchArtists,
    getArtistSongs,
    getArtistById,
    getArtistsByLanguage,
};

function normalizeFallbackSong(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const id = (raw.id ?? raw.songid ?? '').toString().trim();
    const name = (raw.song ?? raw.title ?? '').toString().trim();
    const artistText = (raw.primary_artists ?? raw.singers ?? '').toString();
    const artistNames = artistText
        .split(',')
        .map(name => name.trim())
        .filter(Boolean);

    const artistsPrimary = artistNames.map((artistName, index) => ({
        id: `${id}_a${index}`,
        name: artistName,
        role: 'primary_artists',
        image: '',
        type: 'artist',
        url: '',
    }));

    const mediaUrl = (raw.media_url ?? raw.url ?? '').toString().trim();
    const previewUrl = (raw.media_preview_url ?? '').toString().trim();
    const downloadUrl = [];
    if (previewUrl) {
        downloadUrl.push({ quality: '96kbps', url: previewUrl });
    }
    if (mediaUrl) {
        downloadUrl.push({ quality: '320kbps', url: mediaUrl });
    }

    const imageUrl = (raw.image ?? raw.image_url ?? '').toString().trim();
    const image = imageUrl
        ? [
            { quality: '50x50', url: imageUrl },
            { quality: '150x150', url: imageUrl },
            { quality: '500x500', url: imageUrl },
        ]
        : [];

    const albumId = (raw.albumid ?? '').toString().trim();
    const albumName = (raw.album ?? '').toString().trim();
    const albumUrl = (raw.album_url ?? '').toString().trim();

    return {
        id,
        name,
        type: 'song',
        year: (raw.year ?? '').toString(),
        releaseDate: raw.release_date ?? null,
        duration: Number.parseInt(raw.duration, 10) || null,
        language: (raw.language ?? '').toString().toLowerCase(),
        url: (raw.perma_url ?? '').toString(),
        album: {
            id: albumId,
            name: albumName,
            url: albumUrl,
        },
        primaryArtists: artistText,
        artists: {
            primary: artistsPrimary,
            featured: [],
            all: artistsPrimary,
        },
        image,
        downloadUrl,
    };
}

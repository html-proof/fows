import { request } from 'undici';

const BASE_URL = 'https://saavn.sumit.co';

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
    getSongById,
    getAlbumById,
    searchAlbums,
    searchArtists,
    getArtistSongs,
    getArtistById,
    getArtistsByLanguage,
};

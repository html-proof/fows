import { Router } from 'express';
import {
    searchSongsOnly,
    searchSongsSmart,
    searchArtists,
    getArtistsByLanguage,
    getSongById,
    getAlbumById,
    searchAlbums,
} from '../services/saavnApi.js';

const router = Router();

// Search API (public)
// Example: /api/search?query=Imagine+Dragons&page=2
router.get('/search', async (req, res) => {
    try {
        const { query } = req.query;
        if (!query) {
            return res.status(400).json({ error: 'Query parameter "query" is required' });
        }

        const parsedPage = parseInt(req.query.page, 10);
        const page = Number.isNaN(parsedPage) ? 1 : Math.max(parsedPage, 1);

        // For page > 1, only fetch songs. This powers "load more" efficiently.
        if (page > 1) {
            const songsData = await searchSongsOnly(query, page);
            return res.json({
                success: true,
                data: {
                    songs: songsData?.data?.results ?? [],
                    albums: [],
                    artists: [],
                },
            });
        }

        // First page returns songs + albums + artists
        const [songsData, albumsData, artistsData] = await Promise.allSettled([
            searchSongsSmart(query),
            searchAlbums(query),
            searchArtists(query),
        ]);

        const songs = songsData.status === 'fulfilled'
            ? songsData.value ?? []
            : [];

        res.json({
            success: true,
            data: {
                songs,
                albums: albumsData.status === 'fulfilled' ? albumsData.value?.data?.results ?? [] : [],
                artists: artistsData.status === 'fulfilled' ? artistsData.value?.data?.results ?? [] : [],
            },
        });
    } catch (error) {
        console.error('Search API error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Stream / Song Details API (public)
// Example: /api/songs/:id
router.get('/songs/:id', async (req, res) => {
    try {
        const data = await getSongById(req.params.id);
        res.json(data);
    } catch (error) {
        console.error('Song API error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Album API (public)
// Example 1: /api/albums?id=xxxxxxx
// Example 2: /api/albums?query=Evolve
router.get('/albums', async (req, res) => {
    try {
        const { id, query } = req.query;

        if (!id && !query) {
            return res.status(400).json({ error: 'Either "id" or "query" parameter is required' });
        }

        let data;
        if (id) {
            data = await getAlbumById(id);
        } else {
            data = await searchAlbums(query);
        }

        res.json(data);
    } catch (error) {
        console.error('Album API error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Artist Search by Language (Public)
// Used during onboarding to show artists after language selection
// Example: /api/artists/by-language?language=hindi
router.get('/artists/by-language', async (req, res) => {
    try {
        const { language } = req.query;
        if (!language) {
            return res.status(400).json({ error: 'Query parameter "language" is required' });
        }
        const data = await getArtistsByLanguage(language);
        res.json({ success: true, count: data.length, data });
    } catch (error) {
        console.error('Artists by language error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;

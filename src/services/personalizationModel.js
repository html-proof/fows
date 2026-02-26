import { getUserRealtimeProfile } from './database.js';

const PROFILE_CACHE_TTL_MS = 2 * 60 * 1000;
const PROFILE_CACHE_MAX_ENTRIES = 300;
const EMBEDDING_DIM = 16;
const MAX_INTERACTION_ITEMS = 200;

const profileCache = new Map();

// Tiny feed-forward ranking head (8 inputs -> 6 hidden -> 1 output).
const NN_WEIGHTS_1 = [
    [1.2, 0.8, -0.4, 0.9, 0.4, 0.2],
    [0.6, 1.1, 0.2, -0.3, 0.8, 0.5],
    [0.9, 0.4, 0.3, 0.2, 1.2, -0.2],
    [0.8, 0.6, 0.5, 0.1, -0.4, 0.7],
    [0.5, -0.2, 1.0, 0.6, 0.3, 0.4],
    [0.7, 0.3, -0.6, 1.0, 0.5, 0.9],
    [-0.9, -0.4, 0.4, -0.5, -0.8, -0.3],
    [0.4, 0.9, 0.1, 0.5, 0.7, 0.6],
];
const NN_BIAS_1 = [0.1, 0.05, 0.02, 0.06, 0.04, 0.08];
const NN_WEIGHTS_2 = [0.8, 0.9, 0.7, 0.85, 0.75, 0.8];
const NN_BIAS_2 = 0.12;

/**
 * Personalized reranking for search and recommendations.
 * Returns songs sorted by user-specific relevance.
 */
export async function rerankSongsForUser({
    uid,
    songs,
    query = '',
    preferredLanguages = [],
}) {
    const safeSongs = Array.isArray(songs) ? songs : [];
    if (!uid || safeSongs.length === 0) return safeSongs;

    const profile = await getCachedUserProfile(uid);
    const userVector = buildUserEmbedding(profile);
    const preferredLanguageSet = new Set(
        normalizeStringArray(preferredLanguages.length > 0 ? preferredLanguages : profile.languages)
    );
    const queryTerms = tokenize(query);
    const total = safeSongs.length;

    const ranked = safeSongs.map((song, index) => {
        const textRankScore = 1 - index / Math.max(total - 1, 1);
        const popularityScore = resolvePopularityScore(song);
        const songFields = extractSongFields(song);
        const songVector = buildSongEmbedding(songFields);
        const embeddingSimilarity = cosineSimilarity(userVector, songVector);
        const languageScore = resolveLanguageMatchScore(songFields.language, preferredLanguageSet, profile);
        const artistScore = resolveArtistMatchScore(songFields.artists, profile.artistAffinity, profile.favoriteArtists);
        const interaction = profile.songInteractions?.[songFields.id];
        const interactionScore = resolveInteractionScore(interaction);
        const skipRiskScore = resolveSkipRisk(interaction);
        const queryIntentScore = resolveQueryIntentScore(queryTerms, songFields);

        const nnScore = forwardNeuralRanker([
            textRankScore,
            embeddingSimilarity,
            languageScore,
            artistScore,
            popularityScore,
            interactionScore,
            skipRiskScore,
            queryIntentScore,
        ]);

        const preferenceMatch = clamp01((embeddingSimilarity + languageScore + artistScore) / 3);
        const finalScore = clamp01(
            textRankScore * 0.4 +
            preferenceMatch * 0.3 +
            popularityScore * 0.2 +
            interactionScore * 0.1
        ) * 0.65 + nnScore * 0.35;

        return {
            ...song,
            _ranking: {
                finalScore: Number(finalScore.toFixed(4)),
                textRankScore: Number(textRankScore.toFixed(4)),
                preferenceMatch: Number(preferenceMatch.toFixed(4)),
                popularityScore: Number(popularityScore.toFixed(4)),
                interactionScore: Number(interactionScore.toFixed(4)),
                neuralScore: Number(nnScore.toFixed(4)),
            },
        };
    });

    ranked.sort((a, b) => (b._ranking?.finalScore ?? 0) - (a._ranking?.finalScore ?? 0));
    return ranked;
}

async function getCachedUserProfile(uid) {
    const now = Date.now();
    const cached = profileCache.get(uid);
    if (cached && cached.expiresAt > now) {
        cached.lastAccessAt = now;
        return cached.profile;
    }

    const profile = await getUserRealtimeProfile(uid);
    profileCache.set(uid, {
        profile,
        expiresAt: now + PROFILE_CACHE_TTL_MS,
        lastAccessAt: now,
    });
    trimProfileCache();
    return profile;
}

function trimProfileCache() {
    if (profileCache.size <= PROFILE_CACHE_MAX_ENTRIES) return;

    let oldestKey = null;
    let oldestAccess = Number.POSITIVE_INFINITY;

    for (const [key, value] of profileCache.entries()) {
        const accessAt = value?.lastAccessAt ?? 0;
        if (accessAt < oldestAccess) {
            oldestAccess = accessAt;
            oldestKey = key;
        }
    }

    if (oldestKey) {
        profileCache.delete(oldestKey);
    }
}

function buildUserEmbedding(profile) {
    const vector = Array(EMBEDDING_DIM).fill(0);
    if (!profile || typeof profile !== 'object') return vector;

    const favoriteArtists = Array.isArray(profile.favoriteArtists) ? profile.favoriteArtists : [];
    for (const artist of favoriteArtists) {
        addTokenEmbedding(vector, `fav_artist:${artist}`, 2.4);
    }

    const languageAffinity = profile.languageAffinity || {};
    for (const [language, affinity] of Object.entries(languageAffinity)) {
        addTokenEmbedding(vector, `language:${language}`, 0.9 + clamp(affinity, -2, 8) * 0.08);
    }

    const artistAffinity = profile.artistAffinity || {};
    for (const [artist, affinity] of Object.entries(artistAffinity)) {
        addTokenEmbedding(vector, `artist:${artist}`, clamp(affinity, -4, 10) * 0.25);
    }

    const searchTerms = Array.isArray(profile.searchTerms) ? profile.searchTerms : [];
    searchTerms.slice(0, 20).forEach((query, index) => {
        const weight = 1 / (1 + index * 0.45);
        for (const term of tokenize(query)) {
            addTokenEmbedding(vector, `search:${term}`, weight);
        }
    });

    const interactions = Object.values(profile.songInteractions || {})
        .sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))
        .slice(0, MAX_INTERACTION_ITEMS);

    for (const interaction of interactions) {
        const affinity = Number(interaction?.affinity || 0);
        if (!Number.isFinite(affinity) || affinity === 0) continue;

        addTokenEmbedding(vector, `song:${interaction.songId}`, affinity * 0.15);
        if (interaction.artist) {
            addTokenEmbedding(vector, `artist:${normalizeText(interaction.artist)}`, affinity * 0.08);
        }
        if (interaction.language) {
            addTokenEmbedding(vector, `language:${normalizeText(interaction.language)}`, affinity * 0.06);
        }
    }

    normalizeVector(vector);
    return vector;
}

function buildSongEmbedding(songFields) {
    const vector = Array(EMBEDDING_DIM).fill(0);
    addTokenEmbedding(vector, `song:${songFields.id}`, 0.2);
    addTokenEmbedding(vector, `language:${songFields.language}`, 1.1);

    for (const artist of songFields.artists) {
        addTokenEmbedding(vector, `artist:${artist}`, 1.3);
    }

    for (const genre of songFields.genres) {
        addTokenEmbedding(vector, `genre:${genre}`, 0.9);
    }

    for (const term of tokenize(songFields.title).slice(0, 8)) {
        addTokenEmbedding(vector, `title:${term}`, 0.5);
    }

    normalizeVector(vector);
    return vector;
}

function addTokenEmbedding(vector, token, weight) {
    const normalizedToken = normalizeText(token);
    if (!normalizedToken || !Number.isFinite(weight) || weight === 0) return;

    for (let i = 0; i < EMBEDDING_DIM; i += 1) {
        const hash = signedHash(`${normalizedToken}#${i}`);
        vector[i] += (hash / 97) * weight;
    }
}

function extractSongFields(song) {
    const id = String(song?.id || song?.songId || '').trim();
    const title = normalizeText(song?.name || song?.title || song?.songName || '');
    const language = normalizeText(song?.language || '');
    const genres = normalizeStringArray([
        song?.genre,
        ...(Array.isArray(song?.genres) ? song.genres : []),
    ]);
    const artists = normalizeStringArray([
        ...(Array.isArray(song?.artists?.primary) ? song.artists.primary.map(item => item?.name) : []),
        ...(typeof song?.primaryArtists === 'string' ? song.primaryArtists.split(',') : []),
        song?.artist,
    ]);

    return {
        id,
        title,
        language,
        artists,
        genres,
    };
}

function resolveLanguageMatchScore(songLanguage, preferredLanguageSet, profile) {
    if (!songLanguage) return 0.35;
    let score = preferredLanguageSet.has(songLanguage) ? 1 : 0.25;

    const affinity = Number(profile?.languageAffinity?.[songLanguage] || 0);
    if (affinity > 0) {
        score += Math.min(0.35, affinity / 12);
    } else if (affinity < 0) {
        score -= Math.min(0.35, Math.abs(affinity) / 10);
    }
    return clamp01(score);
}

function resolveArtistMatchScore(songArtists, artistAffinity, favoriteArtists) {
    if (!Array.isArray(songArtists) || songArtists.length === 0) return 0.35;

    const favSet = new Set(normalizeStringArray(favoriteArtists));
    let score = 0.1;

    for (const artist of songArtists) {
        if (favSet.has(artist)) score += 0.45;
        const affinity = Number(artistAffinity?.[artist] || 0);
        if (affinity > 0) score += Math.min(0.35, affinity / 14);
        if (affinity < 0) score -= Math.min(0.25, Math.abs(affinity) / 12);
    }

    return clamp01(score);
}

function resolvePopularityScore(song) {
    const rawValue = Number(
        song?.global_popularity_score ??
        song?.popularity ??
        song?.playCount ??
        song?.play_count ??
        0
    );

    if (!Number.isFinite(rawValue) || rawValue <= 0) return 0.45;
    // Log scale to keep very popular songs from dominating.
    return clamp01(Math.log10(rawValue + 1) / 3.2);
}

function resolveInteractionScore(interaction) {
    if (!interaction || typeof interaction !== 'object') return 0.35;
    const affinity = Number(interaction.affinity || 0);
    if (!Number.isFinite(affinity)) return 0.35;
    return sigmoid(affinity * 0.35);
}

function resolveSkipRisk(interaction) {
    if (!interaction || typeof interaction !== 'object') return 0.2;
    const plays = Number(interaction.playCount || 0);
    const skips = Number(interaction.skipCount || 0);
    if (plays <= 0 && skips <= 0) return 0.2;
    return clamp01(skips / Math.max(plays + skips, 1));
}

function resolveQueryIntentScore(queryTerms, songFields) {
    if (!Array.isArray(queryTerms) || queryTerms.length === 0) return 0.5;
    const title = songFields.title || '';
    const artistText = songFields.artists.join(' ');

    let matches = 0;
    for (const term of queryTerms) {
        if (!term) continue;
        if (title.includes(term) || artistText.includes(term)) matches += 1;
    }

    return clamp01(matches / queryTerms.length);
}

function forwardNeuralRanker(features) {
    const safeFeatures = features.map(value => clamp01(Number(value) || 0));
    const hidden = NN_BIAS_1.map((bias, i) => {
        let sum = bias;
        for (let j = 0; j < safeFeatures.length; j += 1) {
            sum += safeFeatures[j] * NN_WEIGHTS_1[j][i];
        }
        return relu(sum);
    });

    let output = NN_BIAS_2;
    for (let i = 0; i < hidden.length; i += 1) {
        output += hidden[i] * NN_WEIGHTS_2[i];
    }
    return sigmoid(output / 3.2);
}

function normalizeStringArray(value) {
    const input = Array.isArray(value) ? value : [value];
    const output = [];
    const seen = new Set();

    for (const item of input) {
        const normalized = normalizeText(item);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        output.push(normalized);
    }

    return output;
}

function tokenize(value) {
    return normalizeText(value)
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(Boolean);
}

function normalizeText(value) {
    return String(value ?? '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ');
}

function signedHash(value) {
    let hash = 0;
    const text = String(value ?? '');
    for (let i = 0; i < text.length; i += 1) {
        hash = ((hash << 5) - hash) + text.charCodeAt(i);
        hash |= 0;
    }
    return hash;
}

function normalizeVector(vector) {
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(norm) || norm <= 0) return;
    for (let i = 0; i < vector.length; i += 1) {
        vector[i] /= norm;
    }
}

function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i += 1) {
        dot += (a[i] || 0) * (b[i] || 0);
    }
    return clamp01((dot + 1) / 2);
}

function relu(value) {
    return value > 0 ? value : 0;
}

function sigmoid(value) {
    return 1 / (1 + Math.exp(-value));
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function clamp01(value) {
    return clamp(value, 0, 1);
}

export default {
    rerankSongsForUser,
};

# Music App — Master Product Specification

> **Vision:** A multi-provider music platform with AI-driven discovery, superior search, synced lyrics, robust offline playback, and social listening. Not a Spotify clone — a smarter, more personal music experience.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Backend Services](#2-backend-services)
3. [Database Models](#3-database-models)
4. [Provider Adapter Layer](#4-provider-adapter-layer)
5. [Search System](#5-search-system)
6. [Playback Engine](#6-playback-engine)
7. [Lyrics System](#7-lyrics-system)
8. [Offline & Download System](#8-offline--download-system)
9. [Recommendation Engine](#9-recommendation-engine)
10. [AI Features](#10-ai-features)
11. [Social Features](#11-social-features)
12. [Flutter App — Screens & Components](#12-flutter-app--screens--components)
13. [API Contracts](#13-api-contracts)
14. [Firebase / Backend Rules](#14-firebase--backend-rules)
15. [Current Bug Backlog](#15-current-bug-backlog)
16. [Feature Priority Matrix](#16-feature-priority-matrix)

---

## 1. Architecture Overview

```
                      MOBILE / WEB / DESKTOP
                                │
                                ▼
                           API GATEWAY
                          (Express + Firebase Auth middleware)
                                │
         ┌──────────────────────┼──────────────────────┐
         ▼                      ▼                      ▼
    User Service           Music Service          AI Service
    /api/user              /api/music             /api/ai
         │                      │                      │
    Social Graph           Provider Layer         LLM Orchestrator
                                │
               ┌────────────────┼────────────────┐
               ▼                ▼                ▼
          ProviderA         ProviderB        ProviderC
          (JioSaavn)        (...)            (...)
               │                │                │
               └────────────────┼────────────────┘
                                ▼
                         Unified Catalog
                         (normalised Song/Album/Artist objects)
                                │
            ┌───────────────────┼───────────────────┐
            ▼                   ▼                   ▼
         Search            Recommendation         Lyrics
         Service           Service                Service
            │                   │                   │
            └───────────────────┼───────────────────┘
                                ▼
                         Playback Engine
                                │
                   ┌────────────┼────────────┐
                   ▼            ▼            ▼
                Stream       Download      Cache
```

### Principles

- Frontend never depends on a provider's raw response format — always normalised through the Unified Catalog.
- Every provider is replaceable: swap the adapter without touching app code.
- Only use providers whose terms permit the specific use being implemented.
- AI/recommendation is a service layer, not embedded in routes.

---

## 2. Backend Services

### 2.1 Auth Service (`/api/auth`)

| Endpoint | Method | Description |
|---|---|---|
| `/register` | POST | Email + password registration |
| `/login` | POST | Email + password login |
| `/logout` | POST | Revoke session |
| `/refresh` | POST | Refresh Firebase ID token |
| `/google` | POST | Google OAuth login |
| `/me` | GET | Current user profile |
| `/delete` | DELETE | Account deletion |

### 2.2 User Service (`/api/user`)

| Endpoint | Method | Description |
|---|---|---|
| `/profile` | GET/PATCH | Read/update profile |
| `/preferences` | GET/PATCH | Languages, genres, explicit, data-saver |
| `/liked-songs` | GET/POST/DELETE | Like/unlike tracks |
| `/liked-albums` | GET/POST/DELETE | Saved albums |
| `/followed-artists` | GET/POST/DELETE | Following artists |
| `/history` | GET | Listening history |
| `/stats` | GET | Listening statistics |
| `/devices` | GET/DELETE | Registered devices |

### 2.3 Music Service (`/api/music`)

| Endpoint | Method | Description |
|---|---|---|
| `/search` | GET | Universal search (songs/albums/artists/playlists) |
| `/song/:id` | GET | Song detail + stream URL |
| `/song/:id/stream` | GET | Resolve current stream URL |
| `/album/:id` | GET | Album + track list |
| `/artist/:id` | GET | Artist profile + discography |
| `/playlist/:id` | GET | Playlist + tracks |
| `/trending` | GET | Trending songs (by language/region) |
| `/new-releases` | GET | New releases |
| `/genres` | GET | Genre list |
| `/mood/:mood` | GET | Mood-based tracks |

### 2.4 Playlist Service (`/api/playlists`)

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET/POST | List/create playlists |
| `/:id` | GET/PATCH/DELETE | Read/update/delete playlist |
| `/:id/tracks` | GET/POST/DELETE | Manage tracks |
| `/:id/reorder` | PATCH | Reorder tracks |
| `/:id/collaborators` | GET/POST/DELETE | Collaborative playlists |
| `/:id/duplicate` | POST | Duplicate playlist |
| `/import` | POST | Import from Spotify/YouTube URL |

### 2.5 Recommendation Service (`/api/recommendations`)

| Endpoint | Method | Description |
|---|---|---|
| `/home` | GET | Personalised home sections |
| `/made-for-you` | GET | Daily mixes + personal mixes |
| `/because-you-listened` | GET | Because you listened to X |
| `/radio/:seedId` | GET | Song/artist/album radio |
| `/similar/:songId` | GET | Songs similar to X |
| `/queue-next` | POST | Next songs for infinite queue |

### 2.6 Lyrics Service (`/api/lyrics`)

| Endpoint | Method | Description |
|---|---|---|
| `/:songId` | GET | Fetch lyrics (synced + plain) |
| `/search` | GET | Search songs by lyric fragment |

### 2.7 AI Service (`/api/ai`)

| Endpoint | Method | Description |
|---|---|---|
| `/assistant` | POST | Natural-language music request → queue |
| `/playlist/generate` | POST | AI playlist from prompt |
| `/dj/next` | POST | AI DJ next track suggestion |
| `/mood-detect` | POST | Detect mood from listening session |

### 2.8 Activity Service (`/api/activity`)

| Endpoint | Method | Description |
|---|---|---|
| `/play` | POST | Record play event |
| `/skip` | POST | Record skip event |
| `/complete` | POST | Record full listen |
| `/seek` | POST | Record seek (timestamp jump) |

### 2.9 Download Service (`/api/downloads`)

| Endpoint | Method | Description |
|---|---|---|
| `/:songId/url` | GET | Pre-signed or resolved download URL |
| `/metadata/:songId` | GET | Download metadata (quality, size) |

---

## 3. Database Models

### Firebase Realtime Database Structure

```
/users/{uid}/
  profile/
    displayName
    photoUrl
    bio
    country
    createdAt
  preferences/
    languages[]
    favoriteArtists[]
    favoriteGenres[]
    explicitEnabled
    dataSaverEnabled
    lyricsAutoFetch
    streamingQuality         # low|normal|high|very_high|lossless
    downloadQuality          # same options
    wifiOnlyDownloads
    crossfadeDuration
    normalizationEnabled
    equalizerPreset
  liked_songs/{songId}/
    addedAt
    song {}                  # denormalised snapshot
  liked_albums/{albumId}/
    addedAt
  followed_artists/{artistId}/
    followedAt
  playlists/{playlistId}/
    name
    description
    coverUrl
    isPublic
    isCollaborative
    createdAt
    updatedAt
    tracks/{trackId}/
      position
      addedAt
      addedBy
  recently_played/{songId}/
    playedAt
    progress                 # seconds
  listening_history/{eventId}/
    songId
    songName
    artist
    album
    language
    durationMs
    completionPct
    timestamp
    source                   # stream|download|cache
  queue/
    current {}
    tracks[]
    shuffled
    repeat                   # off|all|one
  downloads/{songId}/
    status                   # pending|downloading|completed|failed|paused
    quality
    filePath
    fileSizeBytes
    downloadedAt
    metadata {}
  activity_summary/
    totalListenMs
    topArtists {}
    topSongs {}
    topGenres {}
    topLanguages {}
    streakDays
    lastUpdated
  devices/{deviceId}/
    name
    platform
    lastActive
    isActive
  notifications/{notifId}/
    type
    title
    body
    read
    createdAt

/playlists/{playlistId}/          # public playlists (non-user-owned)
/artists/{artistId}/              # cached artist profiles
/albums/{albumId}/                # cached album data
/global_trending/{language}/      # trending by language
/co_listen_pairs/{songId}/        # collaborative filtering pairs
```

---

## 4. Provider Adapter Layer

### Interface (backend, `src/providers/MusicProvider.js`)

```js
class MusicProvider {
  async search(query, options) {}           // → NormalisedSearchResult[]
  async getTrack(trackId) {}               // → NormalisedTrack
  async getStreamUrl(trackId, quality) {}  // → string (URL)
  async getAlbum(albumId) {}              // → NormalisedAlbum
  async getArtist(artistId) {}            // → NormalisedArtist
  async getPlaylist(playlistId) {}        // → NormalisedPlaylist
  async getRecommendations(seeds) {}      // → NormalisedTrack[]
  async getLyrics(trackId, meta) {}       // → LyricsPayload | null
  async getTrending(language, limit) {}   // → NormalisedTrack[]
  async getNewReleases(language) {}       // → NormalisedAlbum[]
}
```

### Normalised Track Object

```js
{
  id: string,            // provider-namespaced: "saavn:song_id"
  name: string,
  artist: string,
  artists: Artist[],
  album: string,
  albumId: string,
  albumArtUrl: string,
  duration: number,      // seconds
  language: string,
  genre: string,
  year: number,
  explicit: boolean,
  isrc: string,
  songUrl: string,       // permalink
  streamUrl: string,     // resolved CDN URL (expires)
  streamExpiry: number,  // unix timestamp
  provider: string,
  qualities: Quality[],
}
```

### Provider Resolution Flow

```
Track requested
      ↓
Primary provider → validate URL
      ↓
Valid?
 ├── YES → Player
 └── NO
      ↓
Secondary provider search (artist + title)
      ↓
Found?
 ├── YES → validate → Player
 └── NO → show unavailable
```

---

## 5. Search System

### Query Processing Pipeline

```
Raw query
    ↓
Normalise (lowercase, trim, unicode normalise)
    ↓
Language detect
    ↓
Transliterate (e.g. "arijit" → "अरिजित")
    ↓
Typo correction (edit-distance, known artist names)
    ↓
Intent extraction:
  - Artist name
  - Song title
  - Album name
  - Movie name
  - Mood keyword
  - Language keyword
  - Year/decade
    ↓
Parallel provider queries
    ↓
Normalise results
    ↓
Deduplicate (ISRC, title+artist fuzzy)
    ↓
Rank (relevance × popularity × language preference)
    ↓
Return
```

### Search Types

- **Songs** — exact + fuzzy + lyric fragment
- **Artists** — name + transliteration + alias
- **Albums** — title + artist + movie name
- **Playlists** — title + description
- **Lyrics** — full-text lyric search
- **Mood** — "sad songs", "workout songs"
- **Natural language** — "songs like Blinding Lights from 2019 in Hindi"

### Search Filters

- Language
- Genre
- Year range
- Duration range (short/medium/long)
- Explicit on/off
- Provider

---

## 6. Playback Engine

### Flutter — PlayerService Responsibilities

```
PLAY REQUEST
      │
      ▼
PlayerService.play(song)
      │
      ├── Check download manifest → local file?
      │     YES → AudioSource.file(path)
      │     NO  → resolve stream URL
      │
      ▼
SourceResolver.resolve(song)
      │
      ├── Validate URL (HTTP HEAD or first-byte check)
      │     VALID → AudioSource.uri(url)
      │     INVALID → fallback provider search
      │
      ▼
just_audio player
      │
      ├── positionStream → _progressTimer (40 ms) → UI
      ├── durationStream → PlayerService.durationStream
      ├── playingStream → PlayerService.playingStream
      └── processingStateStream → watchdog
```

### Playback Recovery Flow

```
Playback stalls (watchdog fires after 8 s)
      ↓
Is stream URL expired?
 ├── YES → re-resolve URL → seek to last position → play
 └── NO
      ↓
Is there a local download?
 ├── YES → switch to local source
 └── NO
      ↓
Network available?
 ├── NO → show offline state
 └── YES → retry with fallback provider
```

### Sync Offsets

| Source | Offset |
|---|---|
| CDN stream (buffered) | +1200 ms |
| Local downloaded file | 0 ms |

### Queue System

- Persist queue to Firebase `/users/{uid}/queue` on every change
- Restore queue on app launch
- Survive: app restart, network loss, device rotation, background
- Support: shuffle, repeat-all, repeat-one, play-next, add-to-bottom, save-as-playlist

---

## 7. Lyrics System

### Fetch Pipeline (LyricsManager)

```
Song changed
      ↓
Phase 1 — Foreground (≤8 s budget):
  1. LyricsCache local check
  2. Provider getLyrics (ISRC lookup)
  3. Musixmatch / LRCLIB / fallback
      ↓
Phase 2 — Background (if Phase 1 returned plain-only):
  4. LyricsAlignmentEngine.align() (local NLP, no server call)
      ↓
Phase 3 — Extended (next-song prefetch):
  5. prefetchLyrics() for queue[index+1]
```

### Synchronisation

- Driven by `PlayerService.positionStream` (40 ms timer), NOT an independent timer
- `activeIndexForPosition()` uses binary search — O(log n)
- `isLocalFile` flag switches sync offset (0 ms vs 1200 ms)
- Active line cached (`_activeLyricIndexCache`) — only re-computes if position moved past boundary

### Lyrics Features

| Feature | Status |
|---|---|
| Plain lyrics | ✅ |
| Synced LRC | ✅ |
| Auto-scroll | ✅ |
| Current-line highlight | ✅ |
| Karaoke mode | 🔲 planned |
| Word-level sync | 🔲 planned |
| Translation | ✅ |
| Lyrics search | 🔲 planned |
| Language-aware candidate ranking | ✅ |
| Cache | ✅ |

### `normalizeQuery` Rules

- Lowercase
- Remove noise words: "official video", "audio", "lyrics", "hd", "4k", "remastered", "live", "karaoke"
- Remove special chars **except** apostrophes (`'`) and accented characters (`À–ɏ`, `Ḁ–ỿ`)
- Collapse whitespace

---

## 8. Offline & Download System

### Three-Tier Storage (NEVER mix tiers)

| Tier | Lifetime | Evictable |
|---|---|---|
| **Stream** | Ephemeral (in-flight) | N/A |
| **Cache** | LRU, auto-evicted when storage > limit | YES |
| **Download** | Permanent until user deletes | **NEVER** |

### Download State Machine

```
IDLE
  ↓ user taps download
PENDING (in queue)
  ↓ worker picks up
DOWNLOADING
  ↓ all bytes received
  ↓ file renamed .mp4.part → audio.mp4
COMPLETED
  ↓ user deletes
DELETED

DOWNLOADING → FAILED (network error / validation fail)
FAILED → PENDING (retry)
DOWNLOADING → PAUSED (user or Wi-Fi-only gate)
PAUSED → DOWNLOADING (resumed)
```

### Download Manifest (`download_service.dart`)

- Single source of truth in SharedPreferences under key `download_manifest_v2`
- Each entry: `{ songId, status, quality, filePath, fileSizeBytes, downloadedAt, metadata{} }`
- `getAllDownloadedSongIds()` → `Set<String>` of COMPLETED songs → used by OfflineService to exclude from LRU eviction

### Critical Rules

1. `OfflineService._checkStorageLimit()` must call `DownloadService.getAllDownloadedSongIds()` and skip those entries.
2. `main.dart` must call `DownloadService.init()` after `ConnectivityManager.init()` to resume interrupted downloads.
3. SharedPreferences file must **never** be deleted wholesale — only prune specific keys.

### Path Convention (new-style)

```
{downloadsDir}/songs/{songId}/audio.mp4          ← completed
{downloadsDir}/songs/{songId}/audio.mp4.part     ← in-progress
{downloadsDir}/songs/{songId}/cover.jpg          ← artwork
{downloadsDir}/songs/{songId}/lyrics.lrc         ← synced lyrics
{downloadsDir}/songs/{songId}/metadata.json      ← song metadata
```

---

## 9. Recommendation Engine

### User Signal Collection

| Signal | Weight |
|---|---|
| Completion > 80% | +1.0 |
| Like | +2.0 |
| Replay | +1.5 |
| Save / Add to playlist | +1.8 |
| Skip < 30 s | -1.0 |
| Skip 30–60 s | -0.5 |
| Unlike | -2.0 |
| Block artist | -5.0 |

### Taste Profile

```
{
  artists: { [artistName]: score },
  genres:  { [genre]: score },
  languages: { [lang]: score },
  moods: { [mood]: score },
  decades: { [decade]: score },
  avgDuration: number,
  sessionMood: string,
}
```

### Home Sections (backend-driven)

All sections returned by `/api/recommendations/home` with `type`, `title`, `items[]`, `seeMoreUrl`.

| Section | Algorithm |
|---|---|
| Recently Played | User history, last 30 days |
| Made For You | Taste profile → candidate pool → re-rank |
| Because You Listened To X | Co-listen pairs from X's listeners |
| Daily Mix 1–6 | Genre/mood cluster per mix |
| Trending | Play velocity (growth rate) × recency |
| New Releases | Artist follows + genre preference |
| Mood Playlists | Static editorial + taste personalisation |

### Trending Score

```
trendScore = (recentPlays / windowPlays) × log(1 + totalPlays) × recencyDecay
```

`recencyDecay = e^(-λ * ageHours)` where λ ≈ 0.05 (half-life ~14 h)

---

## 10. AI Features

### 10.1 AI Music Assistant

**Input:** Natural-language string from user  
**Output:** Queue of tracks + optional spoken intro text

```
User: "Play energetic Malayalam songs for driving at night,
       nothing I heard this week."

      ↓ Parse intent
      {
        mood: "energetic",
        language: "malayalam",
        activity: "driving",
        timeOfDay: "night",
        excludeRecentDays: 7
      }
      ↓ Build candidate pool
      ↓ Apply exclusions (recent history)
      ↓ Re-rank by energy/tempo
      ↓ Return 20-track queue
```

### 10.2 AI DJ

Continuous DJ mode — generates next track commentary + transition:

```
Current song ending
      ↓
Analyse: BPM, key, mood, energy
      ↓
Select next: compatible BPM ± 10%, same/adjacent key
      ↓
Generate DJ commentary (optional TTS)
      ↓
Crossfade into next
```

### 10.3 AI Playlist Generation

```
POST /api/ai/playlist/generate
{ "prompt": "rainy night study playlist, 2 hours, no vocals" }

→ {
    name: "Rainy Night Study",
    tracks: Track[],
    coverPrompt: "...",   // for image generation
  }
```

### 10.4 Natural Language Search

Route `GET /api/search?q=sad+hindi+songs+from+2010+to+2020` through intent parser before hitting provider adapters.

---

## 11. Social Features

### Follow System

- Follow users → see their public playlists + listening activity (if enabled)
- Follow artists → new release notifications

### Friend Activity Feed

```
/social/feed
  ├── Friends listening now
  ├── Friends recently played
  ├── Friends created playlist
  └── Friends liked album
```

### Collaborative Playlists

- Any collaborator can add/remove/reorder tracks
- Change log: who added/removed what, when
- Duplicate detection on add

### Live Listening Rooms (Jam)

```
Host creates room → share code
      ↓
Participants join
      ↓
Shared queue (host controls by default)
      ↓
Participants can:
  - React
  - Request songs (host approves)
  - Vote to skip (majority rule)
      ↓
Synchronised playback (all devices within ±2 s)
```

---

## 12. Flutter App — Screens & Components

### Navigation Structure

```
Bottom Nav:
  Home | Discover | Search | Library | Profile

Player:
  Mini-player (persistent, above nav)
  Full-screen player
    ├── Artwork + controls
    ├── Lyrics tab
    ├── Queue tab
    ├── Related tab
    └── Devices tab
```

### Screen Inventory

| Screen | Key Features |
|---|---|
| SplashScreen | Boot, auth check, queue restore |
| HomeScreen | Dynamic backend-driven sections |
| DiscoverScreen | Mood picker, swipe-to-discover feed |
| SearchScreen | Universal search + filters + history |
| SearchResultsScreen | Songs / Albums / Artists / Playlists tabs |
| PlayerScreen | Full player, lyrics, queue, equalizer |
| LyricsScreen | Full-screen synced lyrics |
| AlbumScreen | Artwork, track list, download all |
| ArtistScreen | Bio, discography, similar artists |
| PlaylistScreen | Track list, manage, share |
| LibraryScreen | Liked / Playlists / Albums / Artists / Downloads |
| DownloadsScreen | Download manager, storage usage |
| ProfileScreen | Stats, settings, social |
| SettingsScreen | Audio, download, privacy, account |
| OnboardingScreen | Language + artist preference |
| NotificationsScreen | All notifications |
| StatsScreen | Listening stats, wrapped-style yearly |
| JamScreen | Live listening room |
| AIAssistantScreen | Natural-language music request |

### Key Providers

| Provider | Responsibility |
|---|---|
| `AuthProvider` | Firebase auth state |
| `PreferencesProvider` | User preferences |
| `PlayerProvider` | Playback state (position, song, queue UI) |
| `SearchProvider` | Search state + language filter |
| `DownloadProvider` | Download status + progress |
| `PlaylistProvider` | Playlist CRUD |
| `LyricsManager` (ChangeNotifier) | Lyrics state per song |
| `SocialProvider` | Feed, follows, jam |
| `AIProvider` | AI assistant state |

---

## 13. API Contracts

### Song Object (canonical)

```json
{
  "id": "string",
  "name": "string",
  "artist": "string",
  "artists": [{ "id": "string", "name": "string", "image": "string" }],
  "album": "string",
  "albumId": "string",
  "albumArtUrl": "string",
  "duration": 245,
  "language": "hindi",
  "genre": "pop",
  "year": 2020,
  "explicit": false,
  "isrc": "string",
  "songUrl": "string",
  "streamUrl": "string",
  "streamExpiry": 1720000000,
  "provider": "saavn",
  "downloadUrl": [
    { "quality": "96kbps", "url": "string" },
    { "quality": "160kbps", "url": "string" },
    { "quality": "320kbps", "url": "string" }
  ]
}
```

### Search Response

```json
{
  "query": "string",
  "total": 100,
  "songs": { "items": Song[], "total": 80 },
  "albums": { "items": Album[], "total": 10 },
  "artists": { "items": Artist[], "total": 5 },
  "playlists": { "items": Playlist[], "total": 5 }
}
```

### Home Response

```json
{
  "sections": [
    {
      "type": "recently_played",
      "title": "Recently Played",
      "layout": "horizontal_scroll",
      "items": Song[],
      "seeMoreUrl": "/api/music/history"
    }
  ]
}
```

---

## 14. Firebase / Backend Rules

### Realtime Database Rules (`database.rules.json`)

- Users can read/write only their own `/users/{uid}/` subtree
- Public playlists: any authenticated user can read, only owner can write
- Global trending: any authenticated user can read, only admin can write
- `$other: false` catch-all on every node

### Security Middleware (`src/app.js`)

- `helmet()` — security headers
- Rate limiting: 120 req/min global, 15 req/min on playlist import
- CORS: explicit allowlist, deny all if list empty
- Body size limit: 50 KB JSON
- All routes require `authenticateUser` middleware
- SSRF protection on any server-side URL fetch: allowlist of hosts + private IP block (including `::ffff:` IPv4-mapped IPv6)

---

## 15. Current Bug Backlog

### Fixed (this session)

| # | File | Bug | Fix |
|---|---|---|---|
| 1 | `main.dart` | SharedPreferences wiped on startup if >4 MB | Now only logs size, no deletion |
| 2 | `offline_service.dart` | LRU eviction deleting user downloads | Excluded COMPLETED downloads from eviction loop |
| 3 | `download_service.dart` | `_currentPartialBytes` wrong path | Fixed: checks `songs/{id}/audio.mp4.part` first |
| 4 | `download_service.dart` | `_cleanupFailedDownload` missing legacy paths | Fixed both new-style and legacy path cleanup |
| 5 | `download_service.dart` | No `getAllDownloadedSongIds()` method | Added; returns `Set<String>` of COMPLETED song IDs |
| 6 | `player_provider.dart` | Dual watchdog calling `recoverPlayback()` twice | PlayerProvider watchdog no longer calls `recoverPlayback()` |
| 7 | `lyrics_manager.dart` | Single 1200 ms offset for all sources | Added `isLocalFile` param: local=0 ms, stream=1200 ms |
| 8 | `player_screen.dart` | `activeIndexForPosition` ignoring local-file flag | All callers now pass `isLocalFile` |
| 9 | `lyrics_service.dart` | `normalizeQuery` stripping accents + apostrophes | Regex fixed to preserve `À-ɏ`, `Ḁ-ỿ`, `'` |
| 10 | `lyrics_service.dart` | `alignAudioWithServer` calling localhost:8000 | Guarded with early `return null` |
| 11 | `player_service.dart` | `_playerRawPositionSubscription` double-publishing position | Raw subscription now no-op; timer is sole publisher |
| 12 | `player_provider.dart` | `_ignorePositionUntilZero` never cleared on slow load | Safety timer now also clears the flag |
| 13 | `main.dart` | `DownloadService.init()` never called at startup | Added call after `ConnectivityManager.init()` |
| 14 | Backend: `saavnApi.js` | O(n) LRU eviction with array splice | Fixed to O(1) using `Map.keys().next().value` |
| 15 | Backend: `recommendation.js` | `artist.name` crash when artist is a string | Fixed: `typeof artist === 'string' ? artist : artist?.name` |
| 16 | Backend: `personalizationModel.js` | `moodMatchScore` always 0 (wrong field read) | Fixed: reads `song.genre \|\| song.label \|\| song.language` |
| 17 | Backend: `database.rules.json` | Missing rules for global_trending + co_listen_pairs | Added explicit rules + `$other: false` |
| 18 | Backend: `firebase.js` | Hardcoded DB URL fallback | Removed; throws if env var absent |
| 19 | Backend: `app.js` | CORS allowed everything when list empty | Fixed: returns `false` when allowedOrigins empty |
| 20 | Backend: `playlistImport.js` | No SSRF protection on user-supplied URLs | Added host allowlist + private IP checks |

### Open

| # | File | Bug | Priority |
|---|---|---|---|
| 1 | `lyrics_service.dart` | Dead `alignAudioWithServer` code still present (unreachable after guard) | Low — clean up later |
| 2 | `player_service.dart` | `_playerRawPositionSubscription` kept as no-op; could be removed entirely | Low |
| 3 | All | No integration tests for download state machine transitions | Medium |
| 4 | `player_screen.dart` | Lyrics auto-scroll disabled when user manually scrolls — re-enable after 5 s idle | Medium |
| 5 | Backend | No rate limit on `/api/ai/assistant` — could be expensive per-user | High |

---

## 16. Feature Priority Matrix

| Priority | Feature | Status |
|---|---|---|
| 🔴 Critical | Authentication | ✅ Done |
| 🔴 Critical | Music catalog + provider adapter | ✅ Done (JioSaavn) |
| 🔴 Critical | Search (songs/albums/artists) | ✅ Done |
| 🔴 Critical | Playback engine + queue | ✅ Done |
| 🔴 Critical | Offline downloads (never-delete rule) | ✅ Fixed |
| 🔴 Critical | Lyrics synchronisation | ✅ Fixed |
| 🔴 Critical | Playlists (create/manage) | ✅ Done |
| 🔴 Critical | Library (liked songs/albums/artists) | ✅ Done |
| 🔴 Critical | Network recovery + CDN fallback | ✅ Done |
| 🟠 High | Typo correction + fuzzy search | ✅ Done — artist name corrections + NLP expansion |
| 🟠 High | Natural-language search ("sad Malayalam songs") | ✅ Done — intent parser with mood + similarity detection |
| 🟠 High | Artist pages (full discography) | ✅ Done — 30 tracks, View All toggle, Artist Radio button |
| 🟠 High | Album pages | ✅ Done |
| 🟠 High | Radio / infinite queue | ✅ Done — `/api/recommendations/radio` + auto-extends when ≤3 songs left |
| 🟠 High | Listening history + stats | ✅ Done — `StatsScreen` with top artists/songs/languages/minutes |
| 🟠 High | Mood-based discovery | ✅ Done — `DiscoverScreen` + 12 moods + `/api/recommendations/mood/:mood` |
| 🟠 High | Subscriptions / free tier gating | 🔲 Planned |
| 🟠 High | Multi-language support (transliteration) | ✅ Done — NLP mood expansion with per-language seed queries |
| 🟡 Advanced | AI Music Assistant | 🔲 Planned |
| 🟡 Advanced | AI DJ | 🔲 Planned |
| 🟡 Advanced | AI Playlist generation | 🔲 Planned |
| 🟡 Advanced | Swipe-to-discover feed | 🔲 Planned |
| 🟡 Advanced | Social follow + friend activity | 🔲 Planned |
| 🟡 Advanced | Live listening rooms (Jam) | 🔲 Planned |
| 🟡 Advanced | Collaborative playlists | 🔲 Planned |
| 🟡 Advanced | Multi-device / remote control | 🔲 Planned |
| 🟡 Advanced | Karaoke / word-level lyrics | 🔲 Planned |
| 🟡 Advanced | Lyrics search | 🔲 Planned |
| 🟡 Advanced | Song recognition (hum/sing) | 🔲 Planned |
| 🟡 Advanced | Equalizer (custom bands) | 🔲 Planned |
| 🟡 Advanced | Wrapped / yearly stats | 🔲 Planned |
| 🟡 Advanced | Podcasts | 🔲 Planned |
| 🟡 Advanced | Audiobooks | 🔲 Planned |
| 🟡 Advanced | Artist dashboard | 🔲 Planned |
| 🟡 Advanced | Admin dashboard | 🔲 Planned |
| 🟡 Advanced | Advertisement system | 🔲 Planned |

---

*Last updated: 2026-08-10*

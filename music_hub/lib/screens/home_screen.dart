import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/song.dart';
import '../providers/auth_provider.dart';
import '../providers/player_provider.dart';
import '../services/api_service.dart';
import '../theme/app_theme.dart';
import '../widgets/song_tile.dart';
import '../widgets/mini_player.dart';
import 'search_screen.dart';
import 'history_screen.dart';
import 'downloads_screen.dart';
import 'login_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  List<Song> _recommendations = [];
  List<Song> _recentlyPlayed = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  Future<void> _loadData() async {
    setState(() => _loading = true);
    try {
      final results = await Future.wait([
        ApiService.getRecommendations(limit: 20),
        ApiService.getHistory(type: 'play', limit: 10),
      ]);

      final recList = results[0];
      _recommendations = recList.map((j) => Song.fromJson(j)).toList();

      final histList = results[1];
      _recentlyPlayed = histList.map((j) {
        return Song(
          id: j['songId'] ?? '',
          name: j['songName'] ?? 'Unknown',
          artist: j['artist'],
        );
      }).toList();
    } catch (e) {
      debugPrint('Home load error: $e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    final player = context.watch<PlayerProvider>();

    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(gradient: AppTheme.backgroundGradient),
        child: SafeArea(
          child: Column(
            children: [
              // App Bar
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
                child: Row(
                  children: [
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Hi, ${auth.user?.displayName?.split(' ').first ?? 'there'} 👋',
                          style: const TextStyle(
                            fontSize: 24,
                            fontWeight: FontWeight.w800,
                            color: AppTheme.textPrimary,
                          ),
                        ),
                        const Text(
                          'What do you want to listen to?',
                          style: TextStyle(fontSize: 13, color: AppTheme.textSecondary),
                        ),
                      ],
                    ),
                    const Spacer(),
                    IconButton(
                      icon: const Icon(Icons.download_rounded, color: AppTheme.textSecondary),
                      onPressed: () => Navigator.push(
                        context,
                        MaterialPageRoute(builder: (_) => const DownloadsScreen()),
                      ),
                    ),
                    IconButton(
                      icon: const Icon(Icons.history_rounded, color: AppTheme.textSecondary),
                      onPressed: () => Navigator.push(
                        context,
                        MaterialPageRoute(builder: (_) => const HistoryScreen()),
                      ),
                    ),
                    PopupMenuButton(
                      icon: CircleAvatar(
                        radius: 18,
                        backgroundColor: AppTheme.surfaceDark,
                        backgroundImage: auth.user?.photoURL != null
                            ? NetworkImage(auth.user!.photoURL!)
                            : null,
                        child: auth.user?.photoURL == null
                            ? const Icon(Icons.person, size: 18, color: AppTheme.textMuted)
                            : null,
                      ),
                      color: AppTheme.cardDark,
                      itemBuilder: (_) => [
                        const PopupMenuItem(value: 'logout', child: Text('Sign Out')),
                      ],
                      onSelected: (val) async {
                        if (val == 'logout') {
                          await auth.signOut();
                          if (context.mounted) {
                            Navigator.pushAndRemoveUntil(
                              context,
                              MaterialPageRoute(builder: (_) => const LoginScreen()),
                              (_) => false,
                            );
                          }
                        }
                      },
                    ),
                  ],
                ),
              ),

              // Search Bar
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
                child: GestureDetector(
                  onTap: () => Navigator.push(
                    context,
                    MaterialPageRoute(builder: (_) => const SearchScreen()),
                  ),
                  child: Container(
                    height: 50,
                    decoration: BoxDecoration(
                      color: AppTheme.surfaceDark,
                      borderRadius: BorderRadius.circular(16),
                    ),
                    child: const Row(
                      children: [
                        SizedBox(width: 16),
                        Icon(Icons.search_rounded, color: AppTheme.textMuted),
                        SizedBox(width: 12),
                        Text(
                          'Search songs, artists...',
                          style: TextStyle(color: AppTheme.textMuted, fontSize: 15),
                        ),
                      ],
                    ),
                  ),
                ),
              ),

              // Content
              Expanded(
                child: _loading
                    ? const Center(
                        child: CircularProgressIndicator(color: AppTheme.accentPurple),
                      )
                    : RefreshIndicator(
                        onRefresh: _loadData,
                        color: AppTheme.accentPurple,
                        child: ListView(
                          children: [
                            if (_recommendations.isNotEmpty) ...[
                              _sectionHeader('Recommended For You', Icons.auto_awesome),
                              ..._recommendations.map((song) => SongTile(
                                    song: song,
                                    isPlaying: player.currentSong?.id == song.id,
                                    onTap: () => player.play(
                                      song,
                                      playlist: _recommendations,
                                      index: _recommendations.indexOf(song),
                                    ),
                                  )),
                            ],
                            if (_recentlyPlayed.isNotEmpty) ...[
                              _sectionHeader('Recently Played', Icons.history),
                              ..._recentlyPlayed.map((song) => SongTile(
                                    song: song,
                                    isPlaying: player.currentSong?.id == song.id,
                                    onTap: () => player.play(song),
                                  )),
                            ],
                            if (_recommendations.isEmpty && _recentlyPlayed.isEmpty)
                              const Padding(
                                padding: EdgeInsets.only(top: 80),
                                child: Center(
                                  child: Column(
                                    children: [
                                      Icon(Icons.library_music_outlined,
                                          size: 64, color: AppTheme.textMuted),
                                      SizedBox(height: 16),
                                      Text(
                                        'Start searching for music!',
                                        style: TextStyle(
                                          color: AppTheme.textSecondary,
                                          fontSize: 16,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                            const SizedBox(height: 80),
                          ],
                        ),
                      ),
              ),

              // Mini Player
              const MiniPlayer(),
            ],
          ),
        ),
      ),
    );
  }

  Widget _sectionHeader(String title, IconData icon) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 8),
      child: Row(
        children: [
          Icon(icon, color: AppTheme.accentPink, size: 20),
          const SizedBox(width: 8),
          Text(
            title,
            style: const TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w700,
              color: AppTheme.textPrimary,
            ),
          ),
        ],
      ),
    );
  }
}

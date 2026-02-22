import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/search_provider.dart';
import '../providers/player_provider.dart';
import '../theme/app_theme.dart';
import '../widgets/song_tile.dart';
import '../widgets/mini_player.dart';

class SearchScreen extends StatefulWidget {
  const SearchScreen({super.key});

  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  final TextEditingController _controller = TextEditingController();
  final FocusNode _focusNode = FocusNode();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _focusNode.requestFocus());
  }

  @override
  void dispose() {
    _controller.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final search = context.watch<SearchProvider>();
    final player = context.watch<PlayerProvider>();

    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(gradient: AppTheme.backgroundGradient),
        child: SafeArea(
          child: Column(
            children: [
              // Search Bar
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 12, 16, 8),
                child: Row(
                  children: [
                    IconButton(
                      icon: const Icon(Icons.arrow_back_ios_new_rounded,
                          color: AppTheme.textSecondary),
                      onPressed: () => Navigator.pop(context),
                    ),
                    Expanded(
                      child: TextField(
                        controller: _controller,
                        focusNode: _focusNode,
                        style: const TextStyle(color: AppTheme.textPrimary),
                        decoration: InputDecoration(
                          hintText: 'Search songs, artists, albums...',
                          suffixIcon: _controller.text.isNotEmpty
                              ? IconButton(
                                  icon: const Icon(Icons.clear, color: AppTheme.textMuted),
                                  onPressed: () {
                                    _controller.clear();
                                    search.clear();
                                  },
                                )
                              : null,
                        ),
                        onSubmitted: (q) => search.search(q),
                        onChanged: (q) {
                          setState(() {}); // Rebuild for clear icon
                          if (q.length > 2) search.search(q);
                        },
                      ),
                    ),
                  ],
                ),
              ),

              // Results
              Expanded(
                child: search.loading
                    ? const Center(
                        child: CircularProgressIndicator(color: AppTheme.accentPurple),
                      )
                    : search.results.isEmpty
                        ? Center(
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(
                                  search.query.isEmpty
                                      ? Icons.search_rounded
                                      : Icons.music_off_rounded,
                                  size: 64,
                                  color: AppTheme.textMuted,
                                ),
                                const SizedBox(height: 16),
                                Text(
                                  search.query.isEmpty
                                      ? 'Search for your favorite music'
                                      : 'No results found',
                                  style: const TextStyle(
                                    color: AppTheme.textSecondary,
                                    fontSize: 16,
                                  ),
                                ),
                              ],
                            ),
                          )
                        : ListView.builder(
                            itemCount: search.results.length,
                            itemBuilder: (context, index) {
                              final song = search.results[index];
                              return SongTile(
                                song: song,
                                isPlaying: player.currentSong?.id == song.id,
                                onTap: () => player.play(
                                  song,
                                  playlist: search.results,
                                  index: index,
                                ),
                              );
                            },
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
}

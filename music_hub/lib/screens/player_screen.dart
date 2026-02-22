import 'package:flutter/material.dart';
import 'package:cached_network_image/cached_network_image.dart';
import 'package:provider/provider.dart';
import '../providers/player_provider.dart';
import '../providers/download_provider.dart';
import '../services/lyrics_service.dart';
import '../theme/app_theme.dart';

class PlayerScreen extends StatefulWidget {
  const PlayerScreen({super.key});

  @override
  State<PlayerScreen> createState() => _PlayerScreenState();
}

class _PlayerScreenState extends State<PlayerScreen> {
  String? _lyrics;
  bool _loadingLyrics = false;
  bool _showLyrics = false;
  String? _lastSongId;

  String _formatDuration(Duration d) {
    final m = d.inMinutes.remainder(60).toString().padLeft(2, '0');
    final s = d.inSeconds.remainder(60).toString().padLeft(2, '0');
    return '$m:$s';
  }

  Future<void> _fetchLyrics(String artist, String title, String songId) async {
    if (_lastSongId == songId) return; // Already fetched
    _lastSongId = songId;
    setState(() { _loadingLyrics = true; _lyrics = null; });

    final lyrics = await LyricsService.getLyrics(artist, title);
    if (mounted) {
      setState(() { _lyrics = lyrics; _loadingLyrics = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Consumer<PlayerProvider>(
      builder: (context, player, _) {
        final song = player.currentSong;
        if (song == null) {
          return const Scaffold(
            body: Center(child: Text('No song playing')),
          );
        }

        // Auto-fetch lyrics
        if (song.artist != null && song.artist!.isNotEmpty) {
          _fetchLyrics(song.artist!, song.name, song.id);
        }

        final downloads = context.watch<DownloadProvider>();
        final isDownloaded = downloads.isDownloaded(song.id);
        final isDownloading = downloads.progress.containsKey(song.id);

        return Scaffold(
          body: Container(
            decoration: const BoxDecoration(gradient: AppTheme.backgroundGradient),
            child: SafeArea(
              child: Column(
                children: [
                  // Top Bar
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                    child: Row(
                      children: [
                        IconButton(
                          icon: const Icon(Icons.keyboard_arrow_down_rounded,
                              color: AppTheme.textSecondary, size: 32),
                          onPressed: () => Navigator.pop(context),
                        ),
                        const Expanded(
                          child: Text(
                            'NOW PLAYING',
                            textAlign: TextAlign.center,
                            style: TextStyle(
                              color: AppTheme.textMuted,
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                              letterSpacing: 2,
                            ),
                          ),
                        ),
                        // Lyrics toggle
                        IconButton(
                          icon: Icon(
                            Icons.lyrics_rounded,
                            color: _showLyrics ? AppTheme.accentPink : AppTheme.textMuted,
                          ),
                          onPressed: () => setState(() => _showLyrics = !_showLyrics),
                        ),
                      ],
                    ),
                  ),

                  // Main content — Album Art or Lyrics
                  Expanded(
                    flex: 3,
                    child: _showLyrics ? _buildLyricsView() : _buildAlbumArt(song),
                  ),

                  // Song Info
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 40),
                    child: Column(
                      children: [
                        Text(
                          song.name,
                          style: const TextStyle(
                            fontSize: 22,
                            fontWeight: FontWeight.w800,
                            color: AppTheme.textPrimary,
                          ),
                          textAlign: TextAlign.center,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 6),
                        Text(
                          song.artist ?? 'Unknown Artist',
                          style: const TextStyle(fontSize: 14, color: AppTheme.textSecondary),
                          textAlign: TextAlign.center,
                        ),
                      ],
                    ),
                  ),

                  const SizedBox(height: 24),

                  // Progress Bar
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 32),
                    child: Column(
                      children: [
                        SliderTheme(
                          data: SliderThemeData(
                            activeTrackColor: AppTheme.accentPink,
                            inactiveTrackColor: AppTheme.textMuted.withOpacity(0.3),
                            thumbColor: AppTheme.accentPink,
                            thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 6),
                            trackHeight: 3,
                            overlayShape: const RoundSliderOverlayShape(overlayRadius: 14),
                          ),
                          child: Slider(
                            value: player.duration.inSeconds > 0
                                ? player.position.inSeconds
                                    .toDouble()
                                    .clamp(0, player.duration.inSeconds.toDouble())
                                : 0,
                            max: player.duration.inSeconds > 0
                                ? player.duration.inSeconds.toDouble()
                                : 1,
                            onChanged: (val) => player.seek(Duration(seconds: val.toInt())),
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 16),
                          child: Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              Text(
                                _formatDuration(player.position),
                                style: const TextStyle(fontSize: 12, color: AppTheme.textMuted),
                              ),
                              Text(
                                _formatDuration(player.duration),
                                style: const TextStyle(fontSize: 12, color: AppTheme.textMuted),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),

                  const SizedBox(height: 8),

                  // Controls
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      // Download button
                      IconButton(
                        icon: isDownloading
                            ? SizedBox(
                                width: 20,
                                height: 20,
                                child: CircularProgressIndicator(
                                  value: downloads.progress[song.id],
                                  strokeWidth: 2,
                                  color: AppTheme.accentPink,
                                ),
                              )
                            : Icon(
                                isDownloaded ? Icons.download_done : Icons.download_rounded,
                                color: isDownloaded ? Colors.green : AppTheme.textSecondary,
                              ),
                        onPressed: isDownloaded || isDownloading
                            ? null
                            : () => downloads.download(song),
                      ),
                      const SizedBox(width: 8),
                      IconButton(
                        iconSize: 40,
                        icon: const Icon(Icons.skip_previous_rounded, color: AppTheme.textPrimary),
                        onPressed: () => player.skipPrevious(),
                      ),
                      const SizedBox(width: 8),
                      Container(
                        width: 70,
                        height: 70,
                        decoration: BoxDecoration(
                          gradient: AppTheme.primaryGradient,
                          shape: BoxShape.circle,
                          boxShadow: [
                            BoxShadow(
                              color: AppTheme.accentPurple.withOpacity(0.4),
                              blurRadius: 20,
                              spreadRadius: 2,
                            ),
                          ],
                        ),
                        child: IconButton(
                          iconSize: 36,
                          icon: Icon(
                            player.isPlaying ? Icons.pause_rounded : Icons.play_arrow_rounded,
                            color: Colors.white,
                          ),
                          onPressed: () => player.togglePlayPause(),
                        ),
                      ),
                      const SizedBox(width: 8),
                      IconButton(
                        iconSize: 40,
                        icon: const Icon(Icons.skip_next_rounded, color: AppTheme.textPrimary),
                        onPressed: () => player.skipNext(),
                      ),
                      const SizedBox(width: 8),
                      // Placeholder for symmetry
                      const SizedBox(width: 48),
                    ],
                  ),

                  const SizedBox(height: 24),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _buildAlbumArt(song) {
    return Center(
      child: Container(
        width: 280,
        height: 280,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(20),
          boxShadow: [
            BoxShadow(
              color: AppTheme.accentPurple.withOpacity(0.3),
              blurRadius: 40,
              spreadRadius: 10,
            ),
          ],
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(20),
          child: song.imageUrl != null
              ? CachedNetworkImage(
                  imageUrl: song.imageUrl!,
                  fit: BoxFit.cover,
                  placeholder: (_, __) => Container(
                    color: AppTheme.cardDark,
                    child: const Icon(Icons.music_note, size: 80, color: AppTheme.textMuted),
                  ),
                )
              : Container(
                  color: AppTheme.cardDark,
                  child: const Icon(Icons.music_note, size: 80, color: AppTheme.textMuted),
                ),
        ),
      ),
    );
  }

  Widget _buildLyricsView() {
    if (_loadingLyrics) {
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircularProgressIndicator(color: AppTheme.accentPurple),
            SizedBox(height: 16),
            Text('Fetching lyrics...', style: TextStyle(color: AppTheme.textSecondary)),
          ],
        ),
      );
    }

    if (_lyrics == null || _lyrics!.isEmpty) {
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.lyrics_rounded, size: 48, color: AppTheme.textMuted),
            SizedBox(height: 12),
            Text('Lyrics not available', style: TextStyle(color: AppTheme.textSecondary)),
          ],
        ),
      );
    }

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 32),
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: AppTheme.surfaceDark.withOpacity(0.5),
        borderRadius: BorderRadius.circular(16),
      ),
      child: SingleChildScrollView(
        child: Text(
          _lyrics!,
          style: const TextStyle(
            color: AppTheme.textPrimary,
            fontSize: 16,
            height: 1.8,
          ),
          textAlign: TextAlign.center,
        ),
      ),
    );
  }
}

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/download_provider.dart';
import '../providers/player_provider.dart';
import '../models/song.dart';
import '../services/download_service.dart';
import '../theme/app_theme.dart';
import '../widgets/mini_player.dart';

class DownloadsScreen extends StatelessWidget {
  const DownloadsScreen({super.key});

  String _formatSize(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }

  @override
  Widget build(BuildContext context) {
    final downloads = context.watch<DownloadProvider>();
    final player = context.watch<PlayerProvider>();

    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(gradient: AppTheme.backgroundGradient),
        child: SafeArea(
          child: Column(
            children: [
              // App Bar
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 8, 16, 0),
                child: Row(
                  children: [
                    IconButton(
                      icon: const Icon(Icons.arrow_back_ios_new_rounded,
                          color: AppTheme.textSecondary),
                      onPressed: () => Navigator.pop(context),
                    ),
                    const Expanded(
                      child: Text(
                        'Downloads',
                        style: TextStyle(
                          fontSize: 20,
                          fontWeight: FontWeight.w700,
                          color: AppTheme.textPrimary,
                        ),
                      ),
                    ),
                    // Smart Download Toggle
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.auto_awesome, color: AppTheme.accentPink, size: 16),
                        const SizedBox(width: 4),
                        const Text('Smart', style: TextStyle(color: AppTheme.textSecondary, fontSize: 12)),
                        Switch(
                          value: downloads.smartDownloadEnabled,
                          onChanged: (_) => downloads.toggleSmartDownload(),
                          activeColor: AppTheme.accentPurple,
                        ),
                      ],
                    ),
                  ],
                ),
              ),

              // Storage info
              FutureBuilder<int>(
                future: DownloadService.getTotalSize(),
                builder: (context, snapshot) {
                  final size = snapshot.data ?? 0;
                  return Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
                    child: Row(
                      children: [
                        const Icon(Icons.storage, color: AppTheme.textMuted, size: 16),
                        const SizedBox(width: 8),
                        Text(
                          '${downloads.downloadedSongs.length} songs • ${_formatSize(size)}',
                          style: const TextStyle(color: AppTheme.textSecondary, fontSize: 13),
                        ),
                        const Spacer(),
                        if (downloads.smartDownloadEnabled)
                          TextButton.icon(
                            icon: const Icon(Icons.download_rounded, size: 16),
                            label: const Text('Smart Download'),
                            style: TextButton.styleFrom(foregroundColor: AppTheme.accentPink),
                            onPressed: () => downloads.smartDownload(),
                          ),
                      ],
                    ),
                  );
                },
              ),

              // Downloaded Songs
              Expanded(
                child: downloads.downloadedSongs.isEmpty
                    ? Center(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(Icons.download_done_rounded, size: 64, color: AppTheme.textMuted),
                            const SizedBox(height: 16),
                            const Text(
                              'No downloads yet',
                              style: TextStyle(color: AppTheme.textSecondary, fontSize: 16),
                            ),
                            const SizedBox(height: 8),
                            Text(
                              downloads.smartDownloadEnabled
                                  ? 'Smart Download will auto-cache your favorites'
                                  : 'Tap the download icon on any song',
                              style: const TextStyle(color: AppTheme.textMuted, fontSize: 13),
                            ),
                          ],
                        ),
                      )
                    : ListView.builder(
                        itemCount: downloads.downloadedSongs.length,
                        itemBuilder: (context, index) {
                          final song = downloads.downloadedSongs[index];
                          return Dismissible(
                            key: Key(song.id),
                            direction: DismissDirection.endToStart,
                            background: Container(
                              alignment: Alignment.centerRight,
                              padding: const EdgeInsets.only(right: 20),
                              color: Colors.red.withOpacity(0.2),
                              child: const Icon(Icons.delete_rounded, color: Colors.red),
                            ),
                            onDismissed: (_) => downloads.delete(song.id),
                            child: ListTile(
                              contentPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 4),
                              leading: Container(
                                width: 50,
                                height: 50,
                                decoration: BoxDecoration(
                                  color: AppTheme.surfaceDark,
                                  borderRadius: BorderRadius.circular(8),
                                ),
                                child: const Icon(Icons.music_note, color: AppTheme.accentPurple),
                              ),
                              title: Text(
                                song.name,
                                style: const TextStyle(
                                  color: AppTheme.textPrimary,
                                  fontWeight: FontWeight.w600,
                                ),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                              subtitle: Text(
                                song.artist ?? 'Unknown',
                                style: const TextStyle(color: AppTheme.textSecondary, fontSize: 12),
                              ),
                              trailing: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  const Icon(Icons.download_done, color: Colors.green, size: 18),
                                  const SizedBox(width: 8),
                                  IconButton(
                                    icon: const Icon(Icons.play_arrow_rounded, color: AppTheme.accentPink),
                                    onPressed: () async {
                                      final localPath = await downloads.getLocalPath(song.id);
                                      if (localPath != null) {
                                        final offlineSong = Song(
                                          id: song.id,
                                          name: song.name,
                                          artist: song.artist,
                                          album: song.album,
                                          imageUrl: song.imageUrl,
                                          streamUrl: localPath,
                                        );
                                        player.play(offlineSong,
                                            playlist: downloads.downloadedSongs,
                                            index: index);
                                      }
                                    },
                                  ),
                                ],
                              ),
                            ),
                          );
                        },
                      ),
              ),

              const MiniPlayer(),
            ],
          ),
        ),
      ),
    );
  }
}

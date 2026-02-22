import 'package:flutter/material.dart';
import '../models/song.dart';
import '../services/download_service.dart';
import '../services/api_service.dart';

class DownloadProvider extends ChangeNotifier {
  final Map<String, double> _progress = {};
  final Set<String> _downloadedIds = {};
  List<Song> _downloadedSongs = [];
  bool _smartDownloadEnabled = true;

  Map<String, double> get progress => _progress;
  Set<String> get downloadedIds => _downloadedIds;
  List<Song> get downloadedSongs => _downloadedSongs;
  bool get smartDownloadEnabled => _smartDownloadEnabled;

  DownloadProvider() {
    _loadDownloaded();
  }

  Future<void> _loadDownloaded() async {
    _downloadedSongs = await DownloadService.getDownloadedSongs();
    _downloadedIds.clear();
    for (final song in _downloadedSongs) {
      _downloadedIds.add(song.id);
    }
    notifyListeners();
  }

  bool isDownloaded(String songId) => _downloadedIds.contains(songId);
  bool isDownloading(String songId) => DownloadService.isDownloading(songId);

  Future<void> download(Song song) async {
    _progress[song.id] = 0.0;
    notifyListeners();

    final success = await DownloadService.downloadSong(
      song,
      onProgress: (p) {
        _progress[song.id] = p;
        notifyListeners();
      },
    );

    if (success) {
      _downloadedIds.add(song.id);
      await _loadDownloaded();
    }
    _progress.remove(song.id);
    notifyListeners();
  }

  Future<void> delete(String songId) async {
    await DownloadService.deleteSong(songId);
    _downloadedIds.remove(songId);
    await _loadDownloaded();
    notifyListeners();
  }

  /// Get local file path for offline playback
  Future<String?> getLocalPath(String songId) =>
      DownloadService.getLocalPath(songId);

  /// Smart Download: auto-download frequently played songs
  void toggleSmartDownload() {
    _smartDownloadEnabled = !_smartDownloadEnabled;
    notifyListeners();
  }

  /// Smart download: auto-cache top played songs
  Future<void> smartDownload() async {
    if (!_smartDownloadEnabled) return;

    try {
      final history = await ApiService.getHistory(type: 'play', limit: 50);

      // Count play frequency per song
      final Map<String, int> playCounts = {};
      final Map<String, dynamic> songData = {};

      for (final item in history) {
        final id = item['songId']?.toString() ?? '';
        if (id.isEmpty) continue;
        playCounts[id] = (playCounts[id] ?? 0) + 1;
        songData[id] = item;
      }

      // Sort by play count, get top 5 not already downloaded
      final topSongs = playCounts.entries.toList()
        ..sort((a, b) => b.value.compareTo(a.value));

      int downloaded = 0;
      for (final entry in topSongs) {
        if (downloaded >= 5) break;
        if (_downloadedIds.contains(entry.key)) continue;

        final data = songData[entry.key];
        if (data == null) continue;

        // We need stream URL — try fetching the song
        try {
          final songResult = await ApiService.getSong(entry.key);
          final songJson = songResult['data'];
          if (songJson != null) {
            final song = Song.fromJson(songJson is List ? songJson.first : songJson);
            if (song.streamUrl != null) {
              await download(song);
              downloaded++;
            }
          }
        } catch (_) {}
      }
    } catch (e) {
      debugPrint('Smart download error: $e');
    }
  }
}

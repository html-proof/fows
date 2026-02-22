import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:dio/dio.dart';
import '../models/song.dart';

class DownloadService {
  static final Dio _dio = Dio();
  static final Map<String, double> _progress = {};
  static final Map<String, bool> _downloading = {};

  /// Get the local downloads directory
  static Future<Directory> get _downloadsDir async {
    final appDir = await getApplicationDocumentsDirectory();
    final dir = Directory('${appDir.path}/music_hub_downloads');
    if (!await dir.exists()) await dir.create(recursive: true);
    return dir;
  }

  /// Get the metadata file path
  static Future<File> get _metadataFile async {
    final dir = await _downloadsDir;
    return File('${dir.path}/metadata.json');
  }

  /// Check if a song is downloaded
  static Future<bool> isDownloaded(String songId) async {
    final dir = await _downloadsDir;
    final file = File('${dir.path}/$songId.mp4');
    return file.exists();
  }

  /// Get download progress for a song (0.0 to 1.0)
  static double getProgress(String songId) => _progress[songId] ?? 0.0;

  /// Check if currently downloading
  static bool isDownloading(String songId) => _downloading[songId] ?? false;

  /// Download a song
  static Future<bool> downloadSong(Song song, {Function(double)? onProgress}) async {
    if (song.streamUrl == null || song.streamUrl!.isEmpty) return false;
    if (_downloading[song.id] == true) return false;

    _downloading[song.id] = true;
    _progress[song.id] = 0.0;

    try {
      final dir = await _downloadsDir;
      final filePath = '${dir.path}/${song.id}.mp4';

      await _dio.download(
        song.streamUrl!,
        filePath,
        onReceiveProgress: (received, total) {
          if (total > 0) {
            _progress[song.id] = received / total;
            onProgress?.call(_progress[song.id]!);
          }
        },
      );

      // Save metadata
      await _saveMetadata(song);
      _progress[song.id] = 1.0;
      return true;
    } catch (e) {
      debugPrint('Download error: $e');
      return false;
    } finally {
      _downloading[song.id] = false;
    }
  }

  /// Delete a downloaded song
  static Future<void> deleteSong(String songId) async {
    final dir = await _downloadsDir;
    final file = File('${dir.path}/$songId.mp4');
    if (await file.exists()) await file.delete();
    await _removeMetadata(songId);
  }

  /// Get the local file path for a downloaded song
  static Future<String?> getLocalPath(String songId) async {
    final dir = await _downloadsDir;
    final file = File('${dir.path}/$songId.mp4');
    if (await file.exists()) return file.path;
    return null;
  }

  /// Get all downloaded songs metadata
  static Future<List<Song>> getDownloadedSongs() async {
    final file = await _metadataFile;
    if (!await file.exists()) return [];

    try {
      final content = await file.readAsString();
      final List<dynamic> data = jsonDecode(content);
      return data.map((json) => Song.fromJson(json)).toList();
    } catch (e) {
      return [];
    }
  }

  /// Get total download size in bytes
  static Future<int> getTotalSize() async {
    final dir = await _downloadsDir;
    if (!await dir.exists()) return 0;

    int totalSize = 0;
    await for (final entity in dir.list()) {
      if (entity is File && entity.path.endsWith('.mp4')) {
        totalSize += await entity.length();
      }
    }
    return totalSize;
  }

  // ── Private Helpers ──────────────────────────────────────

  static Future<void> _saveMetadata(Song song) async {
    final file = await _metadataFile;
    List<dynamic> songs = [];

    if (await file.exists()) {
      try {
        songs = jsonDecode(await file.readAsString());
      } catch (_) {}
    }

    // Remove existing entry for this song
    songs.removeWhere((s) => s['id'] == song.id);

    // Add new entry
    songs.add({
      'id': song.id,
      'name': song.name,
      'artist': song.artist,
      'album': song.album,
      'imageUrl': song.imageUrl,
      'streamUrl': song.streamUrl,
      'downloadedAt': DateTime.now().millisecondsSinceEpoch,
    });

    await file.writeAsString(jsonEncode(songs));
  }

  static Future<void> _removeMetadata(String songId) async {
    final file = await _metadataFile;
    if (!await file.exists()) return;

    try {
      List<dynamic> songs = jsonDecode(await file.readAsString());
      songs.removeWhere((s) => s['id'] == songId);
      await file.writeAsString(jsonEncode(songs));
    } catch (_) {}
  }
}

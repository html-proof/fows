import 'dart:convert';
import 'package:http/http.dart' as http;

class LyricsService {
  // Using the free lyrics.ovh API
  static const String _baseUrl = 'https://api.lyrics.ovh/v1';

  /// Fetch lyrics for a song by artist and title
  static Future<String?> getLyrics(String artist, String title) async {
    if (artist.isEmpty || title.isEmpty) return null;

    try {
      // Clean artist and title for API query
      final cleanArtist = _cleanString(artist);
      final cleanTitle = _cleanString(title);

      final res = await http.get(
        Uri.parse('$_baseUrl/${Uri.encodeComponent(cleanArtist)}/${Uri.encodeComponent(cleanTitle)}'),
      ).timeout(const Duration(seconds: 8));

      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        return data['lyrics']?.toString().trim();
      }
    } catch (_) {}

    // Fallback: try with simplified artist name (first artist only)
    try {
      final simpleArtist = artist.split(',').first.trim();
      final simpleTitle = title.split('(').first.trim();

      final res = await http.get(
        Uri.parse('$_baseUrl/${Uri.encodeComponent(simpleArtist)}/${Uri.encodeComponent(simpleTitle)}'),
      ).timeout(const Duration(seconds: 8));

      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        return data['lyrics']?.toString().trim();
      }
    } catch (_) {}

    return null;
  }

  /// Clean string for API queries
  static String _cleanString(String input) {
    return input
        .replaceAll(RegExp(r'\(.*?\)'), '')   // Remove parentheses content
        .replaceAll(RegExp(r'\[.*?\]'), '')    // Remove bracket content
        .replaceAll(RegExp(r'feat\..*', caseSensitive: false), '')
        .replaceAll(RegExp(r'ft\..*', caseSensitive: false), '')
        .trim();
  }
}

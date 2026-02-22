import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:firebase_auth/firebase_auth.dart';

class ApiService {
  static const String baseUrl = 'http://10.0.2.2:3000'; // Android emulator -> localhost

  static Future<Map<String, String>> _authHeaders() async {
    final user = FirebaseAuth.instance.currentUser;
    if (user == null) return {'Content-Type': 'application/json'};
    final token = await user.getIdToken();
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer $token',
    };
  }

  // ─── Public Endpoints ────────────────────────────────────

  static Future<List<dynamic>> search(String query) async {
    final res = await http.get(
      Uri.parse('$baseUrl/api/search?query=${Uri.encodeComponent(query)}'),
    );
    if (res.statusCode != 200) throw Exception('Search failed');
    final data = jsonDecode(res.body);

    // The search endpoint returns a complex structure
    // Extract songs from topQuery or songs sections
    final results = <dynamic>[];
    if (data['data'] != null) {
      final d = data['data'];
      if (d['topQuery']?['results'] != null) {
        results.addAll(d['topQuery']['results']);
      }
      if (d['songs']?['results'] != null) {
        results.addAll(d['songs']['results']);
      }
    }
    return results;
  }

  static Future<List<dynamic>> searchSongs(String query) async {
    final res = await http.get(
      Uri.parse('$baseUrl/api/search?query=${Uri.encodeComponent(query)}'),
    );
    if (res.statusCode != 200) throw Exception('Search failed');
    final data = jsonDecode(res.body);

    final results = <dynamic>[];
    if (data['data'] != null) {
      final d = data['data'];
      if (d['songs']?['results'] != null) {
        results.addAll(d['songs']['results']);
      }
      if (d['topQuery']?['results'] != null) {
        for (final item in d['topQuery']['results']) {
          if (item['type'] == 'song') results.add(item);
        }
      }
    }
    return results;
  }

  static Future<Map<String, dynamic>> getSong(String id) async {
    final res = await http.get(Uri.parse('$baseUrl/api/songs/$id'));
    if (res.statusCode != 200) throw Exception('Song fetch failed');
    return jsonDecode(res.body);
  }

  static Future<Map<String, dynamic>> getAlbums({String? id, String? query}) async {
    String url = '$baseUrl/api/albums?';
    if (id != null) url += 'id=$id';
    if (query != null) url += 'query=${Uri.encodeComponent(query)}';
    final res = await http.get(Uri.parse(url));
    if (res.statusCode != 200) throw Exception('Album fetch failed');
    return jsonDecode(res.body);
  }

  static Future<List<dynamic>> getArtistsByLanguage(String language) async {
    final res = await http.get(
      Uri.parse('$baseUrl/api/artists/by-language?language=${Uri.encodeComponent(language)}'),
    );
    if (res.statusCode != 200) throw Exception('Artists fetch failed');
    final data = jsonDecode(res.body);
    return data['data'] ?? [];
  }

  // ─── Protected Endpoints ─────────────────────────────────

  static Future<void> savePreferences({
    required List<String> languages,
    required List<Map<String, String>> favoriteArtists,
  }) async {
    final headers = await _authHeaders();
    final res = await http.post(
      Uri.parse('$baseUrl/api/user/preferences'),
      headers: headers,
      body: jsonEncode({
        'languages': languages,
        'favoriteArtists': favoriteArtists,
      }),
    );
    if (res.statusCode != 200) throw Exception('Save preferences failed');
  }

  static Future<Map<String, dynamic>?> getPreferences() async {
    final headers = await _authHeaders();
    final res = await http.get(
      Uri.parse('$baseUrl/api/user/preferences'),
      headers: headers,
    );
    if (res.statusCode == 404) return null;
    if (res.statusCode != 200) throw Exception('Get preferences failed');
    final data = jsonDecode(res.body);
    return data['data'];
  }

  static Future<void> logActivity(String type, Map<String, dynamic> payload) async {
    final headers = await _authHeaders();
    await http.post(
      Uri.parse('$baseUrl/api/activity/$type'),
      headers: headers,
      body: jsonEncode(payload),
    );
  }

  static Future<List<dynamic>> getHistory({String? type, int limit = 20}) async {
    final headers = await _authHeaders();
    String url = '$baseUrl/api/activity/history?limit=$limit';
    if (type != null) url += '&type=$type';
    final res = await http.get(Uri.parse(url), headers: headers);
    if (res.statusCode != 200) return [];
    final data = jsonDecode(res.body);
    return data['data'] ?? [];
  }

  static Future<List<dynamic>> getRecommendations({int limit = 20}) async {
    final headers = await _authHeaders();
    final res = await http.get(
      Uri.parse('$baseUrl/api/recommendations?limit=$limit'),
      headers: headers,
    );
    if (res.statusCode != 200) return [];
    final data = jsonDecode(res.body);
    return data['data'] ?? [];
  }
}

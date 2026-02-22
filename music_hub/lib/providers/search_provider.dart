import 'package:flutter/material.dart';
import '../models/song.dart';
import '../services/api_service.dart';

class SearchProvider extends ChangeNotifier {
  List<Song> _results = [];
  bool _loading = false;
  String _query = '';

  List<Song> get results => _results;
  bool get loading => _loading;
  String get query => _query;

  Future<void> search(String query) async {
    if (query.trim().isEmpty) {
      _results = [];
      _query = '';
      notifyListeners();
      return;
    }

    _query = query;
    _loading = true;
    notifyListeners();

    try {
      final data = await ApiService.searchSongs(query);
      _results = data.map((json) => Song.fromJson(json)).toList();

      // Log search activity
      try {
        await ApiService.logActivity('search', {'query': query});
      } catch (_) {}
    } catch (e) {
      debugPrint('Search error: $e');
      _results = [];
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  void clear() {
    _results = [];
    _query = '';
    notifyListeners();
  }
}

import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import '../services/auth_service.dart';
import '../services/api_service.dart';

class AuthProvider extends ChangeNotifier {
  User? _user;
  bool _loading = true;
  bool _hasPreferences = false;

  User? get user => _user;
  bool get loading => _loading;
  bool get isLoggedIn => _user != null;
  bool get hasPreferences => _hasPreferences;

  AuthProvider() {
    AuthService.authStateChanges.listen((user) {
      _user = user;
      _loading = false;
      if (user != null) {
        _checkPreferences();
      }
      notifyListeners();
    });
  }

  Future<void> _checkPreferences() async {
    try {
      final prefs = await ApiService.getPreferences();
      _hasPreferences = prefs != null;
    } catch (_) {
      _hasPreferences = false;
    }
    notifyListeners();
  }

  Future<bool> signInWithGoogle() async {
    try {
      _loading = true;
      notifyListeners();
      final user = await AuthService.signInWithGoogle();
      _user = user;
      if (user != null) await _checkPreferences();
      return user != null;
    } catch (e) {
      debugPrint('Sign in error: $e');
      return false;
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  Future<void> signOut() async {
    await AuthService.signOut();
    _user = null;
    _hasPreferences = false;
    notifyListeners();
  }

  void markPreferencesSet() {
    _hasPreferences = true;
    notifyListeners();
  }
}

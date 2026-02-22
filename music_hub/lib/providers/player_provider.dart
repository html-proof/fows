import 'package:flutter/material.dart';
import '../models/song.dart';
import '../services/player_service.dart';

class PlayerProvider extends ChangeNotifier {
  Song? get currentSong => PlayerService.currentSong;
  List<Song> get queue => PlayerService.queue;
  int get currentIndex => PlayerService.currentIndex;

  bool _isPlaying = false;
  Duration _position = Duration.zero;
  Duration _duration = Duration.zero;

  bool get isPlaying => _isPlaying;
  Duration get position => _position;
  Duration get duration => _duration;

  PlayerProvider() {
    PlayerService.playingStream.listen((playing) {
      _isPlaying = playing;
      notifyListeners();
    });

    PlayerService.positionStream.listen((pos) {
      _position = pos;
      notifyListeners();
    });

    PlayerService.durationStream.listen((dur) {
      _duration = dur ?? Duration.zero;
      notifyListeners();
    });
  }

  Future<void> play(Song song, {List<Song>? playlist, int? index}) async {
    await PlayerService.play(song, playlist: playlist, index: index);
    notifyListeners();
  }

  Future<void> togglePlayPause() async {
    await PlayerService.togglePlayPause();
  }

  Future<void> seek(Duration position) async {
    await PlayerService.seek(position);
  }

  Future<void> skipNext() async {
    await PlayerService.skipNext();
    notifyListeners();
  }

  Future<void> skipPrevious() async {
    await PlayerService.skipPrevious();
    notifyListeners();
  }
}

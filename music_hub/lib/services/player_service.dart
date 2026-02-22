import 'package:just_audio/just_audio.dart';
import '../models/song.dart';
import 'api_service.dart';

class PlayerService {
  static final AudioPlayer _player = AudioPlayer();
  static Song? _currentSong;
  static final List<Song> _queue = [];
  static int _currentIndex = -1;

  static AudioPlayer get player => _player;
  static Song? get currentSong => _currentSong;
  static List<Song> get queue => _queue;
  static int get currentIndex => _currentIndex;

  static Stream<Duration> get positionStream => _player.positionStream;
  static Stream<Duration?> get durationStream => _player.durationStream;
  static Stream<bool> get playingStream => _player.playingStream;
  static Stream<PlayerState> get playerStateStream => _player.playerStateStream;

  static Future<void> play(Song song, {List<Song>? playlist, int? index}) async {
    if (song.streamUrl == null || song.streamUrl!.isEmpty) return;

    _currentSong = song;
    if (playlist != null) {
      _queue.clear();
      _queue.addAll(playlist);
      _currentIndex = index ?? 0;
    }

    // Support both network URLs and local file paths (offline)
    if (song.streamUrl!.startsWith('/') || song.streamUrl!.startsWith('C:') || song.streamUrl!.startsWith('D:')) {
      await _player.setFilePath(song.streamUrl!);
    } else {
      await _player.setUrl(song.streamUrl!);
    }
    _player.play();

    // Log play activity
    try {
      await ApiService.logActivity('play', {
        'songId': song.id,
        'songName': song.name,
        'artist': song.artist ?? '',
      });
    } catch (_) {}
  }

  static Future<void> pause() async => _player.pause();
  static Future<void> resume() async => _player.play();
  static Future<void> seek(Duration position) async => _player.seek(position);

  static Future<void> togglePlayPause() async {
    if (_player.playing) {
      await pause();
    } else {
      await resume();
    }
  }

  static Future<void> skipNext() async {
    if (_queue.isEmpty || _currentIndex >= _queue.length - 1) return;

    // Log skip
    if (_currentSong != null) {
      try {
        await ApiService.logActivity('skip', {
          'songId': _currentSong!.id,
          'songName': _currentSong!.name,
          'artist': _currentSong!.artist ?? '',
          'skipTime': _player.position.inSeconds,
        });
      } catch (_) {}
    }

    _currentIndex++;
    await play(_queue[_currentIndex]);
  }

  static Future<void> skipPrevious() async {
    if (_queue.isEmpty) return;

    if (_player.position.inSeconds > 3 || _currentIndex <= 0) {
      await seek(Duration.zero);
    } else {
      _currentIndex--;
      await play(_queue[_currentIndex]);
    }
  }

  static Future<void> stop() async {
    await _player.stop();
    _currentSong = null;
  }

  static void dispose() {
    _player.dispose();
  }
}

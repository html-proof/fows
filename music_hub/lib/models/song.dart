class Song {
  final String id;
  final String name;
  final String? album;
  final String? artist;
  final String? imageUrl;
  final String? streamUrl;
  final String? language;
  final int? duration;
  final double? recommendationScore;

  Song({
    required this.id,
    required this.name,
    this.album,
    this.artist,
    this.imageUrl,
    this.streamUrl,
    this.language,
    this.duration,
    this.recommendationScore,
  });

  factory Song.fromJson(Map<String, dynamic> json) {
    // Extract artist name from various API formats
    String? artistName;
    if (json['primaryArtists'] != null) {
      if (json['primaryArtists'] is String) {
        artistName = json['primaryArtists'];
      } else if (json['primaryArtists'] is List) {
        artistName = (json['primaryArtists'] as List)
            .map((a) => a is String ? a : a['name'] ?? '')
            .join(', ');
      }
    }
    if (artistName == null && json['artists'] != null) {
      final primary = json['artists']['primary'];
      if (primary is List && primary.isNotEmpty) {
        artistName = primary.map((a) => a['name'] ?? '').join(', ');
      }
    }

    // Extract image URL (prefer highest quality)
    String? imageUrl;
    if (json['image'] is List && (json['image'] as List).isNotEmpty) {
      final images = json['image'] as List;
      imageUrl = images.last['url'] ?? images.last['link'];
    } else if (json['image'] is String) {
      imageUrl = json['image'];
    }

    // Extract stream URL (prefer 320kbps)
    String? streamUrl;
    if (json['downloadUrl'] is List && (json['downloadUrl'] as List).isNotEmpty) {
      final urls = json['downloadUrl'] as List;
      streamUrl = urls.last['url'] ?? urls.last['link'];
    }

    return Song(
      id: json['id']?.toString() ?? '',
      name: json['name'] ?? json['title'] ?? 'Unknown',
      album: json['album'] is Map ? json['album']['name'] : json['album']?.toString(),
      artist: artistName,
      imageUrl: imageUrl,
      streamUrl: streamUrl,
      language: json['language'],
      duration: json['duration'] != null ? int.tryParse(json['duration'].toString()) : null,
      recommendationScore: json['_recommendationScore']?.toDouble(),
    );
  }
}

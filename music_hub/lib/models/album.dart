class Album {
  final String id;
  final String name;
  final String? artist;
  final String? imageUrl;
  final String? language;
  final int? songCount;

  Album({
    required this.id,
    required this.name,
    this.artist,
    this.imageUrl,
    this.language,
    this.songCount,
  });

  factory Album.fromJson(Map<String, dynamic> json) {
    String? imageUrl;
    if (json['image'] is List && (json['image'] as List).isNotEmpty) {
      imageUrl = (json['image'] as List).last['url'] ?? (json['image'] as List).last['link'];
    } else if (json['image'] is String) {
      imageUrl = json['image'];
    }

    return Album(
      id: json['id']?.toString() ?? '',
      name: json['name'] ?? json['title'] ?? 'Unknown',
      artist: json['primaryArtists'] ?? json['artist'],
      imageUrl: imageUrl,
      language: json['language'],
      songCount: json['songCount'] != null ? int.tryParse(json['songCount'].toString()) : null,
    );
  }
}

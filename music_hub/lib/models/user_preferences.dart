class UserPreferences {
  final String uid;
  final List<String> languages;
  final List<Map<String, String>> favoriteArtists;
  final String? displayName;
  final String? email;

  UserPreferences({
    required this.uid,
    this.languages = const [],
    this.favoriteArtists = const [],
    this.displayName,
    this.email,
  });

  factory UserPreferences.fromJson(Map<String, dynamic> json) {
    return UserPreferences(
      uid: json['uid'] ?? '',
      languages: List<String>.from(json['languages'] ?? []),
      favoriteArtists: (json['favoriteArtists'] as List?)
              ?.map((a) => Map<String, String>.from(a))
              .toList() ??
          [],
      displayName: json['displayName'],
      email: json['email'],
    );
  }
}

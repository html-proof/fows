import 'package:flutter/material.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../models/song.dart';
import '../theme/app_theme.dart';

class SongTile extends StatelessWidget {
  final Song song;
  final VoidCallback? onTap;
  final bool isPlaying;

  const SongTile({
    super.key,
    required this.song,
    this.onTap,
    this.isPlaying = false,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      decoration: BoxDecoration(
        color: isPlaying ? AppTheme.accentPurple.withOpacity(0.15) : AppTheme.surfaceDark.withOpacity(0.5),
        borderRadius: BorderRadius.circular(12),
        border: isPlaying ? Border.all(color: AppTheme.accentPurple.withOpacity(0.4), width: 1) : null,
      ),
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        leading: ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: SizedBox(
            width: 50,
            height: 50,
            child: song.imageUrl != null
                ? CachedNetworkImage(
                    imageUrl: song.imageUrl!,
                    fit: BoxFit.cover,
                    placeholder: (_, __) => Container(
                      color: AppTheme.cardDark,
                      child: const Icon(Icons.music_note, color: AppTheme.textMuted),
                    ),
                    errorWidget: (_, __, ___) => Container(
                      color: AppTheme.cardDark,
                      child: const Icon(Icons.music_note, color: AppTheme.textMuted),
                    ),
                  )
                : Container(
                    color: AppTheme.cardDark,
                    child: const Icon(Icons.music_note, color: AppTheme.textMuted),
                  ),
          ),
        ),
        title: Text(
          song.name,
          style: TextStyle(
            color: isPlaying ? AppTheme.accentPink : AppTheme.textPrimary,
            fontWeight: FontWeight.w600,
            fontSize: 14,
          ),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        subtitle: Text(
          song.artist ?? 'Unknown Artist',
          style: const TextStyle(color: AppTheme.textSecondary, fontSize: 12),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        trailing: isPlaying
            ? const Icon(Icons.equalizer, color: AppTheme.accentPink)
            : const Icon(Icons.play_arrow_rounded, color: AppTheme.textMuted),
        onTap: onTap,
      ),
    );
  }
}

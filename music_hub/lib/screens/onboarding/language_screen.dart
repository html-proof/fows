import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';
import 'artist_screen.dart';

class LanguageScreen extends StatefulWidget {
  const LanguageScreen({super.key});

  @override
  State<LanguageScreen> createState() => _LanguageScreenState();
}

class _LanguageScreenState extends State<LanguageScreen> {
  final Set<String> _selected = {};

  final List<Map<String, dynamic>> _languages = [
    {'name': 'Hindi', 'icon': '🇮🇳'},
    {'name': 'English', 'icon': '🇬🇧'},
    {'name': 'Malayalam', 'icon': '🌴'},
    {'name': 'Tamil', 'icon': '🎭'},
    {'name': 'Telugu', 'icon': '🎬'},
    {'name': 'Kannada', 'icon': '🏛️'},
    {'name': 'Bengali', 'icon': '🎵'},
    {'name': 'Punjabi', 'icon': '🎶'},
    {'name': 'Marathi', 'icon': '🎤'},
    {'name': 'Gujarati', 'icon': '🎸'},
    {'name': 'Bhojpuri', 'icon': '🪘'},
    {'name': 'Urdu', 'icon': '📜'},
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(gradient: AppTheme.backgroundGradient),
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SizedBox(height: 20),
                const Text(
                  'Choose Your\nLanguages',
                  style: TextStyle(
                    fontSize: 32,
                    fontWeight: FontWeight.w800,
                    color: AppTheme.textPrimary,
                    height: 1.2,
                  ),
                ),
                const SizedBox(height: 8),
                const Text(
                  'Select the languages you want to listen to',
                  style: TextStyle(fontSize: 14, color: AppTheme.textSecondary),
                ),
                const SizedBox(height: 32),
                Expanded(
                  child: GridView.builder(
                    gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                      crossAxisCount: 3,
                      crossAxisSpacing: 12,
                      mainAxisSpacing: 12,
                      childAspectRatio: 1.1,
                    ),
                    itemCount: _languages.length,
                    itemBuilder: (context, index) {
                      final lang = _languages[index];
                      final isSelected = _selected.contains(lang['name']);
                      return GestureDetector(
                        onTap: () {
                          setState(() {
                            if (isSelected) {
                              _selected.remove(lang['name']);
                            } else {
                              _selected.add(lang['name']);
                            }
                          });
                        },
                        child: AnimatedContainer(
                          duration: const Duration(milliseconds: 200),
                          decoration: BoxDecoration(
                            gradient: isSelected ? AppTheme.primaryGradient : null,
                            color: isSelected ? null : AppTheme.surfaceDark,
                            borderRadius: BorderRadius.circular(16),
                            border: Border.all(
                              color: isSelected
                                  ? AppTheme.accentPurple
                                  : AppTheme.textMuted.withOpacity(0.2),
                            ),
                            boxShadow: isSelected
                                ? [
                                    BoxShadow(
                                      color: AppTheme.accentPurple.withOpacity(0.3),
                                      blurRadius: 12,
                                    ),
                                  ]
                                : null,
                          ),
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Text(lang['icon'], style: const TextStyle(fontSize: 28)),
                              const SizedBox(height: 6),
                              Text(
                                lang['name'],
                                style: TextStyle(
                                  color: isSelected ? Colors.white : AppTheme.textSecondary,
                                  fontWeight: FontWeight.w600,
                                  fontSize: 13,
                                ),
                              ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
                ),
                const SizedBox(height: 16),
                SizedBox(
                  width: double.infinity,
                  height: 56,
                  child: ElevatedButton(
                    onPressed: _selected.isEmpty
                        ? null
                        : () {
                            Navigator.push(
                              context,
                              MaterialPageRoute(
                                builder: (_) => ArtistScreen(
                                  selectedLanguages: _selected.toList(),
                                ),
                              ),
                            );
                          },
                    child: const Text('Continue'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

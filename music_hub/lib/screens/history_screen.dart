import 'package:flutter/material.dart';
import '../services/api_service.dart';
import '../theme/app_theme.dart';
import '../widgets/mini_player.dart';

class HistoryScreen extends StatefulWidget {
  const HistoryScreen({super.key});

  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> with SingleTickerProviderStateMixin {
  late TabController _tabController;
  List<dynamic> _playHistory = [];
  List<dynamic> _searchHistory = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _loadHistory();
  }

  Future<void> _loadHistory() async {
    try {
      final results = await Future.wait([
        ApiService.getHistory(type: 'play', limit: 30),
        ApiService.getHistory(type: 'search', limit: 30),
      ]);
      _playHistory = results[0];
      _searchHistory = results[1];
    } catch (e) {
      debugPrint('History load error: $e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(gradient: AppTheme.backgroundGradient),
        child: SafeArea(
          child: Column(
            children: [
              // App Bar
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 8, 16, 0),
                child: Row(
                  children: [
                    IconButton(
                      icon: const Icon(Icons.arrow_back_ios_new_rounded,
                          color: AppTheme.textSecondary),
                      onPressed: () => Navigator.pop(context),
                    ),
                    const Expanded(
                      child: Text(
                        'History',
                        style: TextStyle(
                          fontSize: 20,
                          fontWeight: FontWeight.w700,
                          color: AppTheme.textPrimary,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              // Tabs
              TabBar(
                controller: _tabController,
                indicatorColor: AppTheme.accentPurple,
                labelColor: AppTheme.accentPink,
                unselectedLabelColor: AppTheme.textMuted,
                tabs: const [
                  Tab(text: 'Played', icon: Icon(Icons.play_circle_outline, size: 20)),
                  Tab(text: 'Searched', icon: Icon(Icons.search, size: 20)),
                ],
              ),
              // Content
              Expanded(
                child: _loading
                    ? const Center(
                        child: CircularProgressIndicator(color: AppTheme.accentPurple),
                      )
                    : TabBarView(
                        controller: _tabController,
                        children: [
                          _buildPlayHistory(),
                          _buildSearchHistory(),
                        ],
                      ),
              ),
              const MiniPlayer(),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildPlayHistory() {
    if (_playHistory.isEmpty) {
      return const Center(
        child: Text('No play history yet', style: TextStyle(color: AppTheme.textSecondary)),
      );
    }

    return ListView.builder(
      itemCount: _playHistory.length,
      itemBuilder: (context, index) {
        final item = _playHistory[index];
        return ListTile(
          leading: Container(
            width: 45,
            height: 45,
            decoration: BoxDecoration(
              color: AppTheme.surfaceDark,
              borderRadius: BorderRadius.circular(8),
            ),
            child: const Icon(Icons.music_note, color: AppTheme.textMuted),
          ),
          title: Text(
            item['songName'] ?? 'Unknown',
            style: const TextStyle(color: AppTheme.textPrimary, fontWeight: FontWeight.w600),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          subtitle: Text(
            item['artist'] ?? '',
            style: const TextStyle(color: AppTheme.textSecondary, fontSize: 12),
          ),
          trailing: Text(
            _timeAgo(item['timestamp']),
            style: const TextStyle(color: AppTheme.textMuted, fontSize: 11),
          ),
        );
      },
    );
  }

  Widget _buildSearchHistory() {
    if (_searchHistory.isEmpty) {
      return const Center(
        child: Text('No search history yet', style: TextStyle(color: AppTheme.textSecondary)),
      );
    }

    return ListView.builder(
      itemCount: _searchHistory.length,
      itemBuilder: (context, index) {
        final item = _searchHistory[index];
        return ListTile(
          leading: const Icon(Icons.search, color: AppTheme.textMuted),
          title: Text(
            item['query'] ?? '',
            style: const TextStyle(color: AppTheme.textPrimary),
          ),
          trailing: Text(
            _timeAgo(item['timestamp']),
            style: const TextStyle(color: AppTheme.textMuted, fontSize: 11),
          ),
        );
      },
    );
  }

  String _timeAgo(dynamic timestamp) {
    if (timestamp == null) return '';
    final ts = timestamp is int ? timestamp : int.tryParse(timestamp.toString()) ?? 0;
    final diff = DateTime.now().millisecondsSinceEpoch - ts;
    final minutes = diff ~/ 60000;
    if (minutes < 60) return '${minutes}m ago';
    final hours = minutes ~/ 60;
    if (hours < 24) return '${hours}h ago';
    return '${hours ~/ 24}d ago';
  }
}

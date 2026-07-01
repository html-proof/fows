import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpotifyEmbedHtml } from '../src/services/playlistMatcher.js';

test('parseSpotifyEmbedHtml uses the largest track list across all embedded JSON blocks', () => {
  const html = `
    <script type="application/ld+json">
      {"@type":"MusicPlaylist","track":[{"name":"First Song","byArtist":{"name":"Artist One"}}]}
    </script>
    <script id="__NEXT_DATA__">
      {"props":{"pageProps":{"data":{"playlist":{"trackList":[{"title":"Second Song","subtitle":"Artist Two"},{"title":"Third Song","subtitle":"Artist Three"},{"title":"Fourth Song","subtitle":"Artist Four"}]}}}}}
    </script>
  `;

  const items = parseSpotifyEmbedHtml(html);

  assert.equal(items.length, 3);
  assert.deepEqual(items.map(item => item.title), ['Second Song', 'Third Song', 'Fourth Song']);
});

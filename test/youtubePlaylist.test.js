import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYouTubePage, extractYouTubePlaylistTracks } from '../src/routes/playlistImport.js';

test('parseYouTubePage extracts tracks from modern YouTube playlist renderers', () => {
  const html = `
    <html>
      <head><title>Test Playlist - YouTube</title></head>
      <body>
        <script type="application/json">
          {"contents":{"twoColumnBrowseResultsRenderer":{"tabs":[{"tabRenderer":{"content":{"sectionListRenderer":{"contents":[{"musicPlaylistShelfRenderer":{"contents":[{"musicResponsiveListItemRenderer":{"title":{"runs":[{"text":"Song One"}]},"flexColumns":[{"text":{"runs":[{"text":"Song One"}]}},{"text":{"runs":[{"text":"Artist One"}]}}]}}}]}}]}}}]}}}}
        </script>
      </body>
    </html>
  `;

  const result = parseYouTubePage(html);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, 'Song One');
  assert.equal(result.items[0].artist, 'Artist One');
});

test('extractYouTubePlaylistTracks handles playlistVideoRenderer payloads', () => {
  const data = {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [{
          tabRenderer: {
            content: {
              sectionListRenderer: {
                contents: [{
                  playlistVideoListRenderer: {
                    contents: [{
                      playlistVideoRenderer: {
                        title: { runs: [{ text: 'Song Two' }] },
                        shortBylineText: { runs: [{ text: 'Artist Two' }] }
                      }
                    }]
                  }
                }]
              }
            }
          }
        }]
      }
    }
  };

  const items = extractYouTubePlaylistTracks(data);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], { title: 'Song Two', artist: 'Artist Two' });
});

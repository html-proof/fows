import { parseYouTubePage } from './src/routes/playlistImport.js';

const html = `
<html>
  <head><title>Test Playlist - YouTube</title></head>
  <body>
    <script type="application/json">
      {"contents":{"twoColumnBrowseResultsRenderer":{"tabs":[{"tabRenderer":{"content":{"sectionListRenderer":{"contents":[{"musicPlaylistShelfRenderer":{"contents":[{"musicResponsiveListItemRenderer":{"title":{"runs":[{"text":"Song One"}]},"flexColumns":[{"text":{"runs":[{"text":"Song One"}]}},{"text":{"runs":[{"text":"Artist One"}]}}]}}]}}]}}}}]}}}
    </script>
  </body>
</html>`;

const result = parseYouTubePage(html);
console.log(JSON.stringify(result, null, 2));

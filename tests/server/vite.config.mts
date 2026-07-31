/**
 * Copyright (c) Rui Figueira.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

/**
 * Two endpoints a static file cannot imitate, both used by v2-search.html.
 *
 * The capture filters are decided by how a response ARRIVES — its content type
 * and its timing — so a fixture served from disk, answering instantly with
 * application/json, cannot exercise them. These are the two shapes that broke
 * against a real application.
 */
function syntheticsFixtureEndpoints(): Plugin {
  return {
    name: 'synthetics-fixture-endpoints',
    configureServer(server) {
      // Streamed, the way OpenObserve's `_search_stream` answers: headers at
      // once, body for a while afterwards.
      server.middlewares.use('/api/search_stream', (_req, res) => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
        });
        res.write('event: search_response_hits\ndata: {"hits":[]}\n\n');
        setTimeout(() => {
          res.write('event: end\ndata: {"took":1200}\n\n');
          res.end();
        }, 1200);
      });

      // Slower than the retired one-second window — the ordinary case for a
      // real query, not an edge case.
      server.middlewares.use('/api/slow.json', (_req, res) => {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ total: 0 }));
        }, 2500);
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  publicDir: '../../playwright/tests/assets',
  plugins: [syntheticsFixtureEndpoints()],
});

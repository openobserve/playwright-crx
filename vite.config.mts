/**
 * Copyright (c) Microsoft Corporation.
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

import path from 'path';
import sourcemaps from 'rollup-plugin-sourcemaps';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';
import replace from '@rollup/plugin-replace';

const baseDir = __dirname.replace(/\\/g, '/');

// https://vitejs.dev/config/
export default defineConfig({
  resolve: {
    alias: {
      // 1.60 moved utils and isomorphic out of playwright-core into top-level packages,
      // and upstream reaches them through these aliases; src/ now does the same.
      // Same reason as the tsconfig path: one yaml, the one the vendored tree uses.
      'yaml': path.resolve(__dirname, './playwright/node_modules/yaml'),
      '@isomorphic': path.resolve(__dirname, './playwright/packages/isomorphic'),
      '@utils': path.resolve(__dirname, './playwright/packages/utils'),
      '@injected': path.resolve(__dirname, './playwright/packages/injected/src'),
      '@protocol': path.resolve(__dirname, './playwright/packages/protocol/src'),
      '@recorder': path.resolve(__dirname, './playwright/packages/recorder/src'),
      '@web': path.resolve(__dirname, './playwright/packages/web/src'),
      '@trace': path.resolve(__dirname, './playwright/packages/trace/src'),
      // Must precede the 'playwright-core/lib' alias below — first match wins, and this
      // one is the more specific.
      'playwright-core/lib/bootstrap': path.resolve(__dirname, './src/shims/bootstrap'),
      'playwright-core/lib': path.resolve(__dirname, './playwright/packages/playwright-core/src'),
      '@playwright/test/lib': path.resolve(__dirname, './playwright/packages/playwright/src'),
      'playwright-core': path.resolve(__dirname, './src/index'),

      // No *BundleImpl aliases here any more. Through 1.59 each vendored dependency was
      // reached through a per-bundle indirection (`./utilsBundleImpl` -> a sub-package with
      // its own node_modules), and every one needed an alias because two different
      // utilsBundleImpl existed. 1.60 (playwright#40074, #40102) deleted that layer
      // outright: utilsBundle.ts and friends now import `colors`, `mime`, `expect` and the
      // rest directly, resolved from playwright/node_modules. `npm run ci:pw:bundles`
      // installs that one tree, and ordinary resolution does the rest.

      // 1.56 made `playwright/src/index.ts` import the MCP test backend, which drags the
      // whole MCP tree — SDK, zod, zod-to-json-schema, node built-ins — into the service
      // worker for a code path that can only no-op inside an extension. Cut at the one
      // edge that reaches it; see the shim for why this is not bundled instead.
      './mcp/test/browserBackend': path.resolve(__dirname, './src/shims/mcpTestBrowserBackend'),

      // shims
      '_url': path.resolve(__dirname, './node_modules/url'),
      '_util': path.resolve(__dirname, './node_modules/util'),
      '_stack-utils': path.resolve(__dirname, './node_modules/stack-utils'),

      'async_hooks': path.resolve(__dirname, './src/shims/async_hooks'),
      'assert': path.resolve(__dirname, './node_modules/assert'),
      'buffer': path.resolve(__dirname, './node_modules/buffer'),
      'child_process': path.resolve(__dirname, './src/shims/child_process'),
      'chokidar': path.resolve(__dirname, './src/shims/chokidar'),
      'constants': path.resolve(__dirname, './node_modules/constants-browserify'),
      'crypto': path.resolve(__dirname, './node_modules/crypto-browserify'),
      'debug': path.resolve(__dirname, './node_modules/debug'),
      'dns': path.resolve(__dirname, './src/shims/dns'),
      'events': path.resolve(__dirname, './node_modules/events'),
      'fs': path.resolve(__dirname, './src/shims/fs'),
      'graceful-fs': path.resolve(__dirname, './src/shims/fs'),
      'http': path.resolve(__dirname, './node_modules/stream-http'),
      'http2': path.resolve(__dirname, './node_modules/stream-http'),
      'https': path.resolve(__dirname, './node_modules/https-browserify'),
      // Node's inspector module — and, more importantly, NOT the unrelated npm package of
      // the same name that sits in devDependencies and cannot load in a browser.
      'inspector': path.resolve(__dirname, './src/shims/inspector'),
      'module': path.resolve(__dirname, './src/shims/module'),
      'net': path.resolve(__dirname, './src/shims/net'),
      'os': path.resolve(__dirname, './node_modules/os-browserify/browser'),
      'path': path.resolve(__dirname, './node_modules/path'),
      'process': path.resolve(__dirname, './node_modules/process'),
      'readline': path.resolve(__dirname, './src/shims/readline'),
      'setimmediate': path.resolve(__dirname, './node_modules/setimmediate'),
      'stream': path.resolve(__dirname, './node_modules/readable-stream'),
      'tls': path.resolve(__dirname, './src/shims/tls'),
      'url': path.resolve(__dirname, './src/shims/url'),
      'zlib': path.resolve(__dirname, './node_modules/browserify-zlib'),

      'fs/promises': path.resolve(__dirname, './src/shims/fs/promises'),

      // The MCP SDK imports its node built-ins with the `node:` prefix, which the
      // unprefixed aliases above do not match. Same targets, so a module reached both
      // ways resolves to one shim rather than two copies of it.
      'node:child_process': path.resolve(__dirname, './src/shims/child_process'),
      'node:crypto': path.resolve(__dirname, './node_modules/crypto-browserify'),
      'node:fs': path.resolve(__dirname, './src/shims/fs'),
      'node:path': path.resolve(__dirname, './node_modules/path'),
      'node:process': path.resolve(__dirname, './node_modules/process'),
      'node:tls': path.resolve(__dirname, './src/shims/tls'),
      'node:url': path.resolve(__dirname, './src/shims/url'),
      'node:events': path.resolve(__dirname, './node_modules/events'),
      'node:module': path.resolve(__dirname, './src/shims/module'),
      'node:stream': path.resolve(__dirname, './node_modules/readable-stream'),
      'node:string_decoder': path.resolve(__dirname, './node_modules/string_decoder'),
    },
  },
  define: {
    'require.resolve': 'Boolean',
  },
  plugins: [
    replace({
      'preventAssignment': true,
      '__dirname': id => {
        const relativePath = path.posix.relative(baseDir, path.posix.dirname(id));
        return [
          'src',
          'playwright/packages/playwright-core/src',
          'playwright/packages/playwright/src',
        ].some(p => relativePath.startsWith(p)) ? JSON.stringify(relativePath) : '__dirname';
      },
    }) as Plugin<any>,
  ],
  build: {
    outDir: path.resolve(__dirname, './lib/'),
    assetsInlineLimit: 0,
    // skip code obfuscation
    minify: false,
    lib: {
      entry: {
        index: path.resolve(__dirname, 'src/index.ts'),
        test: path.resolve(__dirname, 'src/test.ts'),
      },
    },
    sourcemap: true,
    rollupOptions: {
      // @ts-ignore
      plugins: [sourcemaps()],
      output: {
        exports: 'named',
      },
    },
    commonjsOptions: {
      transformMixedEsModules: true,
      extensions: ['.ts', '.js'],
      exclude: [
        path.resolve(__dirname, './playwright/packages/playwright/src/index.ts'),
        path.resolve(__dirname, './playwright/packages/playwright-core/src/cli/**/*.ts'),
        // prevent from resolving require('../playwright')
        path.resolve(__dirname, './playwright/packages/playwright-core/src/server/recorder/recorderApp.ts'),
        // prevent from resolving require('./bidiOverCdp')
        path.resolve(__dirname, './playwright/packages/playwright-core/src/server/bidi/bidiChromium.ts'),
      ],
      include: [
        path.resolve(__dirname, './playwright/packages/playwright/src/**/*'),
        path.resolve(__dirname, './playwright/packages/playwright-core/src/**/*'),
        // 1.60 moved these out of playwright-core, and they carry vendored CJS of their
        // own (utils/third_party/pixelmatch.js). Without them here the CommonJS transform
        // skips those files and a default import of one resolves to nothing.
        path.resolve(__dirname, './playwright/packages/utils/**/*'),
        path.resolve(__dirname, './playwright/packages/isomorphic/**/*'),
        /node_modules/,
      ],
    }
  },
});

import path from 'path';
import { defineConfig } from 'vite';

const rootDir = path.resolve(__dirname, '../..');

// https://vitejs.dev/config/
export default defineConfig({
  resolve: {
    alias: {
      // playwright-crx built library
      'playwright-crx': path.resolve(rootDir, 'lib/index.mjs'),
    },
  },
  build: {
    outDir: 'dist',
    minify: false,
    sourcemap: true,
    chunkSizeWarningLimit: 10240,
    rollupOptions: {
      // The content script is NOT built here — see vite.content.config.ts. Both
      // entries below are loaded as ES modules (the service worker via
      // "type": "module" in the manifest, the popup via <script type="module">),
      // so a shared messaging.js chunk is fine for them.
      input: {
        background: path.resolve(__dirname, 'src/background.ts'),
        // popup.html is copied verbatim from public/ and loads this by <script src>.
        popup: path.resolve(__dirname, 'src/popup.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
});

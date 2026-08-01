import path from 'path';
import { defineConfig } from 'vite';

const rootDir = path.resolve(__dirname, '../..');

/**
 * Separate build for the content script.
 *
 * A content script declared in `content_scripts` is loaded as a classic script —
 * it cannot be an ES module. The main config has several entries that share
 * `messaging.ts`, so Rollup hoists those shared runtime constants into a
 * `messaging.js` chunk and emits `import ... from "./messaging.js"` at the top of
 * every entry that uses them. In `content.js` that import is fatal: Chrome refuses
 * to load the script, the bridge never installs, and the web app reports the
 * extension as missing.
 *
 * Building it alone as an IIFE inlines its dependencies, so it stays a classic
 * script no matter what it imports. Run after the main build with
 * `emptyOutDir: false` so it lands alongside the other entries.
 */
export default defineConfig({
  resolve: {
    alias: {
      'playwright-crx': path.resolve(rootDir, 'lib/index.mjs'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/content.ts'),
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'content.js',
      },
    },
  },
});

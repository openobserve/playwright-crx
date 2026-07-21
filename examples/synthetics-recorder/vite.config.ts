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
      input: {
        background: path.resolve(__dirname, 'src/background.ts'),
        content: path.resolve(__dirname, 'src/content.ts'),
        options: path.resolve(__dirname, 'src/options.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
});

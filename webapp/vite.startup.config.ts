import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  base: './',
  plugins: [react()],
  build: {
    outDir: path.join(root, 'dist', 'startup-splash'),
    emptyOutDir: false,
    rollupOptions: {
      input: path.join(root, 'startup.html'),
    },
  },
});

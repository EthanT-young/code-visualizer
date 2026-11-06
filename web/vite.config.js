import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so the built site also works under a path like /visualizer/.
  base: './',
  // CodeMirror's three language grammars make the bundle ~240 KB gzipped; that's fine.
  build: { chunkSizeWarningLimit: 900 },
  server: {
    // `npm run dev`: Java and C++ runs go to the server started with compose.local.yml.
    proxy: { '/api': 'http://localhost:8080' },
  },
});

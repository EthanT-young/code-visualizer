import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so the built site also works under a path like /visualizer/.
  base: './',
  build: {
    // Monaco (VS Code's editor) is ~750 KB gzipped. It goes in its own file so browsers
    // keep it cached when the rest of the site changes.
    chunkSizeWarningLimit: 3000,
    rollupOptions: { output: { manualChunks: { monaco: ['monaco-editor/esm/vs/editor/editor.api.js'] } } },
  },
  server: {
    // `npm run dev`: Java and C++ runs go to the server started with compose.local.yml.
    proxy: { '/api': 'http://localhost:8080' },
  },
});

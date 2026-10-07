import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'web' ? [viteSingleFile()] : [])],
  define: mode === 'web' ? {'import.meta.env.VITE_STORAGE_MODE':JSON.stringify('browser')} : {},
  base: mode === 'web' ? './' : '/',
  server: {host:'0.0.0.0',port:5173,proxy:{'/api':'http://127.0.0.1:3001'}},
  build: {outDir: mode === 'web' ? 'dist-web' : 'dist'},
}));

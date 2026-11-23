import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    // WEB_PORT permite subir um segundo servidor de desenvolvimento (ex.: o da cópia do banco).
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: !!process.env.WEB_PORT,
    proxy: { '/api': `http://127.0.0.1:${process.env.API_PORT ?? 3333}` },
  },
});

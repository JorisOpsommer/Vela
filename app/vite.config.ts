import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// The pages share one bundle graph; the server gates them behind the session.
export default defineConfig({
    root: resolve(__dirname, 'web'),
    publicDir: resolve(__dirname, 'web/public'),
    base: '/',
    build: {
        outDir: resolve(__dirname, 'dist/web'),
        emptyOutDir: true,
        sourcemap: false,
        chunkSizeWarningLimit: 4096,
        rollupOptions: {
            input: {
                index: resolve(__dirname, 'web/index.html'),
                login: resolve(__dirname, 'web/login.html'),
                account: resolve(__dirname, 'web/account.html'),
                stats: resolve(__dirname, 'web/stats.html'),
                insights: resolve(__dirname, 'web/insights.html'),
                cache: resolve(__dirname, 'web/cache.html'),
            },
        },
    },
});

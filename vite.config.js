import { defineConfig } from 'vite';

export default defineConfig({
    // Root directory for the project
    root: '.',

    // Development server configuration
    server: {
        port: 3000,
        open: true,
        // Proxy API routes to Vercel dev server in development
        proxy: {
            '/api': {
                target: 'http://localhost:3001',
                changeOrigin: true
            }
        }
    },

    // Build configuration
    build: {
        outDir: 'dist',
        sourcemap: true,
        // Ensure clean builds
        emptyOutDir: true
    },

    // Environment variables prefix
    envPrefix: 'VITE_',

    // Resolve configuration
    resolve: {
        alias: {
            '@': '/src'
        }
    }
});

import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
    plugins: [react(), tailwindcss(), cloudflare()],
    resolve: {
        alias: {
            // 与 kryva 一致: @ 指向前端源码目录.
            '@': fileURLToPath(new URL('./src/web', import.meta.url)),
        },
    },
})

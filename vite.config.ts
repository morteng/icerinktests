import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  base: '/icerinktests/',
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        spriteStudio: resolve(__dirname, 'sprite-studio.html'),
      },
    },
  },
})

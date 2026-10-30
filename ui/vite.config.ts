import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const root = fileURLToPath(new URL('.', import.meta.url))
const themeScript = readFileSync(new URL('./src/theme-init.js', import.meta.url), 'utf8')
const themeAsset = 'assets/theme-init-' + createHash('sha256').update(themeScript).digest('hex').slice(0, 10) + '.js'
let building = false
const devApi = process.env.FLUX_DEV_API_URL
if (devApi && !/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+$/.test(devApi)) throw new Error('FLUX_DEV_API_URL must be an explicit loopback HTTP origin with port')

export default defineConfig({
  root,
  base: '/build/',
  publicDir: false,
  plugins: [react(), tailwindcss(), {
    name: 'flux-theme-before-paint',
    configResolved(config) { building = config.command === 'build' },
    generateBundle() { this.emitFile({ type: 'asset', fileName: themeAsset, source: themeScript }) },
    transformIndexHtml: {
      order: 'post',
      handler() {
        return [{ tag: 'script', attrs: { src: building ? '/build/' + themeAsset : '/src/theme-init.js' }, injectTo: 'head-prepend' }]
      },
    },
  }],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: devApi ? Object.fromEntries(['/api', '/images', '/fonts'].map(path => [path, devApi])) : undefined,
  },
  build: {
    outDir: fileURLToPath(new URL('../public/build', import.meta.url)),
    emptyOutDir: true,
    assetsDir: 'assets',
  },
})

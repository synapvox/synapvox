import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    server: {
      proxy: {
        // STT 통합 API(backend/integration/api/main.py). 배포에선 프록시 대신 리버스프록시/같은 도메인 사용.
        '/api': env.VITE_STT_PROXY_TARGET ?? 'http://127.0.0.1:8000',
      },
    },
  }
})

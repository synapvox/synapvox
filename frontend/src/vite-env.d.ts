/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Graphiti 백엔드 API 베이스 URL (기본: 배포된 Render Graphiti API) */
  readonly VITE_API_BASE?: string;
  /** 백엔드 X-API-Key (공개 데모 키) */
  readonly VITE_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

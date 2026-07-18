/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Graphiti 백엔드 API 베이스 URL (기본: 배포된 Render Graphiti API) */
  readonly VITE_API_BASE?: string;
  /** 백엔드 X-API-Key (공개 데모 키) */
  readonly VITE_API_KEY?: string;
  /**
   * 통합 API(backend) 절대 주소. 배포 환경에서 오래 걸리는 요청(전사·그래프
   * 적재·채팅 스트리밍)을 Netlify 프록시(~26초 타임아웃)로 보내지 않고 backend에
   * 직접 보내기 위해 사용한다. 로컬 개발에서는 비워 두면 same-origin(/api → vite
   * proxy)으로 동작한다. 설정 시 backend CORS(SYNAPVOX_ALLOWED_ORIGINS)에 이
   * 프론트 도메인이 허용돼 있어야 한다.
   */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

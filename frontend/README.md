# frontend — SynapVox 웹 UI

담당: 도원

녹음본, 자료, 전사문, 그래프 뷰, AI 대화를 한 프로젝트 화면에서 다루는 React 프론트엔드입니다.

## 현재 흐름
- 홈에서 프로젝트를 만들고 프로젝트별 녹음본·자료를 관리
- 프로젝트 안에서 소스 카드, 그래프 뷰, AI 대화를 한 화면에 배치
- 웹 녹음 또는 녹음된 파일 업로드 후 `/api/stt/transcribe`로 전사 요청
- 전사 결과를 화자별 음성 기록으로 매핑하고 녹음본 상세 화면에서 확인·편집·복사

## 연동
- 개발 서버의 `/api` 요청은 `http://127.0.0.1:8000` 백엔드로 프록시합니다.
- 프로젝트 자료와 녹음본 참고 파일은 전사 요청 시 함께 전송할 수 있습니다.

## 스택
Vite + React 19 + TypeScript

## 구조
- `src/App.tsx` — 주요 화면과 상태 관리
- `src/App.css` — 화면 레이아웃과 인터랙션 스타일
- `public/`

## 실행
```
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build
```

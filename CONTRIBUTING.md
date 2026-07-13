# 기여 규칙

4인 병렬 개발(A: stt, B: chunking, C: graphrag, D: integration/frontend)을 위한 로컬 규칙. 강제되지 않으므로 팀원 모두 지켜야 의미가 있다.

## 브랜치 규칙

```
<type>/<module>-<short-desc>
```

- `type`: `feat` `fix` `chore` `docs` `test` 중 하나
- `module`: `stt` `chunking` `graphrag` `integration` `frontend` `schemas`

예: `feat/stt-whisper-streaming`, `fix/graphrag-cypher-query`, `docs/schemas-v0.2`

## 커밋 컨벤션 (Conventional Commits)

```
<type>: <설명>
```

- `feat:` 새 기능
- `fix:` 버그 수정
- `chore:` 잡일 (의존성, 설정 등)
- `docs:` 문서만 변경
- `test:` 테스트 추가/수정
- `refactor:` 동작 변화 없는 구조 변경

예: `feat: chunking Topic 추출 프롬프트 추가`, `fix: intermediate_format corrections 필드 누락 수정`

## 병합

- `main`에는 직접 push하지 않고 PR로만 병합한다.
- PR은 최소 1명 리뷰 후 병합 (특히 `schemas/` 변경은 영향받는 담당자 전원 확인 — [`schemas/README.md`](schemas/README.md) 참고).
- 자기 모듈(`backend/<module>/`) 안의 변경은 가볍게, `schemas/`나 `backend/integration/`처럼 여러 모듈이 걸린 변경은 PR 설명에 영향 범위를 적는다.

## 스키마 변경

`schemas/` 아래 3개 파일은 모듈 간 유일한 계약이다. 변경 시:
1. 소유자가 PR로 제안
2. 영향받는 담당자 전원이 리뷰/합의
3. 버전(주석 또는 커밋 메시지)에 명시

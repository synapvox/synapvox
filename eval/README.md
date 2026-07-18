# RAG 평가 하네스

설계: 저장소 밖 `rag-evaluation-plan.md` §3 · 게이트 기준: `qa-plan.md` §3

## 사용

```bash
# 1) 하네스 자체 검증 (네트워크 불필요 — 가짜 클라이언트·judge)
python eval/run_eval.py --self-test

# 2) 골드셋 파일명이 실제 에피소드와 매칭되는지만 검사 (Neo4j 필요, OpenAI 불필요)
python eval/run_eval.py --project <group_id> --resolve-only

# 3) 자동 지표만 (Hit Rate/MRR — OpenAI 불필요)
python eval/run_eval.py --project <group_id> --skip-judge

# 4) 전체 평가 (judge 포함 — OPENAI_API_KEY 필요)
python eval/run_eval.py --project <group_id>
```

- `<group_id>`: 프로젝트 id (예: `p-xxxx…` — 홈에서 프로젝트 열었을 때 `/api/graph?project=` 값)
- judge 모델: 기본 `gpt-5-mini`, `EVAL_JUDGE_MODEL` 환경변수 또는 `--judge-model`로 변경
- 결과: `eval/results/<날짜>_<커밋>.json` — 지표 + 게이트 판정 + **실패 사례 원문**(질문·답변·근거·사유)

## 골드셋 작성

`goldset.jsonl` — 현재 내용은 **파일럿 예시 3문항**(계획서 §2의 예시 그대로)이므로,
실제 적재된 강의 기준으로 교체해야 한다. 형식·유형 분포·제작 절차는 계획서 §2 참조.
`--resolve-only`로 파일명 매칭을 먼저 확인할 것.

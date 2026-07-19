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

## 구조 — 코드와 데이터셋 분리

```
eval/
  run_eval.py        # 하네스 (§3)
  judge_prompts.py   # LLM-as-judge 프롬프트
  ingest_ch4.py      # 평가 코퍼스 적재 (§2.5·§5-0)
  dataset/
    goldset.jsonl            # 골드셋 47문항 (아래)
    goldset_selftest.jsonl   # --self-test 전용 고정 파일럿(5문항) — 건드리지 말 것
    scripts/                 # Chapter 4 합성 대본 5개 (평가 재현용 — 합성이라 커밋 포함)
  results/           # 실행 결과 JSON (커밋 제외)
```

## 골드셋

`dataset/goldset.jsonl` — **Chapter 4 대본(범주형 데이터·로지스틱 회귀) 기준 49문항**:
definition 10 · relation 10 · multi_hop 10(전원 세션 간) · causal 7 · temporal 6 · global 3 · abstain 3.
멀티홉 질문은 각 gold 세션의 개념 앵커를 대본 용어로 1개 이상 포함하되(검색 가능성),
연결 논리 자체는 질문에 넣지 않는다(오염 방지) — 사람 검수(2026-07-19)에서 확립한 원칙.
평가 대상은 **평가 전용 프로젝트 `p-eval-ch4`** (2026-07-19 적재 완료, 세션 5개).
형식·유형 분포·제작 절차는 계획서 §2 참조. 문항 수정 후 `--resolve-only`로 파일명 매칭을 확인할 것.

## 평가 코퍼스 적재 (§2.5·§5-0)

대본 5개(4.1~4.4 본 강의 = T1, 4.5 보강 정정공지 = T2)를 content_date 지정으로 적재한다
(4.1~4.4는 2026-03-02~03-23 주차별, 4.5는 2026-05-11 — §0.5: 생략 시 now()로 덮임):

```bash
python eval/ingest_ch4.py --project <group_id>   # 대본은 기본 eval/dataset/scripts/
```

- temporal 6문항(q-t01~06)은 4.5의 **명시적 갱신 신호** 3종(logit→probit, OR→RR,
  카이제곱→Fisher) × current/historical. `temporal_kind` 필드로 구분, 집계는
  current(갱신 반영)/historical(과거 보존) 분리 (§1① temporal 정확도).
- ⚠️ abstain·global 문항이 "이 코퍼스가 전부"임을 전제하므로 **빈 평가 전용 프로젝트**에
  적재할 것 — 다른 강의와 섞이면 문항이 오염된다. 4.5는 합성 '정정'이라 실사용
  프로젝트 적재 금지, 결과 보고 시 "설계된 시간 테스트" 명시 (§6).

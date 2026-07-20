"""RAG 평가 하네스 — rag-evaluation-plan.md §3 구현 (C 시스템 단독).

사용:
  python eval/run_eval.py --project <group_id>                  # 전체 평가 (Neo4j·OpenAI 필요)
  python eval/run_eval.py --project <group_id> --resolve-only   # 골드셋 파일명 해석만 (파일럿 검증)
  python eval/run_eval.py --self-test                           # 가짜 클라이언트로 하네스 자체 검증

동작(§3): 골드셋 로드 → 파일명 해석 → ask() 루프 → 자동 지표(Hit Rate/MRR, global·abstain 제외)
→ judge 지표(faithfulness/citation/기권/correctness) → 유형별 집계(n 병기) + 게이트 판정
→ results/에 결과·실패 사례 원문 저장.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

EVAL_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(REPO_ROOT / ".env")

import eval.judge_prompts as prompts  # noqa: E402

VALID_TYPES = {"definition", "relation", "multi_hop", "causal", "temporal", "global", "abstain"}
# global·abstain은 특정 gold 근거가 없어 retrieval 지표에서 제외 (§1① 규칙)
RETRIEVAL_EXEMPT = {"global", "abstain"}
DEFAULT_JUDGE_MODEL = "gpt-5-mini"


# ── 골드셋 ─────────────────────────────────────────────


def load_goldset(path: Path) -> list[dict]:
    items = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        item = json.loads(line)
        for key in ("id", "question", "question_type", "gold_answer", "gold_sources"):
            if key not in item:
                raise ValueError(f"goldset {line_no}행: '{key}' 필드 누락 (id={item.get('id')})")
        if item["question_type"] not in VALID_TYPES:
            raise ValueError(f"goldset {line_no}행: 알 수 없는 question_type '{item['question_type']}'")
        if item["question_type"] in RETRIEVAL_EXEMPT and item["gold_sources"]:
            raise ValueError(f"goldset {line_no}행: {item['question_type']} 문항은 gold_sources가 비어야 함")
        if item["question_type"] == "temporal" and item.get("temporal_kind") not in ("current", "historical"):
            raise ValueError(
                f"goldset {line_no}행: temporal 문항은 temporal_kind(current|historical)가 필요함 (§2.5)")
        items.append(item)
    return items


def title_matches(gold: str, title: str) -> bool:
    """gold 파일명과 에피소드 제목 매칭 — 제목의 (meeting_id)·(i/N) 접미사, 확장자 유무를 흡수."""
    stem = Path(gold).stem
    return title == gold or title == stem or title.startswith(f"{gold} (") or title.startswith(f"{stem} (")


def resolve_gold_sources(items: list[dict], session_titles: list[str]) -> list[str]:
    """모든 gold 파일명이 실제 에피소드 제목과 매칭되는지 검사 — 미해석 목록 반환 (§2 파일럿 검증)."""
    unresolved = []
    for item in items:
        for gold in item["gold_sources"]:
            if not any(title_matches(gold, title) for title in session_titles):
                unresolved.append(f"{item['id']}: '{gold}'")
    return unresolved


# ── 자동 지표 (LLM 없이) ───────────────────────────────


def retrieval_metrics(item: dict, hits: list[dict]) -> dict:
    """Hit Rate@k(gold 중 하나라도 회수), MRR용 첫 정답 순위, gold 회수 비율."""
    golds = item["gold_sources"]
    hit_titles = [
        [str(source.get("title") or "") for source in (hit.get("sources") or [])]
        for hit in hits
    ]
    first_rank = None
    matched: set[str] = set()
    for rank, titles in enumerate(hit_titles, 1):
        for gold in golds:
            if any(title_matches(gold, title) for title in titles):
                matched.add(gold)
                if first_rank is None:
                    first_rank = rank
    # multi_hop은 두 세션을 잇는 질문이라 gold 전부 회수해야 성공 — 하나만 잡으면
    # "연결 실패"인데 관대 기준으로는 B vs C 격차(§4 핵심 주장)가 측정되지 않는다.
    if item["question_type"] == "multi_hop":
        hit = matched == set(golds)
    else:
        hit = bool(matched)
    return {
        "hit": hit,
        "rank": first_rank,
        "gold_recall": (len(matched) / len(golds)) if golds else None,
    }


def evidence_block(hits: list[dict]) -> str:
    """judge에 넣을 번호 붙은 근거 목록 — 답변의 [n]과 동일한 번호 체계 (hits 순서 1:1)."""
    lines = []
    for index, hit in enumerate(hits, 1):
        titles = ", ".join(
            str(source.get("title") or "") for source in (hit.get("sources") or [])) or "출처 미상"
        lines.append(f"[{index}] ({titles}) {hit.get('fact') or hit.get('name') or ''}")
    return "\n".join(lines) or "(검색된 근거 없음)"


# ── judge ──────────────────────────────────────────────


def make_openai_judge(model: str):
    """OpenAI judge — (system, user) → 파싱된 JSON dict."""
    from openai import OpenAI

    from backend.observability import wrap_openai_client

    client = wrap_openai_client(OpenAI(api_key=os.environ["OPENAI_API_KEY"]))

    def judge(system: str, user: str) -> dict:
        request = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "response_format": {"type": "json_object"},
        }
        if model.startswith("gpt-5"):
            request["reasoning_effort"] = "low"
        response = client.chat.completions.create(**request)
        return json.loads(response.choices[0].message.content or "{}")

    return judge


def judge_item(item: dict, answer: str, hits: list[dict], judge) -> dict:
    """문항 유형에 맞는 judge들을 호출해 판정 결과를 모은다 (§3 ④)."""
    result: dict = {}
    if item["question_type"] == "abstain":
        verdict = judge(prompts.ABSTAIN_SYSTEM, prompts.ABSTAIN_USER.format(
            question=item["question"], answer=answer))
        result["abstained_ok"] = bool(verdict.get("abstained"))
        result["abstain_reason"] = verdict.get("reason", "")
        return result

    evidence = evidence_block(hits)
    correctness = judge(prompts.CORRECTNESS_SYSTEM, prompts.CORRECTNESS_USER.format(
        question=item["question"], gold_answer=item["gold_answer"], answer=answer))
    result["correctness"] = int(correctness.get("score") or 0)
    result["correctness_reason"] = correctness.get("reason", "")

    faith = judge(prompts.FAITHFULNESS_SYSTEM, prompts.FAITHFULNESS_USER.format(
        evidence=evidence, answer=answer))
    claims = [claim for claim in faith.get("claims", []) if isinstance(claim, dict)]
    result["claims_total"] = len(claims)
    result["claims_supported"] = sum(1 for claim in claims if claim.get("supported"))
    # Citation Recall(§1②): 근거가 필요한 주장(=분해된 주장) 중 인용이 달린 비율 —
    # 주장 분해를 이미 하는 faithfulness judge가 cited를 함께 판정
    result["claims_cited"] = sum(1 for claim in claims if claim.get("cited"))
    result["unsupported_claims"] = [
        {"claim": claim.get("claim", ""), "reason": claim.get("reason", "")}
        for claim in claims if not claim.get("supported")
    ]

    if re.search(r"\[\d+\]", answer):
        cited = judge(prompts.CITATION_SYSTEM, prompts.CITATION_USER.format(
            evidence=evidence, answer=answer))
        citations = [c for c in cited.get("citations", []) if isinstance(c, dict)]
        result["citations_total"] = len(citations)
        result["citations_supported"] = sum(1 for c in citations if c.get("supported"))
        result["bad_citations"] = [
            {"n": c.get("n"), "claim": c.get("claim", ""), "reason": c.get("reason", "")}
            for c in citations if not c.get("supported")
        ]
    else:
        result["citations_total"] = 0
        result["citations_supported"] = 0
        result["bad_citations"] = []
    return result


# ── 집계·게이트·실패 사례 ──────────────────────────────


def _ratio(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 4) if denominator else None


def aggregate(records: list[dict]) -> dict:
    """전체 + question_type별 지표 (n 병기 — §6 소표본 원칙)."""

    def summarize(group: list[dict]) -> dict:
        scored = [r for r in group if r["question_type"] not in RETRIEVAL_EXEMPT]
        judged = [r for r in group if "correctness" in r]
        abstains = [r for r in group if r["question_type"] == "abstain"]
        ranks = [r["rank"] for r in scored if r.get("rank")]
        recalls = [r["gold_recall"] for r in scored if r.get("gold_recall") is not None]
        return {
            "n": len(group),
            # 부분 회수율 — multi_hop 엄격 hit(전부 회수)과 함께 보면 "반쪽 회수"가 보인다
            "gold_recall_avg": round(sum(recalls) / len(recalls), 4) if recalls else None,
            "hit_rate": _ratio(sum(1 for r in scored if r.get("hit")), len(scored)),
            "mrr": round(sum(1 / rank for rank in ranks) / len(scored), 4) if scored else None,
            "correctness_avg": round(
                sum(r["correctness"] for r in judged) / len(judged), 2) if judged else None,
            "faithfulness": _ratio(
                sum(r.get("claims_supported", 0) for r in judged),
                sum(r.get("claims_total", 0) for r in judged)),
            "citation_precision": _ratio(
                sum(r.get("citations_supported", 0) for r in judged),
                sum(r.get("citations_total", 0) for r in judged)),
            "citation_recall": _ratio(
                sum(r.get("claims_cited", 0) for r in judged),
                sum(r.get("claims_total", 0) for r in judged)),
            "abstain_accuracy": _ratio(
                sum(1 for r in abstains if r.get("abstained_ok")), len(abstains)),
        }

    by_type: dict[str, list[dict]] = {}
    for record in records:
        by_type.setdefault(record["question_type"], []).append(record)
    # temporal 정확도(§1①): 단순 Hit이 아니라 "올바른 시점의 근거를 집었는가" —
    # current(T2)/historical(T1)을 나눠 집계
    for kind in ("current", "historical"):
        group = [r for r in by_type.get("temporal", []) if r.get("temporal_kind") == kind]
        if group:
            by_type[f"temporal({kind})"] = group
    return {
        "overall": summarize(records),
        "by_type": {qtype: summarize(group) for qtype, group in sorted(by_type.items())},
        # 핵심 주장 축 합산(n=20 목표) — §2 검정 노트
        "core_claim_combined": summarize(
            [r for r in records if r["question_type"] in ("multi_hop", "relation")]),
    }


def gate_check(overall: dict) -> list[str]:
    """qa-plan.md §3 배포 보류 게이트 중 하네스가 판정 가능한 항목."""
    failures = []
    citation = overall.get("citation_precision")
    if citation is not None and citation < 0.90:
        failures.append(f"인용 정확도 {citation:.0%} < 90%")
    faith = overall.get("faithfulness")
    if faith is not None and (1 - faith) > 0.05:
        failures.append(f"환각 주장 비율 {1 - faith:.0%} > 5%")
    return failures


def collect_failures(records: list[dict]) -> list[dict]:
    """§3 ⑥ — 틀린 문항의 원문(질문·답변·근거·판정 사유)을 실패 카탈로그 입력으로."""
    failures = []
    for record in records:
        reasons = []
        if record["question_type"] not in RETRIEVAL_EXEMPT and not record.get("hit"):
            reasons.append("retrieval-miss: gold 근거가 top-k에 없음")
        if record.get("correctness") is not None and record.get("correctness", 5) <= 2:
            reasons.append(f"correctness {record['correctness']}/5: {record.get('correctness_reason', '')}")
        for claim in record.get("unsupported_claims", []):
            reasons.append(f"unsupported: {claim['claim']} ({claim['reason']})")
        for citation in record.get("bad_citations", []):
            reasons.append(f"bad-citation [{citation['n']}]: {citation['claim']} ({citation['reason']})")
        if record["question_type"] == "abstain" and not record.get("abstained_ok"):
            reasons.append(f"기권 실패: {record.get('abstain_reason', '')}")
        if reasons:
            failures.append({
                "id": record["id"],
                "question_type": record["question_type"],
                "question": record["question"],
                "answer": record.get("answer", ""),
                "evidence": record.get("evidence", ""),
                "reasons": reasons,
            })
    return failures


# ── 실행 ───────────────────────────────────────────────


def git_commit_hash() -> str:
    try:
        return subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], cwd=REPO_ROOT,
            capture_output=True, text=True, check=True).stdout.strip()
    except Exception:  # noqa: BLE001
        return "unknown"


def run(project: str, goldset_path: Path, k: int, judge_model: str,
        client=None, judge=None, skip_judge: bool = False) -> dict:
    items = load_goldset(goldset_path)

    if client is None:
        from backend.integration.gsvx_connector import GsvxClient

        client = GsvxClient()

    graph = client.graph(project)
    session_titles = [
        str(node.get("label") or "") for node in graph.get("nodes", [])
        if node.get("type") == "session"
    ]
    unresolved = resolve_gold_sources(items, session_titles)
    for warning in unresolved:
        print(f"⚠️ gold_sources 미해석: {warning}")

    if judge is None and not skip_judge:
        judge = make_openai_judge(judge_model)

    records = []
    for item in items:
        response = client.ask(project, item["question"], k)
        answer = str(response.get("answer") or "")
        hits = response.get("hits") or []
        record = {
            "id": item["id"],
            "question_type": item["question_type"],
            "temporal_kind": item.get("temporal_kind"),
            "question": item["question"],
            "answer": answer,
            "evidence": evidence_block(hits),
            **retrieval_metrics(item, hits),
        }
        if not skip_judge:
            record.update(judge_item(item, answer, hits, judge))
        records.append(record)
        print(f"  {item['id']} [{item['question_type']}] hit={record.get('hit')} "
              f"correctness={record.get('correctness', '-')}")

    metrics = aggregate(records)
    gate_failures = gate_check(metrics["overall"])
    result = {
        "meta": {
            "date": date.today().isoformat(),
            "commit": git_commit_hash(),
            "project": project,
            "k": k,
            "judge_model": judge_model if not skip_judge else None,
            "answer_model": os.getenv("GRAPHITI_ANSWER_MODEL") or "gpt-4o-mini",
            "graph_sessions": len(session_titles),  # 재현성: 평가 시점 그래프 상태 (§6)
            "graph_session_titles": sorted(session_titles),  # §6 "적재된 강의 목록" 기록
            "goldset_unresolved": unresolved,
        },
        "metrics": metrics,
        "gate": {"passed": not gate_failures, "failures": gate_failures},
        "failures": collect_failures(records),
    }
    return result


def print_report(result: dict) -> None:
    print("\n== 지표 (유형별, n 병기) ==")
    header = f"{'유형':<14}{'n':>3}{'hit':>7}{'mrr':>7}{'정답':>6}{'충실':>7}{'인용P':>7}{'인용R':>7}{'기권':>7}"
    print(header)

    def row(name: str, m: dict) -> str:
        def fmt(value, pct=True):
            if value is None:
                return "-"
            return f"{value:.0%}" if pct else f"{value}"
        return (f"{name:<14}{m['n']:>3}{fmt(m['hit_rate']):>7}"
                f"{fmt(m['mrr']):>7}{m['correctness_avg'] if m['correctness_avg'] is not None else '-':>6}"
                f"{fmt(m['faithfulness']):>7}{fmt(m['citation_precision']):>7}"
                f"{fmt(m['citation_recall']):>7}{fmt(m['abstain_accuracy']):>7}")

    print(row("전체", result["metrics"]["overall"]))
    for qtype, m in result["metrics"]["by_type"].items():
        print(row(qtype, m))
    print(row("핵심축 합산", result["metrics"]["core_claim_combined"]))

    gate = result["gate"]
    print(f"\n== 게이트: {'✅ 통과' if gate['passed'] else '🚫 보류'} ==")
    for failure in gate["failures"]:
        print(f"  - {failure}")
    print(f"\n실패 사례 {len(result['failures'])}건 (results/ JSON의 failures 참조)")


def save_results(result: dict) -> Path:
    results_dir = EVAL_DIR / "results"
    results_dir.mkdir(exist_ok=True)
    path = results_dir / f"{result['meta']['date']}_{result['meta']['commit']}.json"
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


# ── self-test: 가짜 클라이언트·judge로 파이프라인 자체 검증 ──


def self_test() -> None:
    """네트워크 없이 하네스 배관을 검증 — 파일럿 3문항, 결정적 가짜 응답."""

    class _FakeClient:
        def graph(self, project):
            return {"nodes": [
                {"id": "u1", "type": "session", "label": "3주차 강의.m4a"},
                {"id": "u2", "type": "session", "label": "3장 슬라이드 (M01)"},
                {"id": "u3", "type": "session", "label": "초판 노트"},
                {"id": "u4", "type": "session", "label": "개정판 노트"},
            ]}

        def ask(self, project, question, k):
            if "너무 크면" in question:  # q-001: 정상 — 근거 회수 + 옳은 답
                return {"answer": "발산할 수 있다 [1]", "hits": [
                    {"fact": "학습률이 크면 발산", "sources": [{"title": "3주차 강의.m4a"}]},
                ]}
            if "관계" in question:  # q-002: retrieval-miss + 나쁜 인용 (실패 수집 검증)
                return {"answer": "보폭을 결정한다 [1]", "hits": [
                    {"fact": "무관한 fact", "sources": [{"title": "다른 자료.pdf"}]},
                ]}
            if "연결" in question:  # q-006: gold 2개 중 1개만 회수 — multi_hop 엄격 기준 miss 검증
                return {"answer": "학습률 보폭이 발산 사례와 연결된다 [1]", "hits": [
                    {"fact": "학습률이 크면 발산", "sources": [{"title": "3주차 강의.m4a"}]},
                ]}
            if "처음" in question:  # q-005: 시점 miss + 인용 없는 답 (citation recall 저하 검증)
                return {"answer": "probit이 기본이다", "hits": [
                    {"fact": "기본 링크를 probit으로 교체", "sources": [{"title": "개정판 노트"}]},
                ]}
            if "링크" in question:  # q-004: 올바른 시점(T2) 회수 — current hit
                return {"answer": "probit이 기본이다 [1]", "hits": [
                    {"fact": "기본 링크를 probit으로 교체", "sources": [{"title": "개정판 노트"}]},
                ]}
            return {"answer": "자료에 근거가 없어 답할 수 없습니다.", "hits": []}  # q-003: 기권

    def _fake_judge(system: str, user: str) -> dict:
        ok = "발산" in user or "probit" in user  # q-001·temporal만 지지/정답 (q-002는 실패 유지)
        if "기권 판정자" in system:
            return {"abstained": "없어" in user or "없습니다" in user, "reason": "기권 표현"}
        if "인용 검증자" in system:
            return {"citations": [{"n": 1, "claim": "…", "supported": ok, "reason": "대조"}]}
        if "검증자" in system:
            cited = "[1]" in user.split("# 답변")[-1]  # 근거 목록의 [1] 말고 답변의 인용만
            return {"claims": [{"claim": "…", "supported": ok, "cited": cited, "reason": "대조"}]}
        return {"score": 5 if ok else 3, "reason": "채점"}

    goldset = EVAL_DIR / "dataset" / "goldset_selftest.jsonl"  # 실골드셋과 무관한 고정 파일럿
    result = run("self-test-project", goldset, k=6, judge_model="fake",
                 client=_FakeClient(), judge=_fake_judge)
    overall = result["metrics"]["overall"]
    assert overall["n"] == 6, overall
    assert overall["hit_rate"] == 0.4, overall       # scored 5문항 중 q-001·q-004 hit (q-006은 엄격 기준 miss)
    assert overall["mrr"] == 0.6, overall            # (1 + 0 + 1 + 0 + 1) / 5
    assert overall["abstain_accuracy"] == 1.0, overall
    assert overall["citation_recall"] == 0.8, overall  # 5개 주장 중 q-005만 인용 없음
    assert result["metrics"]["by_type"]["abstain"]["n"] == 1
    # temporal 분리 집계(§1①) — current는 올바른 시점(T2) 회수, historical은 시점 오류로 miss
    assert result["metrics"]["by_type"]["temporal"]["n"] == 2
    assert result["metrics"]["by_type"]["temporal(current)"]["hit_rate"] == 1.0
    assert result["metrics"]["by_type"]["temporal(historical)"]["hit_rate"] == 0.0
    # multi_hop 엄격 기준 — gold 2개 중 1개만 회수하면 hit=0, 부분 회수는 gold_recall로 보임
    assert result["metrics"]["by_type"]["multi_hop"]["hit_rate"] == 0.0
    assert result["metrics"]["by_type"]["multi_hop"]["gold_recall_avg"] == 0.5
    failure_ids = [failure["id"] for failure in result["failures"]]
    assert failure_ids == ["q-002", "q-005", "q-006"], failure_ids  # 미스·시점미스·연결실패
    print_report(result)
    print("\n✅ self-test 통과 — 하네스 배관 정상")


def main() -> None:
    parser = argparse.ArgumentParser(description="RAG 평가 하네스 (rag-evaluation-plan.md §3)")
    parser.add_argument("--project", help="평가 대상 프로젝트 group_id")
    parser.add_argument("--goldset", default=str(EVAL_DIR / "dataset" / "goldset.jsonl"))
    parser.add_argument("--k", type=int, default=6)
    parser.add_argument("--judge-model", default=os.getenv("EVAL_JUDGE_MODEL") or DEFAULT_JUDGE_MODEL)
    parser.add_argument("--resolve-only", action="store_true",
                        help="골드셋 파일명 해석만 검사 (ask·judge 미실행)")
    parser.add_argument("--skip-judge", action="store_true",
                        help="자동 지표만 계산 (OpenAI 불필요)")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return
    if not args.project:
        parser.error("--project가 필요합니다 (--self-test 제외)")

    if args.resolve_only:
        from backend.integration.gsvx_connector import GsvxClient

        client = GsvxClient()
        items = load_goldset(Path(args.goldset))
        graph = client.graph(args.project)
        titles = [str(n.get("label") or "") for n in graph.get("nodes", []) if n.get("type") == "session"]
        unresolved = resolve_gold_sources(items, titles)
        print(f"세션 에피소드 {len(titles)}개 / 골드셋 {len(items)}문항")
        if unresolved:
            print("미해석 gold_sources:")
            for warning in unresolved:
                print(f"  - {warning}")
        else:
            print("✅ 모든 gold_sources 해석 성공")
        return

    result = run(args.project, Path(args.goldset), args.k, args.judge_model,
                 skip_judge=args.skip_judge)
    print_report(result)
    path = save_results(result)
    print(f"결과 저장: {path}")


if __name__ == "__main__":
    main()

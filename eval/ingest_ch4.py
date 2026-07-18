"""Chapter 4 평가 코퍼스 적재 — rag-evaluation-plan.md §2.5·§5-0 구현.

본 강의 4.1~4.4(T1, 이른 content_date)와 보강 정정공지 4.5(T2, 늦은 content_date)를
지정 프로젝트에 적재한다. content_date가 달라야 Graphiti가 T1→T2 갱신 순서를
인지한다(§0.5 — 생략 시 now()로 덮이므로 반드시 명시).

사용: python eval/ingest_ch4.py --project <group_id> [--source-dir <대본 폴더>]
  기본 대본 폴더: eval/dataset/scripts/ (합성 대본이라 저장소에 포함 — 평가 재현용)

⚠️ 골드셋의 abstain 문항이 "이 코퍼스에 없음"을 전제하므로 평가 전용 빈 프로젝트에
적재할 것 — 다른 강의(예: Week1)와 섞이면 abstain·global 문항이 오염된다.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(REPO_ROOT / ".env")

# (파일 stem = 에피소드 제목 = 골드셋 gold_sources, content_date)
EPISODES = [
    ("4.1_범주형변수", "2026-03-02"),
    ("4.2_분할표", "2026-03-09"),
    ("4.3_이원표추론", "2026-03-16"),
    ("4.4_로지스틱회귀", "2026-03-23"),
    ("4.5_보강_정정공지", "2026-05-11"),  # T2 — 갱신 신호 포함(§2.5)
]


def main() -> None:
    parser = argparse.ArgumentParser(description="Chapter 4 평가 코퍼스 적재 (§2.5·§5-0)")
    parser.add_argument("--project", required=True, help="평가 전용 프로젝트 group_id")
    parser.add_argument("--source-dir", default=str(Path(__file__).resolve().parent / "dataset" / "scripts"),
                        help="4.x 대본 txt 폴더 (기본: eval/dataset/scripts)")
    args = parser.parse_args()

    source_dir = Path(args.source_dir)
    missing = [stem for stem, _ in EPISODES if not (source_dir / f"{stem}.txt").exists()]
    if missing:
        sys.exit(f"대본 파일 없음: {missing} (--source-dir 확인)")

    from backend.integration.gsvx_connector import GsvxClient

    client = GsvxClient()
    for stem, date in EPISODES:
        text = (source_dir / f"{stem}.txt").read_text(encoding="utf-8")
        result = client.ingest_document_text(text, stem, project=args.project, content_date=date)
        print(f"✅ {stem} (content_date={date}) 적재 — chunks={result.get('chunks_ingested')}, "
              f"concepts_new={result.get('concepts_new')}, relations_new={result.get('relations_new')}")


if __name__ == "__main__":
    main()

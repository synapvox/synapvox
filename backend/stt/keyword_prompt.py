import argparse
import json
import sys
from collections import Counter
from pathlib import Path

from kiwipiepy import Kiwi

_kiwi = Kiwi()
_NOUN_TAGS = {"NNG", "NNP"}

# Specificity factor (iii) from TDD §4-2 / 기능정의서 §3-1: score down generic
# meeting-proceeding vocabulary that would otherwise crowd out real domain terms.
# No general-purpose Korean frequency corpus is available here, so this is a small
# curated stoplist standing in for one — a heuristic, not real corpus-based IDF.
_GENERIC_NOUNS = {
    "회의", "오늘", "이번", "위원", "위원회", "발언", "문제", "부분", "정도", "경우",
    "생각", "관련", "다음", "지금", "여기", "저희", "우리", "말씀", "질의", "답변",
    "안건", "논의", "결과", "내용", "사항", "진행", "설명", "확인", "검토",
}
_GENERIC_DISCOUNT = 0.3


def _specificity_weight(term: str) -> float:
    return _GENERIC_DISCOUNT if term in _GENERIC_NOUNS else 1.0


def extract_keywords(text: str, top_n: int = 20) -> list:
    """Frequency-ranked noun extraction via Korean morphological analysis (kiwipiepy — no
    JVM needed), discounted by specificity (factor iii) so generic proceeding-vocabulary
    doesn't crowd out real domain terms. Returns [] for empty/whitespace-only text."""
    if not text or not text.strip():
        return []
    tokens = _kiwi.analyze(text)[0][0]
    nouns = [t.form for t in tokens if t.tag in _NOUN_TAGS and len(t.form) >= 2]
    scored = {term: count * _specificity_weight(term) for term, count in Counter(nouns).items()}
    ranked = sorted(scored.items(), key=lambda kv: kv[1], reverse=True)
    return [term for term, _ in ranked[:top_n]]


def extract_keywords_from_past_meetings(meeting_texts: list, top_n: int = 20) -> list:
    """Aggregate keywords across multiple past meetings from the same project (factor ii:
    past-meeting frequency + recency). `meeting_texts` must be chronologically ordered,
    oldest first — each meeting's contribution is weighted by recency, linearly from
    1/N (oldest) to 1.0 (most recent), then discounted by specificity (factor iii) same
    as extract_keywords. Weighting by recency-adjusted coverage (not raw total frequency)
    means a term recurring across meetings — especially recent ones — outranks one that
    was only frequent in a single, older meeting."""
    if not meeting_texts:
        return []
    n = len(meeting_texts)
    weighted = Counter()
    for i, text in enumerate(meeting_texts):
        recency_weight = (i + 1) / n
        for term in set(extract_keywords(text, top_n=50)):
            weighted[term] += recency_weight * _specificity_weight(term)
    return [term for term, _ in weighted.most_common(top_n)]


def build_prompt(material_text: str = None, past_keywords: list = None, max_chars: int = 400) -> str:
    """Whisper initial_prompt from keywords extracted out of current pre-meeting materials,
    optionally merged with recurring keywords from the same project's past meetings.
    Returns None only when neither source has anything — callers must not silently
    substitute something else in that case."""
    keywords = extract_keywords(material_text) if material_text else []

    if past_keywords:
        for kw in past_keywords:
            if kw not in keywords:
                keywords.append(kw)

    if not keywords:
        return None

    return ", ".join(keywords)[:max_chars]


def build_roster_hint(meta: dict) -> str:
    """Fallback signal for when no pre-meeting materials exist at all: committee name,
    session title, and attendee roster from meta.json. This is NOT keyword RAG — it's
    just already-known metadata, a much weaker signal than real material-based extraction.
    Only use this explicitly, and label results as "roster hint", not "keyword RAG"."""
    parts = [meta["committee"], meta["session"]]
    speakers = meta.get("speakers")
    if speakers:
        parts.append(speakers.split("(")[0].strip())
    return ". ".join(parts) + "."


def resolve_prompt(material_text: str = None, meta: dict = None, past_keywords: list = None) -> str:
    """Prefer keywords from real materials (+ past-project keywords if given); fall back
    to the roster hint only when no materials/past keywords exist AND a meta dict was
    explicitly provided for that fallback."""
    prompt = build_prompt(material_text, past_keywords)
    if prompt is None and meta is not None:
        return build_roster_hint(meta)
    return prompt


def main():
    parser = argparse.ArgumentParser(
        description="Build a Whisper initial_prompt from pre-meeting materials text (+ optional "
        "past-project keywords). Prints nothing (no injection) if there's nothing to inject, "
        "unless --roster-fallback is set."
    )
    parser.add_argument("meta_json")
    parser.add_argument("--material", help="Path to extracted materials text (PPT/PDF)")
    parser.add_argument(
        "--past-meeting",
        action="append",
        default=[],
        help="Path to a past meeting's transcript text (same project). Repeatable. "
        "Pass in chronological order, oldest first — recency weighting assumes this.",
    )
    parser.add_argument(
        "--roster-fallback",
        action="store_true",
        help="If no materials/past keywords, fall back to committee/roster hint (weaker signal, not keyword RAG)",
    )
    args = parser.parse_args()

    material_text = Path(args.material).read_text(encoding="utf-8") if args.material else None

    past_keywords = None
    if args.past_meeting:
        past_texts = [Path(p).read_text(encoding="utf-8") for p in args.past_meeting]
        past_keywords = extract_keywords_from_past_meetings(past_texts)

    meta = json.loads(Path(args.meta_json).read_text(encoding="utf-8")) if args.roster_fallback else None

    prompt = resolve_prompt(material_text, meta, past_keywords)
    if prompt is not None and not material_text and not past_keywords and meta is not None:
        print("[no materials — using roster hint fallback, not keyword RAG]", file=sys.stderr)

    if prompt is not None:
        print(prompt)


if __name__ == "__main__":
    main()

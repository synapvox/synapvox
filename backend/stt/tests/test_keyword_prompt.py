import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3]))  # repo root

from backend.stt.keyword_prompt import (
    build_prompt,
    build_roster_hint,
    extract_keywords,
    extract_keywords_from_past_meetings,
    resolve_prompt,
)


def test_extract_keywords_ranks_by_frequency():
    text = (
        "이번 추가경정예산안은 그냥드림 코너 확대 운영을 포함합니다. "
        "추가경정예산안 심사를 계속합니다. 예산안 심사를 진행합니다."
    )

    keywords = extract_keywords(text, top_n=5)

    assert keywords[0] == "예산안"
    assert "경정" in keywords


def test_extract_keywords_drops_single_char_nouns():
    keywords = extract_keywords("이 안건은 그 예산안과 이 문제를 다룹니다.")

    assert all(len(k) >= 2 for k in keywords)


def test_extract_keywords_empty_text_returns_empty_list():
    assert extract_keywords(None) == []
    assert extract_keywords("") == []
    assert extract_keywords("   ") == []


def test_extract_keywords_downweights_generic_nouns():
    text = "회의 회의 회의 예산안 예산안 예산안"

    keywords = extract_keywords(text, top_n=5)

    # equal raw frequency, but "회의" is a generic stoplist noun — domain term ranks first
    assert keywords.index("예산안") < keywords.index("회의")


def test_extract_keywords_from_past_meetings_weights_recent_meetings_higher():
    older = "특허 특허 특허 특허"
    newer = "라이선스"

    # oldest-first order: "older" happened before "newer"
    keywords = extract_keywords_from_past_meetings([older, newer], top_n=15)

    # despite lower raw frequency, the more recent term should not rank below
    # a term that only appeared in an older meeting at much higher frequency
    assert keywords.index("라이선스") < keywords.index("특허")


def test_extract_keywords_from_past_meetings_ranks_by_meeting_coverage():
    meeting_a = "결제 모듈 오류가 발생했습니다. 결제 모듈 재검토가 필요합니다."
    meeting_b = "일정 조정 안건입니다. 결제 모듈 일정도 조정합니다."
    meeting_c = "결제 모듈 완료 보고입니다."

    keywords = extract_keywords_from_past_meetings([meeting_a, meeting_b, meeting_c], top_n=15)

    # "결제"/"모듈" appear in all 3 meetings — should outrank "일정"/"조정" (only meeting_b)
    assert keywords.index("모듈") < keywords.index("일정")


def test_build_prompt_returns_none_without_materials_or_past_keywords():
    assert build_prompt(None) is None
    assert build_prompt("") is None
    assert build_prompt("   ") is None


def test_build_prompt_extracts_keywords_from_material():
    prompt = build_prompt("REST API 명세서를 검토하고 결제 모듈 일정을 조정합니다.")

    assert "결제" in prompt
    assert "모듈" in prompt


def test_build_prompt_merges_past_keywords_with_material_keywords():
    prompt = build_prompt("결제 모듈 일정 조정 안건입니다.", past_keywords=["레거시시스템"])

    assert "레거시시스템" in prompt
    assert "모듈" in prompt


def test_build_prompt_uses_past_keywords_alone_when_no_material():
    prompt = build_prompt(None, past_keywords=["결제모듈", "레거시시스템"])

    assert prompt == "결제모듈, 레거시시스템"


def test_build_prompt_truncates_to_max_chars():
    prompt = build_prompt(None, past_keywords=["가" * 1000], max_chars=50)

    assert len(prompt) == 50


def test_build_roster_hint_uses_committee_and_session():
    meta = {
        "committee": "보건복지위원회",
        "session": "제433회 국회(임시회) 제3차 보건복지위원회(전체회의)",
        "speakers": "위원장 소병훈, 한지아 위원 (다수 화자, 발언 순서는 transcript.txt 참고)",
    }

    hint = build_roster_hint(meta)

    assert "보건복지위원회" in hint
    assert "제433회 국회" in hint
    assert "소병훈" in hint
    assert "transcript.txt" not in hint


def test_build_roster_hint_without_speakers():
    meta = {"committee": "교육위원회", "session": "제100회 교육위원회"}

    assert build_roster_hint(meta) == "교육위원회. 제100회 교육위원회."


def test_resolve_prompt_prefers_material_keywords_over_roster():
    meta = {"committee": "보건복지위원회", "session": "제433회"}

    prompt = resolve_prompt("결제 모듈 일정 조정 안건입니다.", meta)

    assert "모듈" in prompt
    assert "보건복지위원회" not in prompt


def test_resolve_prompt_uses_past_keywords_when_no_current_material():
    meta = {"committee": "보건복지위원회", "session": "제433회"}

    prompt = resolve_prompt(None, meta, past_keywords=["결제모듈"])

    assert prompt == "결제모듈"


def test_resolve_prompt_falls_back_to_roster_when_nothing_else_available():
    meta = {"committee": "보건복지위원회", "session": "제433회"}

    prompt = resolve_prompt(None, meta)

    assert prompt == "보건복지위원회. 제433회."


def test_resolve_prompt_returns_none_without_anything():
    assert resolve_prompt(None, None) is None

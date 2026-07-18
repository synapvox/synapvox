import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3]))  # repo root

import pytest

from backend.stt.refine_transcript import (
    _chunk_segments,
    _chunk_text,
    _parse_llm_output,
    build_refinement_prompt,
    refine_transcript,
    retrieve_relevant_context,
)

SEGMENTS = [
    {"id": 0, "speaker": "A", "start": 0.0, "end": 2.0, "text": "추가경영예산안을 논의합니다"},
    {"id": 1, "speaker": "B", "start": 2.0, "end": 4.0, "text": "네 알겠습니다"},
]


def test_build_refinement_prompt_includes_transcript_and_material():
    prompt = build_refinement_prompt(SEGMENTS, material_text="이번 회의 안건: 추가경정예산안")

    assert "추가경영예산안" in prompt
    assert "추가경정예산안" in prompt
    assert '"id": 0' in prompt


def test_build_refinement_prompt_includes_past_meetings():
    prompt = build_refinement_prompt(SEGMENTS, past_meeting_texts=["1차 회의: 결제 모듈 논의", "2차 회의: 일정 조정"])

    assert "결제 모듈" in prompt
    assert "일정 조정" in prompt


def test_build_refinement_prompt_notes_absence_of_materials():
    prompt = build_refinement_prompt(SEGMENTS)

    assert "사전 자료 없음" in prompt


def test_parse_llm_output_maps_id_to_corrected_text():
    raw = json.dumps({"segments": [{"id": 0, "text": "추가경정예산안을 논의합니다"}, {"id": 1, "text": "네 알겠습니다"}]})

    corrections = _parse_llm_output(raw, expected_ids={0, 1})

    assert corrections[0] == "추가경정예산안을 논의합니다"
    assert corrections[1] == "네 알겠습니다"


def test_parse_llm_output_accepts_partial_and_ignores_unknown_ids():
    # id 1은 누락, id 9는 expected에 없음 → 받은 0만 취하고 나머지는 무시(부분 수용)
    raw = json.dumps({"segments": [{"id": 0, "text": "x"}, {"id": 9, "text": "무관"}]})

    corrections = _parse_llm_output(raw, expected_ids={0, 1})

    assert corrections == {0: "x"}


def test_parse_llm_output_skips_blank_text():
    raw = json.dumps({"segments": [{"id": 0, "text": "   "}, {"id": 1, "text": "정상"}]})

    assert _parse_llm_output(raw, expected_ids={0, 1}) == {1: "정상"}


def test_parse_llm_output_rejects_missing_segments_key():
    with pytest.raises(ValueError, match="segments"):
        _parse_llm_output(json.dumps({"foo": "bar"}), expected_ids={0})


def test_parse_llm_output_rejects_invalid_json():
    with pytest.raises(json.JSONDecodeError):
        _parse_llm_output("not json", expected_ids={0})


def test_chunk_text_splits_by_paragraph():
    text = "첫 번째 문단입니다.\n\n두 번째 문단입니다."

    assert _chunk_text(text) == ["첫 번째 문단입니다.", "두 번째 문단입니다."]


def test_chunk_text_splits_long_paragraph_into_fixed_windows():
    text = "가" * 700

    chunks = _chunk_text(text, chunk_size=300)

    assert len(chunks) == 3
    assert chunks[0] == "가" * 300


def test_chunk_text_empty_returns_empty_list():
    assert _chunk_text(None) == []
    assert _chunk_text("") == []
    assert _chunk_text("   ") == []


def test_chunk_segments_keeps_ids_and_caps_batch_size():
    segments = [
        {"id": index, "speaker": "A", "text": f"segment {index}"}
        for index in range(125)
    ]

    batches = _chunk_segments(segments, max_segments=60, max_chars=100_000)

    assert [len(batch) for batch in batches] == [60, 60, 5]
    assert [segment["id"] for batch in batches for segment in batch] == list(range(125))


class _FakeCompletionResponse:
    def __init__(self, content):
        self.choices = [
            type("Choice", (), {"message": type("Message", (), {"content": content})()})()
        ]


class _FakeRefinementClient:
    def __init__(self):
        self.batch_ids = []
        self.chat = type("Chat", (), {})()
        self.chat.completions = self

    def create(self, **request):
        prompt = request["messages"][0]["content"]
        transcript = prompt.split("# 전사문 세그먼트 (JSON)\n", 1)[1].split(
            "\n\n# 출력 형식", 1
        )[0]
        segments = json.loads(transcript)
        ids = [segment["id"] for segment in segments]
        self.batch_ids.append(ids)
        return _FakeCompletionResponse(json.dumps({
            "segments": [
                {"id": segment["id"], "text": f"{segment['text']} 교정"}
                for segment in segments
            ],
        }, ensure_ascii=False))


def test_refine_transcript_splits_large_transcript_and_merges_in_order():
    segments = [
        {
            "id": index,
            "speaker": "A",
            "start": float(index),
            "end": float(index + 1),
            "text": f"원문 {index}",
        }
        for index in range(125)
    ]
    client = _FakeRefinementClient()

    result = refine_transcript(
        {"source": "lecture.wav", "segments": segments},
        material_text="강의 자료",
        client=client,
    )

    # 배치는 병렬 실행되어 호출 순서가 비결정적이므로 크기 구성만 검증(순서 무관).
    # 최종 결과는 원본 세그먼트 순서로 재조립되므로 아래 순서 검증은 그대로 성립한다.
    assert sorted((len(ids) for ids in client.batch_ids), reverse=True) == [60, 60, 5]
    assert [segment["id"] for segment in result["segments"]] == list(range(125))
    assert result["segments"][124]["text"] == "원문 124 교정"


class _DropIdClient:
    """호출별로 지정한 id를 빼고 반환하는 가짜 LLM — 부분 수용/누락 재요청 검증용."""

    def __init__(self, drop_per_call):
        self.drop_per_call = drop_per_call  # [set, set, ...] 각 호출에서 뺄 id
        self.chat = type("Chat", (), {})()
        self.chat.completions = self
        self.batch_ids = []

    def create(self, **request):
        prompt = request["messages"][0]["content"]
        transcript = prompt.split("# 전사문 세그먼트 (JSON)\n", 1)[1].split(
            "\n\n# 출력 형식", 1
        )[0]
        segments = json.loads(transcript)
        self.batch_ids.append([segment["id"] for segment in segments])
        drop = self.drop_per_call[min(len(self.batch_ids) - 1, len(self.drop_per_call) - 1)]
        return _FakeCompletionResponse(json.dumps({
            "segments": [
                {"id": s["id"], "text": f"{s['text']} 교정"}
                for s in segments if s["id"] not in drop
            ],
        }, ensure_ascii=False))


def test_refine_transcript_keeps_original_text_for_unrecovered_ids():
    segments = [
        {"id": i, "speaker": "A", "start": float(i), "end": float(i) + 1, "text": f"원문 {i}"}
        for i in range(3)
    ]
    client = _DropIdClient(drop_per_call=[{1}])  # id 1은 끝까지 안 돌려줌

    result = refine_transcript(
        {"source": "x.wav", "segments": segments}, material_text="자료", client=client
    )

    texts = {s["id"]: s["text"] for s in result["segments"]}
    assert texts[0] == "원문 0 교정"
    assert texts[2] == "원문 2 교정"
    assert texts[1] == "원문 1"  # 못 받은 id는 원문 유지 (배치 전체 재시도 안 함)
    assert client.batch_ids[0] == [0, 1, 2]
    assert client.batch_ids[-1] == [1]  # 누락분만 재요청


def test_refine_transcript_accumulates_partial_across_retries():
    segments = [
        {"id": i, "speaker": "A", "start": float(i), "end": float(i) + 1, "text": f"원문 {i}"}
        for i in range(2)
    ]
    # 첫 호출은 id 1 누락, 두 번째(누락분 재요청)에서 복구
    client = _DropIdClient(drop_per_call=[{1}, set()])

    result = refine_transcript(
        {"source": "x.wav", "segments": segments}, material_text="자료", client=client
    )

    texts = {s["id"]: s["text"] for s in result["segments"]}
    assert texts[0] == "원문 0 교정"
    assert texts[1] == "원문 1 교정"  # 재요청에서 복구
    assert client.batch_ids == [[0, 1], [1]]  # 초기 전체 + 누락분만


class _FakeVectorStore:
    """retrieve_relevant_context()가 저장 대상으로 넘긴 청크 중, "결제" 청크만 관련 있다고
    가정하고 되돌려주는 스텁 — 실제 pgvector 쿼리 랭킹 로직은 backend.graphrag 쪽 책임."""

    def __init__(self):
        self.stored = {}

    def add_chunks(self, project_id, meeting_id, chunks):
        self.stored.setdefault(project_id, []).extend(chunks)

    def query(self, project_id, text, k=8, source_type=None):
        hits = [c for c in self.stored.get(project_id, []) if "결제" in c["text"]]
        return [{"chunk_id": c["chunk_id"], "text": c["text"], "score": 1.0,
                 "meeting_id": None, "source_type": c["source_type"]} for c in hits[:k]]


def test_retrieve_relevant_context_keeps_only_top_k_similar_chunks():
    material_text = "결제 모듈 관련 내용입니다.\n\n날씨가 좋은 하루였습니다."
    query_text = "결제 모듈 오류를 논의합니다"

    material, past = retrieve_relevant_context(
        query_text, "P01", "M01", material_text=material_text, top_k=1, vector_store=_FakeVectorStore(),
    )

    assert material == "결제 모듈 관련 내용입니다."
    assert past is None


def test_retrieve_relevant_context_returns_input_unchanged_when_nothing_to_chunk():
    material, past = retrieve_relevant_context(
        "query", "P01", "M01", material_text=None, past_meeting_texts=None,
    )

    assert material is None
    assert past is None

import argparse
import contextvars
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from openai import OpenAI
from langsmith import traceable

from backend.graphrag import VectorStore
from backend.observability import wrap_openai_client

_MAX_RETRIES = 2
_MAX_SEGMENTS_PER_REQUEST = 60
_MAX_TRANSCRIPT_CHARS_PER_REQUEST = 12_000
_DEFAULT_REFINEMENT_CONCURRENCY = 6
# gpt-5 계열 기본 추론량. reasoning_effort="minimal"은 "모든 세그먼트 id를 정확히
# 한 번씩 반환"을 자주 못 지켜(관측상 배치당 평균 2회 재시도) 호출을 낭비했다.
# "low"로 올려 id 누락을 줄인다. STT_REFINEMENT_REASONING_EFFORT로 조정(빈 값이면 미지정).
_DEFAULT_REFINEMENT_REASONING_EFFORT = "low"
DEFAULT_REFINEMENT_MODEL = "gpt-5-mini"


def refinement_model() -> str:
    return os.getenv("STT_REFINEMENT_MODEL") or DEFAULT_REFINEMENT_MODEL


def refinement_concurrency() -> int:
    """동시에 보낼 배치 수 상한. STT_REFINEMENT_CONCURRENCY로 조정(기본 6)."""
    try:
        return max(1, int(os.getenv("STT_REFINEMENT_CONCURRENCY") or _DEFAULT_REFINEMENT_CONCURRENCY))
    except ValueError:
        return _DEFAULT_REFINEMENT_CONCURRENCY


def refinement_reasoning_effort() -> str:
    """gpt-5 계열 reasoning_effort. 빈 문자열이면 파라미터 자체를 생략."""
    return os.getenv("STT_REFINEMENT_REASONING_EFFORT", _DEFAULT_REFINEMENT_REASONING_EFFORT).strip()


def _chunk_text(text: str, chunk_size: int = 300) -> list:
    """Paragraph-based chunking (split on blank lines), falling back to a fixed-size
    char window for paragraphs longer than chunk_size. No sentence-boundary awareness —
    good enough for retrieval scoring, not meant for display."""
    if not text or not text.strip():
        return []
    chunks = []
    for paragraph in text.split("\n\n"):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        if len(paragraph) <= chunk_size:
            chunks.append(paragraph)
        else:
            for i in range(0, len(paragraph), chunk_size):
                chunks.append(paragraph[i:i + chunk_size])
    return chunks


@traceable(name="STT material retrieval", run_type="retriever")
def retrieve_relevant_context(
    query_text: str,
    project_id: str,
    meeting_id: str,
    material_text: str = None,
    past_meeting_texts: list = None,
    top_k: int = 5,
    vector_store=None,
):
    """Stage-2 리트리벌 — `backend.graphrag.VectorStore`(pgvector, PR #10 병합 2026-07-15)로
    구현. material_text/past_meeting_texts를 청킹해 저장(add_chunks) 후 query_text로 top_k
    조회(query)해 관련 청크만 material_text/past_meeting_texts 형태로 되돌려준다. chunk_id를
    project_id/meeting_id로 스코프해 다른 회의 자료와 안 섞이게 함. project_id로 스코프된
    프로젝트 전체(다른 회의 포함)에서 검색되므로, 과거 회의록도 굳이 별도 인자로 안 넘겨도
    이미 저장돼 있으면 자동으로 후보에 들어옴 — 다만 지금은 매 호출마다 넘어온 텍스트만 저장."""
    candidates = [{"chunk_id": f"{project_id}:{meeting_id}:material:{i}", "text": c, "source_type": "material"}
                  for i, c in enumerate(_chunk_text(material_text))]
    for pi, text in enumerate(past_meeting_texts or []):
        candidates += [{"chunk_id": f"{project_id}:{meeting_id}:past_meeting_{pi}:{i}", "text": c,
                        "source_type": f"past_meeting_{pi}"}
                       for i, c in enumerate(_chunk_text(text))]

    if not candidates:
        return material_text, past_meeting_texts

    vs = vector_store or VectorStore()
    vs.add_chunks(project_id, meeting_id, candidates)
    hits = vs.query(project_id, query_text, k=top_k)

    retrieved_material = "\n\n".join(h["text"] for h in hits if h["source_type"] == "material") or None
    retrieved_past = [h["text"] for h in hits if h["source_type"].startswith("past_meeting")] or None

    return retrieved_material, retrieved_past


def build_refinement_prompt(segments: list, material_text: str = None, past_meeting_texts: list = None) -> str:
    """Stage-2 STT refinement prompt: RAG over (1차 전사 + 회의자료 + 과거 회의록).
    Assumes material_text/past_meeting_texts have already been narrowed to the relevant
    chunks (see retrieve_relevant_context()) — this function itself just dumps whatever
    it's given, it doesn't retrieve."""
    transcript_json = json.dumps(
        [{"id": s["id"], "speaker": s["speaker"], "text": s["text"]} for s in segments],
        ensure_ascii=False,
    )

    context_parts = []
    if material_text:
        context_parts.append(f"회의 자료:\n{material_text}")
    if past_meeting_texts:
        context_parts.append("과거 회의록:\n" + "\n---\n".join(past_meeting_texts))
    context_block = "\n\n".join(context_parts) if context_parts else "(사전 자료 없음)"

    return f"""다음은 회의 전사문 세그먼트 목록과 참고 자료입니다. 전문용어·고유명사 오인식을 자료를 참고해 교정하고,
말이 안 되는 부분은 맥락에 맞게 자연스럽게 다듬어 주세요. 화자나 세그먼트 순서·개수는 바꾸지 마세요.

# 참고 자료
{context_block}

# 전사문 세그먼트 (JSON)
{transcript_json}

# 출력 형식
각 세그먼트의 id와 교정된 text만 담은 JSON으로 출력하세요. 다른 설명은 넣지 마세요.
{{"segments": [{{"id": 0, "text": "교정된 텍스트"}}, ...]}}
"""


def _parse_llm_output(raw_content: str, expected_ids: set) -> dict:
    """LLM 출력에서 사용 가능한 {id: 교정 텍스트}만 뽑는다(부분 수용).

    JSON이 깨졌거나 'segments' 배열 자체가 없으면 재시도 대상(예외). 하지만 id가 일부
    빠지거나 초과되는 건 오류로 보지 않는다 — expected_ids에 속하고 비어있지 않은 text만
    취한다. 누락된 id는 호출부에서 원문을 유지한다. 엄격 검증으로 배치 전체를 재시도하며
    호출을 낭비하던 기존 동작을 대체한다.
    """
    data = json.loads(raw_content)
    segments = data.get("segments") if isinstance(data, dict) else None
    if not isinstance(segments, list):
        raise ValueError("missing or invalid 'segments' array in LLM output")

    corrections: dict = {}
    for item in segments:
        if not isinstance(item, dict):
            continue
        seg_id = item.get("id")
        text = item.get("text")
        if seg_id in expected_ids and isinstance(text, str) and text.strip():
            corrections[seg_id] = text
    return corrections


def _chunk_segments(
    segments: list,
    max_segments: int = _MAX_SEGMENTS_PER_REQUEST,
    max_chars: int = _MAX_TRANSCRIPT_CHARS_PER_REQUEST,
) -> list[list]:
    """Split refinement requests without changing segment boundaries or IDs."""
    batches: list[list] = []
    current: list = []
    current_chars = 0
    for segment in segments:
        segment_chars = len(str(segment.get("text") or "")) + 80
        if current and (
            len(current) >= max_segments
            or current_chars + segment_chars > max_chars
        ):
            batches.append(current)
            current = []
            current_chars = 0
        current.append(segment)
        current_chars += segment_chars
    if current:
        batches.append(current)
    return batches


def _refine_segment_batch(
    client,
    model: str,
    segments: list,
    material_text: str | None,
    past_meeting_texts: list | None,
) -> dict:
    """배치를 교정해 {id: text}를 반환. 부분 수용 + 누락분만 재요청.

    받은 교정은 누적하고, 아직 못 받은 id만 다음 시도에서 다시 요청한다(배치 전체를
    통째로 재시도하지 않음). 재시도를 소진해도 남은 id는 반환에서 빠지며, 호출부가 원문을
    유지한다. JSON/구조가 계속 깨져 아무것도 못 받은 경우에만 예외를 던진다.
    """
    by_id = {segment["id"]: segment for segment in segments}
    expected_ids = set(by_id)
    corrections: dict = {}
    last_error = None
    effort = refinement_reasoning_effort()

    for attempt in range(_MAX_RETRIES + 1):
        pending = [by_id[i] for i in by_id if i not in corrections]
        if not pending:
            break
        prompt = build_refinement_prompt(pending, material_text, past_meeting_texts)
        retry_note = (
            ""
            if attempt == 0
            else "\n\n일부 세그먼트가 누락됐습니다. 위 모든 id를 정확히 한 번씩 포함하세요."
        )
        request = {
            "model": model,
            "messages": [{"role": "user", "content": prompt + retry_note}],
            "response_format": {"type": "json_object"},
        }
        if model.startswith("gpt-5") and effort:
            request["reasoning_effort"] = effort
        response = client.chat.completions.create(**request)
        content = response.choices[0].message.content
        try:
            corrections.update(_parse_llm_output(content, expected_ids))
        except (json.JSONDecodeError, ValueError) as exc:
            last_error = str(exc)

    if not corrections and last_error is not None:
        raise RuntimeError(
            f"LLM refinement batch failed after {_MAX_RETRIES + 1} attempts: {last_error}"
        )
    return corrections


@traceable(name="Stage 2 transcript refinement", run_type="chain")
def refine_transcript(
    data: dict,
    material_text: str = None,
    past_meeting_texts: list = None,
    model: str = None,
    client=None,
) -> dict:
    """Apply stage-2 refinement to a 중간 포맷 JSON object (source/mode/segments shape).
    Returns the same shape with segments[].text replaced by the corrected version."""
    client = client or wrap_openai_client(OpenAI(api_key=os.environ["OPENAI_API_KEY"]))
    model = model or refinement_model()
    batches = _chunk_segments(data["segments"])
    corrections: dict = {}

    if len(batches) <= 1:
        for batch in batches:
            corrections.update(
                _refine_segment_batch(client, model, batch, material_text, past_meeting_texts)
            )
    else:
        # 배치는 서로 독립(각자 자기 세그먼트 id만 교정)이라 병렬로 보낸다. 순차 합산이던
        # 벽시계 시간이 배치 하나 수준으로 줄어든다. LangSmith 추적 트리가 스레드에서도
        # 부모 run 아래에 붙도록 배치마다 현재 컨텍스트 사본에서 실행한다. 배치가 실패하면
        # (재시도 소진 후 RuntimeError) executor.map 순회 중 그대로 전파된다.
        def _run(batch: list) -> dict:
            return contextvars.copy_context().run(
                _refine_segment_batch, client, model, batch, material_text, past_meeting_texts
            )

        max_workers = min(len(batches), refinement_concurrency())
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            for result in executor.map(_run, batches):
                corrections.update(result)

    # 교정을 못 받은 세그먼트는 원문(1차 전사)을 그대로 유지한다.
    refined_segments = [
        {**seg, "text": corrections.get(seg["id"], seg["text"])} for seg in data["segments"]
    ]
    return {**data, "segments": refined_segments}


def main():
    parser = argparse.ArgumentParser(
        description="Stage-2 STT refinement: RAG-correct a 중간 포맷 JSON transcript using materials + past meetings"
    )
    parser.add_argument("intermediate_json", help="Output of backend.stt.stt_normalizer (stage-1 raw transcript)")
    parser.add_argument("--material", help="Path to extracted pre-meeting materials text")
    parser.add_argument(
        "--past-meeting",
        action="append",
        default=[],
        help="Path to a past meeting's transcript text (same project). Repeatable.",
    )
    parser.add_argument("--model", default=refinement_model())
    parser.add_argument("--top-k", type=int, default=5, help="Number of retrieved chunks to keep (default: 5)")
    parser.add_argument(
        "--no-retrieval",
        action="store_true",
        help="Skip embedding-based retrieval, dump all material/past-meeting text directly (old behavior)",
    )
    parser.add_argument("-o", "--output", help="Write JSON to this path instead of stdout")
    args = parser.parse_args()

    data = json.loads(Path(args.intermediate_json).read_text(encoding="utf-8"))
    material_text = Path(args.material).read_text(encoding="utf-8") if args.material else None
    past_meeting_texts = [Path(p).read_text(encoding="utf-8") for p in args.past_meeting] or None

    if not args.no_retrieval and (material_text or past_meeting_texts):
        query_text = " ".join(s["text"] for s in data["segments"])
        material_text, past_meeting_texts = retrieve_relevant_context(
            query_text, data["project_id"], data["meeting_id"], material_text, past_meeting_texts, args.top_k
        )

    result = refine_transcript(data, material_text, past_meeting_texts, args.model)
    output = json.dumps(result, ensure_ascii=False, indent=2)

    if args.output:
        Path(args.output).write_text(output, encoding="utf-8")
    else:
        print(output)


if __name__ == "__main__":
    main()

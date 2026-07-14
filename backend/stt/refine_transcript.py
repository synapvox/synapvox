import argparse
import json
import os
from pathlib import Path

from openai import OpenAI

_MAX_RETRIES = 2


def build_refinement_prompt(segments: list, material_text: str = None, past_meeting_texts: list = None) -> str:
    """Stage-2 STT refinement prompt: RAG over (1차 전사 + 회의자료 + 과거 회의록).
    For now this dumps ALL available context directly — no pgvector retrieval yet.
    Swap in a smarter context-selection step later without changing refine_transcript()'s
    signature, just what gets passed in as material_text/past_meeting_texts."""
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
    data = json.loads(raw_content)
    if "segments" not in data:
        raise ValueError("missing 'segments' key in LLM output")

    got_ids = {s["id"] for s in data["segments"]}
    if got_ids != expected_ids:
        raise ValueError(f"segment id mismatch: expected {expected_ids}, got {got_ids}")

    return {s["id"]: s["text"] for s in data["segments"]}


def refine_transcript(
    data: dict,
    material_text: str = None,
    past_meeting_texts: list = None,
    model: str = "gpt-4o",
) -> dict:
    """Apply stage-2 refinement to a 중간 포맷 JSON object (source/mode/segments shape).
    Returns the same shape with segments[].text replaced by the corrected version."""
    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    prompt = build_refinement_prompt(data["segments"], material_text, past_meeting_texts)
    expected_ids = {s["id"] for s in data["segments"]}

    messages = [{"role": "user", "content": prompt}]
    corrections = None
    last_error = None

    for _ in range(_MAX_RETRIES + 1):
        response = client.chat.completions.create(
            model=model,
            messages=messages,
            response_format={"type": "json_object"},
        )
        content = response.choices[0].message.content
        try:
            corrections = _parse_llm_output(content, expected_ids)
            break
        except (json.JSONDecodeError, ValueError) as e:
            last_error = str(e)
            messages.append({"role": "assistant", "content": content})
            messages.append({"role": "user", "content": f"오류: {last_error}. 형식을 정확히 지켜 다시 출력하세요."})

    if corrections is None:
        raise RuntimeError(f"LLM refinement failed after {_MAX_RETRIES + 1} attempts: {last_error}")

    refined_segments = [{**seg, "text": corrections[seg["id"]]} for seg in data["segments"]]
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
    parser.add_argument("--model", default="gpt-4o")
    parser.add_argument("-o", "--output", help="Write JSON to this path instead of stdout")
    args = parser.parse_args()

    data = json.loads(Path(args.intermediate_json).read_text(encoding="utf-8"))
    material_text = Path(args.material).read_text(encoding="utf-8") if args.material else None
    past_meeting_texts = [Path(p).read_text(encoding="utf-8") for p in args.past_meeting]

    result = refine_transcript(data, material_text, past_meeting_texts or None, args.model)
    output = json.dumps(result, ensure_ascii=False, indent=2)

    if args.output:
        Path(args.output).write_text(output, encoding="utf-8")
    else:
        print(output)


if __name__ == "__main__":
    main()

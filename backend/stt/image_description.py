import base64
import os

from openai import OpenAI

from backend.observability import wrap_openai_client

_DEFAULT_PROMPT = (
    "다음은 회의자료(PPT/PDF)에 포함된 이미지입니다. 차트, 표, 스크린샷, 다이어그램 등 이미지에 담긴 내용을 "
    "회의 맥락에서 이해할 수 있도록 한국어로 간결하게 설명하세요. 이미지 안에 텍스트가 보이면 그대로 옮겨 적으세요."
)


def _build_vision_messages(image_bytes: bytes, mime_type: str, prompt: str) -> list:
    b64 = base64.b64encode(image_bytes).decode("ascii")
    return [{
        "role": "user",
        "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{b64}"}},
        ],
    }]


def describe_image(
    image_bytes: bytes,
    mime_type: str = "image/png",
    prompt: str = _DEFAULT_PROMPT,
    model: str = "gpt-4o",
    client=None,
) -> str:
    """Vision-LLM stand-in for OCR — describes an embedded material image (chart, screenshot,
    diagram) in Korean text, so PPTX/PDF extractors don't silently drop image-only content.
    Not OCR: for images that are mostly text, this transcribes it via the prompt; for charts/
    diagrams it produces a description instead of exact pixel-perfect text extraction."""
    client = client or wrap_openai_client(OpenAI(api_key=os.environ["OPENAI_API_KEY"]))
    messages = _build_vision_messages(image_bytes, mime_type, prompt)
    response = client.chat.completions.create(model=model, messages=messages)
    return response.choices[0].message.content.strip()

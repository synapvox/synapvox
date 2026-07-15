"""health — 관리자 대시보드 '시스템' 탭용 STT 의존성 헬스체크.

비용·속도를 고려해 기본은 "설정 여부"(환경변수 presence) 확인만 한다 — 관리자가 페이지를
열거나 새로고침할 때마다 유료 API를 호출하지 않기 위한 의도적 선택. 실제 연결(라이브 핑)
테스트가 필요해지면 별도 함수로 추가할 것, 이 함수 자체를 무겁게 만들지 말 것."""

import os


def _check_env(name: str, *required_vars: str) -> list:
    missing = [v for v in required_vars if not os.environ.get(v)]
    if missing:
        return [name, f"환경변수 미설정: {', '.join(missing)}", "미설정"]
    return [name, "환경변수 설정됨", "정상"]


def check_stt_health() -> list:
    """admin 대시보드 '시스템' 탭 표 형태: [[name, detail, status], ...]"""
    return [
        _check_env("CLOVA Speech", "CLOVA_SPEECH_INVOKE_URL", "CLOVA_SPEECH_SECRET"),
        _check_env("OpenAI (2차 정제·임베딩·이미지 설명)", "OPENAI_API_KEY"),
        _check_env("Soniox (실험 경로)", "SONIOX_API_KEY"),
    ]

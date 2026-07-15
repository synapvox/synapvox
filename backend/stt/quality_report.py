"""quality_report — 관리자 대시보드 '품질' 탭용 실측 WER 벤치마크 요약.

라이브로 재계산하지 않는다 — 실제 회의 데이터(2026-04-02 보건복지위원회 1부/2부)로 이미
검증된 결과를 정적으로 반환한다. 새 벤치마크가 나오면 _BENCHMARKS만 갱신하면 됨. 원본 출처는
synapvox_Local/progress.md 결정 로그."""

_PASS_THRESHOLD = 0.45  # WER 45% 미만이면 "통과" — 팀 확정 기준 아님, 잠정치

_BENCHMARKS = [
    {"name": "Soniox — 1부(1h46m)", "wer": 0.3208, "note": "3파전 중 최저 WER, 실험 단계(팀 결정 대기)"},
    {"name": "CLOVA Speech — 1부(1h46m)", "wer": 0.3567, "note": "ADR-005 정합 경로, 운영 후보"},
    {"name": "Whisper 베이스라인 — 1부(1h46m)", "wer": 0.3936, "note": "로컬 검증 전용, 운영 미사용"},
    {"name": "CLOVA Speech — 2부(15분)", "wer": 0.4066, "note": "최초 실측(2026-07-13), ADR-005 채택 근거"},
    {"name": "Soniox — 2부(15분)", "wer": 0.3428, "note": "실험 단계(팀 결정 대기)"},
    {"name": "Whisper 베이스라인 — 2부(15분)", "wer": 0.5469, "note": "반복 루프 환각 버그 있음"},
]


def _format_row(entry: dict) -> list:
    wer_pct = entry["wer"] * 100
    status = "통과" if entry["wer"] < _PASS_THRESHOLD else "주의"
    return [entry["name"], f"WER {wer_pct:.2f}% — {entry['note']}", status]


def get_quality_rows() -> list:
    """admin 대시보드 '품질' 탭 표 형태: [[name, detail, status], ...]"""
    return [_format_row(e) for e in _BENCHMARKS]

"""quality_report — 관리자 대시보드 '품질' 탭용 실측 STT 평가 요약.

라이브로 재계산하지 않는다 — 실제 회의 데이터(2026-04-02 보건복지위원회 1부/2부)로 이미
검증된 결과를 정적으로, 카테고리별로 정리해 반환한다. 새 평가가 나오면 아래 두 리스트
(_ENGINE_GROUPS/_IMPROVEMENT_EXPERIMENTS)만 갱신하면 됨. 원본 출처는
synapvox_Local/progress.md 결정 로그(2026-07-13~15 STT 관련 항목 전체)."""

_PASS_THRESHOLD = 0.45  # WER 45% 미만이면 "통과" — 팀 확정 기준 아님, 잠정치

# 엔진 자체 비교 — 같은 오디오에 대해 STT 엔진만 바꿔서 측정한 WER
_ENGINE_GROUPS = [
    {
        "category": "엔진 비교 — 2부(15분, 화자 7명)",
        "entries": [
            {"name": "Whisper 베이스라인", "wer": 0.5469,
             "note": "반복 루프 환각 버그, \"추가경정예산안\"→\"추가경영예산안\" 오인식"},
            {"name": "Whisper + roster-hint 키워드", "wer": 0.5701,
             "note": "메타데이터만으론 오히려 악화 — \"메타데이터 ≠ 키워드 RAG\"의 근거가 됨"},
            {"name": "CLOVA Speech", "wer": 0.4066,
             "note": "ADR-005 채택 근거(최초 실측), 오인식 없음, 화자 7명 정확 검출"},
            {"name": "Soniox", "wer": 0.3428,
             "note": "반복 루프 없음, 화자 6명 검출(정답 7명보다 1명 적음)"},
        ],
    },
    {
        "category": "엔진 비교 — 1부(1h46m, 더 어려운 긴 오디오로 재검증)",
        "entries": [
            {"name": "Soniox", "wer": 0.3208,
             "note": "3파전 중 최저 WER, 화자 8명 검출, 비용 $0.178(비동기 $0.10/시간), 5분10초 소요"},
            {"name": "CLOVA Speech", "wer": 0.3567,
             "note": "화자 10명 검출, 비용 약 2,996원(Basic 기준), 1분23초 소요(동기 호출)"},
            {"name": "Whisper 베이스라인", "wer": 0.3936,
             "note": "로컬 실행이라 API 비용 없음(대신 ~2시간7분 CPU), 반복 루프 환각 재확인됨"},
        ],
    },
]

# 개선 기법 검증 — "before WER → after WER"로 측정한 실험. 엔진 선택 문제가 아니라
# 같은 엔진에 특정 기법을 추가했을 때 실제로 도움이 되는지를 확인한 것들.
_IMPROVEMENT_EXPERIMENTS = [
    {"name": "CLOVA + 2차 정제(refine_transcript, 사전자료 없이)", "before": 0.4066, "after": 0.3901,
     "result": "개선 확인", "note": "문맥 다듬기만으로 소폭 개선 — 자료 기반 용어 교정 효과는 별도 검증 필요"},
    {"name": "CLOVA + boostings(오인식 단어 세트1: 추가경정예산안 등)", "before": 0.4066, "after": 0.4149,
     "result": "효과 없음", "note": "타겟 단어를 CLOVA가 boosting 없이도 이미 맞히고 있어 검증 케이스로 부적합했음"},
    {"name": "CLOVA + boostings(오인식 단어 세트2: 한지아/스토리지, 재확인)", "before": 0.4066, "after": 0.4149,
     "result": "효과 없음", "note": "실제 오인식 단어로 재검증 — 타겟 단어 등장 횟수 전/후 동일, boosting 무효과 재확인"},
    {"name": "Soniox + context.terms(오인식 단어: 식약처/세출예산 등)", "before": 0.3428, "after": 0.3338,
     "result": "개선 확인", "note": "\"식약처\" 오답(\"시약처\") 4회→0회 등 타겟 단어 오인식 대부분 해소"},
    {"name": "Soniox + pyannote 화자분리 결합", "before": 0.3428, "after": 0.3428,
     "result": "화자분리만 개선", "note": "WER은 불변(텍스트 그대로)이나 화자 7명 정확 검출(Soniox 단독 6명보다 개선)"},
]


def _format_engine_row(entry: dict) -> list:
    wer_pct = entry["wer"] * 100
    status = "통과" if entry["wer"] < _PASS_THRESHOLD else "주의"
    return [entry["name"], f"WER {wer_pct:.2f}% — {entry['note']}", status]


def _format_experiment_row(entry: dict) -> list:
    before_pct = entry["before"] * 100
    after_pct = entry["after"] * 100
    detail = f"WER {before_pct:.2f}% → {after_pct:.2f}% — {entry['note']}"
    return [entry["name"], detail, entry["result"]]


def get_quality_rows() -> list:
    """admin 대시보드 '품질' 탭 표 형태를 카테고리별로 묶어서 반환:
    [{"category": str, "rows": [[name, detail, status], ...]}, ...]"""
    groups = [
        {"category": g["category"], "rows": [_format_engine_row(e) for e in g["entries"]]}
        for g in _ENGINE_GROUPS
    ]
    groups.append({
        "category": "개선 기법 검증 (같은 엔진에 기법 적용 전/후)",
        "rows": [_format_experiment_row(e) for e in _IMPROVEMENT_EXPERIMENTS],
    })
    return groups

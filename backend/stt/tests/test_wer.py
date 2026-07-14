import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3]))  # repo root

from backend.stt.wer import word_error_rate


def test_identical_text_has_zero_wer():
    assert word_error_rate("오늘 회의를 시작하겠습니다", "오늘 회의를 시작하겠습니다") == 0.0


def test_single_substitution():
    ref = "결제 모듈 오늘 논의합니다"
    hyp = "결제 모듈 내일 논의합니다"
    assert word_error_rate(ref, hyp) == 1 / 4


def test_deletion_counts_as_error():
    ref = "REST API 명세서 검토"
    hyp = "API 명세서 검토"
    assert word_error_rate(ref, hyp) == 1 / 4


def test_insertion_counts_as_error():
    ref = "일정 조정"
    hyp = "다음 주 일정 조정"
    assert word_error_rate(ref, hyp) == 2 / 2


def test_empty_reference_returns_zero():
    assert word_error_rate("", "아무 말이나") == 0.0

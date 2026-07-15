import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3]))  # repo root

from backend.stt.quality_report import get_quality_rows


def test_get_quality_rows_returns_three_columns_per_row():
    rows = get_quality_rows()

    assert len(rows) > 0
    for row in rows:
        assert len(row) == 3


def test_get_quality_rows_marks_low_wer_as_pass():
    rows = get_quality_rows()

    soniox_1bu = next(r for r in rows if "Soniox" in r[0] and "1부" in r[0])
    assert soniox_1bu[2] == "통과"


def test_get_quality_rows_includes_wer_percentage_in_detail():
    rows = get_quality_rows()

    assert any("40.66" in row[1] for row in rows)

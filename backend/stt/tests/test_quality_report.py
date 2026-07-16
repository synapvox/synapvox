import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3]))  # repo root

from backend.stt.quality_report import get_quality_rows


def _all_rows(groups):
    return [row for group in groups for row in group["rows"]]


def test_get_quality_rows_returns_categorized_groups():
    groups = get_quality_rows()

    assert len(groups) > 0
    for group in groups:
        assert "category" in group
        assert len(group["rows"]) > 0


def test_get_quality_rows_rows_have_three_columns():
    groups = get_quality_rows()

    for row in _all_rows(groups):
        assert len(row) == 3


def test_get_quality_rows_marks_low_wer_engine_as_pass():
    groups = get_quality_rows()

    group_1bu = next(g for g in groups if "1부" in g["category"])
    soniox_row = next(r for r in group_1bu["rows"] if "Soniox" in r[0])
    assert soniox_row[2] == "통과"


def test_get_quality_rows_includes_wer_percentage_in_detail():
    groups = get_quality_rows()
    rows = _all_rows(groups)

    assert any("40.66" in row[1] for row in rows)


def test_get_quality_rows_includes_improvement_experiments():
    groups = get_quality_rows()

    experiment_group = next(g for g in groups if "개선 기법" in g["category"])
    names = [row[0] for row in experiment_group["rows"]]

    assert any("boostings" in name for name in names)
    assert any("context.terms" in name for name in names)
    assert any("pyannote" in name for name in names)


def test_get_quality_rows_experiment_rows_show_before_after_wer():
    groups = get_quality_rows()

    experiment_group = next(g for g in groups if "개선 기법" in g["category"])
    soniox_terms_row = next(r for r in experiment_group["rows"] if "context.terms" in r[0])

    assert "34.28%" in soniox_terms_row[1]
    assert "33.38%" in soniox_terms_row[1]
    assert soniox_terms_row[2] == "개선 확인"

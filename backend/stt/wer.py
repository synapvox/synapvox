import argparse
import json
from pathlib import Path


def word_error_rate(reference: str, hypothesis: str) -> float:
    ref_words = reference.split()
    hyp_words = hypothesis.split()

    n, m = len(ref_words), len(hyp_words)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        dp[i][0] = i
    for j in range(m + 1):
        dp[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            if ref_words[i - 1] == hyp_words[j - 1]:
                dp[i][j] = dp[i - 1][j - 1]
            else:
                dp[i][j] = 1 + min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])

    return dp[n][m] / n if n else 0.0


def _load_text(path: str) -> str:
    if path.endswith(".json"):
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return " ".join(seg["text"] for seg in data["segments"])
    return Path(path).read_text(encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(
        description="Compute word error rate between a reference transcript and a hypothesis "
        "(accepts .txt or any backend.stt JSON output with segments[].text)"
    )
    parser.add_argument("reference_path")
    parser.add_argument("hypothesis_path")
    args = parser.parse_args()

    reference = _load_text(args.reference_path)
    hypothesis = _load_text(args.hypothesis_path)

    wer = word_error_rate(reference, hypothesis)
    print(f"WER: {wer:.4f} ({wer * 100:.2f}%)")


if __name__ == "__main__":
    main()

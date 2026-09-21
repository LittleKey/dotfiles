"""Deterministic candidate validator for product/engineering doc edits.

Stdlib only. Exit 0 = no findings, 1 = findings, 2 = invalid args/input.
"""

import argparse
import collections
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

PROCESS_PATTERNS = (
    r"根据(?:你|您|用户)的要求(?:进行|做|完成)",
    r"以下是(?:修改|调整|更新)后的版本",
    r"(?:已|已经)(?:删除|保留|补充|修改|调整)(?:了|以下|上述|该)",
    r"这里暂时保持原样",
)

MARKDOWN_ASSET_PATTERNS = {
    "images": r"!\[[^\]]*\]\([^\n)]+\)",
    "links": r"(?<!!)\[[^\]]+\]\([^\n)]+\)",
    "reference-definitions": r"(?m)^\[[^\]]+\]:\s+\S+.*$",
    "block-quotes": r"(?m)^>\s?.*$",
}


@dataclass
class Issue:
    code: str
    message: str


def validate_candidate(
    candidate: str,
    *,
    required: list[str],
    forbidden: list[str],
    exact_counts: dict[str, int],
    baseline: str | None,
    preserve_markdown_assets: bool,
) -> list[Issue]:
    if preserve_markdown_assets and baseline is None:
        raise ValueError("preserve_markdown_assets requires a baseline")

    issues: list[Issue] = []

    for pattern in PROCESS_PATTERNS:
        for m in re.finditer(pattern, candidate):
            issues.append(
                Issue("process-pollution", f"process phrase found: {m.group(0)!r}")
            )

    for text in required:
        observed = candidate.count(text)
        if observed == 0:
            issues.append(
                Issue(
                    "missing-required",
                    f"required text {text!r}: observed count 0",
                )
            )

    for text in forbidden:
        observed = candidate.count(text)
        if observed > 0:
            issues.append(
                Issue(
                    "forbidden-text",
                    f"forbidden text {text!r}: observed count {observed}",
                )
            )

    for text, expected in exact_counts.items():
        observed = candidate.count(text)
        if observed != expected:
            issues.append(
                Issue(
                    "unexpected-count",
                    f"text {text!r}: expected {expected}, observed {observed}",
                )
            )

    if preserve_markdown_assets:
        for category, pattern in MARKDOWN_ASSET_PATTERNS.items():
            base_counts = collections.Counter(re.findall(pattern, baseline))
            cand_counts = collections.Counter(re.findall(pattern, candidate))
            if base_counts != cand_counts:
                issues.append(
                    Issue(
                        "markdown-assets-changed",
                        f"category {category} changed: "
                        f"baseline {sum(base_counts.values())} -> "
                        f"candidate {sum(cand_counts.values())}",
                    )
                )

    return issues


def _parse_count(spec: str) -> tuple[str, int]:
    parts = spec.rsplit("=", 1)
    if len(parts) != 2 or not parts[0]:
        raise ValueError(f"invalid --count spec: {spec!r}")
    text, num = parts
    try:
        n = int(num)
    except ValueError:
        raise ValueError(f"invalid --count value in {spec!r}")
    if n < 0:
        raise ValueError(f"--count must be non-negative in {spec!r}")
    return text, n


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Deterministic candidate validator (no rich-text fidelity)."
    )
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--require", action="append", default=[])
    parser.add_argument("--forbid", action="append", default=[])
    parser.add_argument("--count", action="append", default=[], metavar="TEXT=N")
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--preserve-markdown-assets", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    try:
        exact_counts = dict(_parse_count(spec) for spec in args.count)
    except ValueError as exc:
        parser.error(str(exc))

    if args.preserve_markdown_assets and args.baseline is None:
        parser.error("--preserve-markdown-assets requires --baseline")

    try:
        candidate = args.candidate.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        parser.error(f"cannot read candidate {args.candidate}: {exc}")

    baseline = None
    if args.baseline is not None:
        try:
            baseline = args.baseline.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            parser.error(f"cannot read baseline {args.baseline}: {exc}")

    issues = validate_candidate(
        candidate,
        required=args.require,
        forbidden=args.forbid,
        exact_counts=exact_counts,
        baseline=baseline,
        preserve_markdown_assets=args.preserve_markdown_assets,
    )

    if args.json:
        print(
            json.dumps(
                [{"code": i.code, "message": i.message} for i in issues],
                ensure_ascii=False,
            )
        )
    else:
        for i in issues:
            print(f"{i.code}: {i.message}")

    return 1 if issues else 0


if __name__ == "__main__":
    sys.exit(main())

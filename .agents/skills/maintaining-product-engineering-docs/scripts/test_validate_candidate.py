import unittest
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))

from validate_candidate import validate_candidate, Issue


class TestValidateCandidate(unittest.TestCase):
    def test_process_pollution_detected(self):
        candidate = "根据你的要求进行了调整。\n系统使用 Redis 缓存。"
        issues = validate_candidate(
            candidate,
            required=[],
            forbidden=[],
            exact_counts={},
            baseline=None,
            preserve_markdown_assets=False,
        )
        codes = [i.code for i in issues]
        self.assertIn("process-pollution", codes)

    def test_no_process_pollution_for_normal_content(self):
        candidate = "用户可以删除草稿，删除操作需要二次确认。"
        issues = validate_candidate(
            candidate,
            required=[],
            forbidden=[],
            exact_counts={},
            baseline=None,
            preserve_markdown_assets=False,
        )
        codes = [i.code for i in issues]
        self.assertNotIn("process-pollution", codes)

    def test_required_forbidden_count(self):
        candidate = "超时阈值为 5 秒。旧方案仍保留。旧方案仍保留。"
        issues = validate_candidate(
            candidate,
            required=["回滚"],
            forbidden=["5 秒"],
            exact_counts={"旧方案仍保留。": 1},
            baseline=None,
            preserve_markdown_assets=False,
        )
        codes = sorted(i.code for i in issues)
        self.assertEqual(
            codes,
            ["forbidden-text", "missing-required", "unexpected-count"],
        )

    def test_missing_required_message_includes_text_and_count(self):
        issues = validate_candidate(
            "系统使用 Redis 缓存。",
            required=["回滚"],
            forbidden=[],
            exact_counts={},
            baseline=None,
            preserve_markdown_assets=False,
        )
        matches = [i for i in issues if i.code == "missing-required"]
        self.assertEqual(len(matches), 1)
        self.assertIn("回滚", matches[0].message)
        self.assertIn("0", matches[0].message)

    def test_forbidden_text_message_includes_text_and_count(self):
        issues = validate_candidate(
            "超时阈值为 5 秒，旧版本也是 5 秒。",
            required=[],
            forbidden=["5 秒"],
            exact_counts={},
            baseline=None,
            preserve_markdown_assets=False,
        )
        matches = [i for i in issues if i.code == "forbidden-text"]
        self.assertEqual(len(matches), 1)
        self.assertIn("5 秒", matches[0].message)
        self.assertIn("2", matches[0].message)

    def test_preserve_without_baseline_raises_value_error(self):
        with self.assertRaises(ValueError):
            validate_candidate(
                "任意内容",
                required=[],
                forbidden=[],
                exact_counts={},
                baseline=None,
                preserve_markdown_assets=True,
            )

    def test_markdown_assets_counter_only_changed_categories(self):
        baseline = "> a\n> b\n> c\n![架构图](arch.png)\n![架构图](arch.png)"
        candidate = "> a\n> b\n> c\n![架构图](arch.png)"
        issues = validate_candidate(
            candidate,
            required=[],
            forbidden=[],
            exact_counts={},
            baseline=baseline,
            preserve_markdown_assets=True,
        )
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0].code, "markdown-assets-changed")
        self.assertIn("images", issues[0].message)

    def test_duplicate_pollution_phrase_yields_two_issues(self):
        candidate = "根据你的要求进行了调整。根据你的要求进行了调整。"
        issues = validate_candidate(
            candidate,
            required=[],
            forbidden=[],
            exact_counts={},
            baseline=None,
            preserve_markdown_assets=False,
        )
        count = sum(1 for i in issues if i.code == "process-pollution")
        self.assertEqual(count, 2)

    def test_markdown_assets_changed(self):
        baseline = "[规范](https://example.com)\n![架构图](arch.png)\n> 约束"
        candidate = "[规范](https://example.com)\n> 约束"
        issues = validate_candidate(
            candidate,
            required=[],
            forbidden=[],
            exact_counts={},
            baseline=baseline,
            preserve_markdown_assets=True,
        )
        codes = [i.code for i in issues]
        self.assertIn("markdown-assets-changed", codes)


if __name__ == "__main__":
    unittest.main()

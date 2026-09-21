#!/usr/bin/env python3
"""Tests for the ORACLE_REVIEW_EVIDENCE mechanical validator (stdlib only).

Run: python3 tests/run_tests.py
"""

import copy
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"
SCRIPTS = HERE.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

import validate_manifest as vm  # noqa: E402

SCHEMA = json.loads((SCRIPTS.parent / "schemas" / "manifest.schema.json").read_text())

# Artifact files referenced by the valid fixture manifest.
ARTIFACT_FILES = ("snapshot.md", "base.md")
ONES = "1" * 64
ZEROS = "0" * 64


def errors_for(name):
    return vm.validate(FIXTURES / name / "manifest.json")


def errors_for_manifest(m, tmpdir, name="manifest.json"):
    p = Path(tmpdir) / name
    p.write_text(json.dumps(m))
    return vm.validate(p)


def errors_for_mutation(mutate):
    """Validate a deep copy of the valid fixture manifest after mutate(m).

    The mutated manifest plus its referenced artifact files are materialised
    into a fresh temp dir, so every negative test starts from an accessible
    valid baseline whose artifact references still resolve, differing only by
    the mutation under test.
    """
    m = json.loads((FIXTURES / "valid" / "manifest.json").read_text())
    mutate(m)
    with tempfile.TemporaryDirectory() as td:
        for f in ARTIFACT_FILES:
            shutil.copy(FIXTURES / "valid" / f, Path(td) / f)
        return errors_for_manifest(m, td)


class TestPositive(unittest.TestCase):
    def test_valid_manifest_passes(self):
        self.assertEqual(errors_for("valid"), [])

    def test_generic_overlay_manifest_passes(self):
        """Distinct explicit generic/no-overlay representation is accepted."""
        self.assertEqual(errors_for("generic_overlay"), [])
        m = json.loads((FIXTURES / "generic_overlay" / "manifest.json").read_text())
        self.assertIs(m["reviewContract"]["overlay"].get("generic"), True)

    def test_combined_named_overlays_accepted(self):
        """Multiple explicit named overlays combine; declared set is what we check."""
        m = json.loads((FIXTURES / "valid" / "manifest.json").read_text())
        self.assertEqual(m["reviewContract"]["overlay"]["overlays"],
                         ["product-engineering", "external-audience"])
        self.assertEqual(errors_for("valid"), [])


class TestSchemaAgreement(unittest.TestCase):
    def test_schema_and_validator_agree_on_identity(self):
        self.assertEqual(SCHEMA["properties"]["version"]["const"], vm.VERSION)
        self.assertEqual(SCHEMA["properties"]["schema"]["const"], vm.SCHEMA_NAME)

    def test_schema_encodes_same_field_contract(self):
        art = SCHEMA["properties"]["artifacts"]["items"]
        self.assertIn("role", art["required"])
        self.assertEqual(set(art["properties"]["role"]["enum"]), {"snapshot", "base"})
        self.assertIn("pattern", art["properties"]["sha256"])
        self.assertIn("referenceMap", art["properties"])
        self.assertEqual(SCHEMA["properties"]["comparisons"]["type"], "array")
        self.assertEqual(SCHEMA["properties"]["comparisons"]["items"]["type"], "object")
        overlays = SCHEMA["properties"]["reviewContract"]["properties"]["overlay"] \
            ["properties"]["overlays"]["items"]["enum"]
        self.assertEqual(tuple(overlays), vm.DEFINED_OVERLAYS)

    def test_schema_requires_non_empty_overlays_and_string_omission_locators(self):
        overlay = SCHEMA["properties"]["reviewContract"]["properties"]["overlay"]
        self.assertEqual(overlay["properties"]["overlays"].get("minItems"), 1)
        art = SCHEMA["properties"]["artifacts"]["items"]
        omissions = art["properties"]["omissions"]["items"]["properties"]
        self.assertEqual(omissions["locator"].get("type"), "string")


class TestNegatives(unittest.TestCase):
    """Each negative test mutates an accessible valid baseline (artifact
    references still resolve) and asserts the specific structural error."""

    def assert_specific(self, errs, prefix, fragment):
        self.assertTrue(
            any(e.startswith(prefix) and fragment in e for e in errs),
            f"expected an error starting with {prefix!r} containing {fragment!r}; got {errs}")

    def test_missing_artifact_rejected(self):
        errs = errors_for_mutation(
            lambda m: m["artifacts"][0].__setitem__("path", "ghost.md"))
        self.assert_specific(errs, "artifacts[0].path:", "artifact not accessible")

    def test_missing_reference_map_rejected(self):
        errs = errors_for_mutation(lambda m: m["artifacts"][0].pop("referenceMap"))
        self.assert_specific(errs, "artifacts[0].referenceMap:",
                             "required, non-empty object mapping locators")

    def test_hash_mismatch_rejected(self):
        errs = errors_for_mutation(
            lambda m: m["artifacts"][0].__setitem__("sha256", ZEROS))
        self.assert_specific(errs, "artifacts[0].sha256:",
                             "hash mismatch: expected " + ZEROS)

    def test_fingerprint_mismatch_rejected(self):
        errs = errors_for_mutation(
            lambda m: m["reviewContract"]["candidate"].__setitem__("fingerprint", ONES))
        self.assert_specific(errs, "artifacts[0].sha256:",
                             "does not match contract candidate fingerprint")

    def test_missing_candidate_binding_rejected(self):
        errs = errors_for_mutation(lambda m: m["reviewContract"].pop("candidate"))
        self.assert_specific(errs, "reviewContract.candidate:",
                             "required: candidate identity, revision, and fingerprint")

    def test_comparison_missing_base_revision_rejected(self):
        errs = errors_for_mutation(lambda m: m["comparisons"][0].pop("baseRevision"))
        self.assert_specific(errs, "comparisons[0].baseRevision:",
                             "must name its base revision")

    def test_bare_base_hash_rejected(self):
        def mutate(m):
            m["comparisons"][1]["baseline"] = m["artifacts"][1]["sha256"]
        errs = errors_for_mutation(mutate)
        self.assert_specific(errs, "comparisons[1].baseline:",
                             "bare base hash is not accepted")

    def test_ambiguous_overlay_rejected(self):
        """Neither generic nor named overlays = ambiguous = invalid."""
        errs = errors_for_mutation(lambda m: m["reviewContract"].__setitem__("overlay", {}))
        self.assert_specific(errs, "reviewContract.overlay:",
                             'must set exactly one of "generic": true')

    def test_unknown_overlay_rejected(self):
        errs = errors_for_mutation(
            lambda m: m["reviewContract"]["overlay"].__setitem__("overlays", ["made-up"]))
        self.assert_specific(errs, "reviewContract.overlay.overlays:",
                             "'made-up' is not a defined overlay")

    def test_baseline_only_manifest_rejected(self):
        errs = errors_for_mutation(lambda m: m.__setitem__("artifacts", [m["artifacts"][1]]))
        self.assert_specific(errs, "artifacts:",
                             "exactly one artifact with role=snapshot")

    def test_pair_unequal_hashes_rejected(self):
        errs = errors_for_mutation(
            lambda m: m["comparisons"][1]["baseline"].__setitem__("baselineSha256", ZEROS))
        self.assert_specific(errs, "comparisons[1].baseline:",
                             "paired content hashes differ")

    def test_pair_unknown_locator_rejected(self):
        errs = errors_for_mutation(
            lambda m: m["comparisons"][1]["baseline"].__setitem__("candidateLocator", "Section Z"))
        self.assert_specific(errs, "comparisons[1].baseline.candidateLocator:",
                             "not found in snapshot artifact reference map")

    def test_pair_hashes_not_compared_to_whole_file_hash(self):
        """Scoped pair hashes are never validated against whole-file hashes."""
        def mutate(m):
            snap_sha = m["artifacts"][0]["sha256"]
            base_sha = m["artifacts"][1]["sha256"]
            m["comparisons"][1]["baseline"] = {
                "candidateLocator": "Section A", "candidateSha256": snap_sha,
                "baselineLocator": "Section A", "baselineSha256": base_sha}
        errs = errors_for_mutation(mutate)
        self.assert_specific(errs, "comparisons[1].baseline.candidateSha256:",
                             "does not match snapshot reference map entry")
        self.assert_specific(errs, "comparisons[1].baseline.baselineSha256:",
                             "does not match baseline reference map entry")

    def test_baseline_source_mismatch_rejected(self):
        errs = errors_for_mutation(
            lambda m: m["artifacts"][1].__setitem__("source", "docs/other.md"))
        self.assert_specific(errs, "comparisons[0].baseline:",
                             "!= contract candidate source")

    def test_baseline_revision_mismatch_rejected(self):
        errs = errors_for_mutation(
            lambda m: m["artifacts"][1].__setitem__("revision", "r5"))
        self.assert_specific(errs, "comparisons[0].baseline:",
                             "!= declared baseRevision")

    def test_comparisons_non_array_rejected(self):
        """A present comparisons field must be an array regardless of truthiness."""
        for bad in (None, False, 0, "", {}):
            with self.subTest(bad=bad):
                errs = errors_for_mutation(
                    lambda m, bad=bad: m.__setitem__("comparisons", bad))
                self.assert_specific(errs, "comparisons:", "must be an array")

    def test_empty_comparisons_array_is_valid(self):
        """An empty array is type-valid (no 'must be an array' error); the only
        complaint is the cross-binding one: base artifact r6 loses its consumer."""
        errs = errors_for_mutation(lambda m: m.__setitem__("comparisons", []))
        self.assertEqual(
            errs, ["artifacts[1].revision: base artifact revision 'r6' matches no "
                   "declared comparison baseRevision"])

    def test_generic_true_with_empty_overlays_rejected(self):
        """{generic: true, overlays: []} is neither valid representation alone:
        the overlays key present must carry a non-empty array."""
        def mutate(m):
            m["reviewContract"]["overlay"] = {"generic": True, "overlays": []}
        errs = errors_for_mutation(mutate)
        self.assert_specific(errs, "reviewContract.overlay.overlays:",
                             "must be a non-empty array of overlay names")

    def test_omission_non_string_locator_rejected(self):
        def mutate(m):
            m["artifacts"][0]["omissions"] = [{"description": "ok", "locator": 5}]
        errs = errors_for_mutation(mutate)
        self.assert_specific(errs, "artifacts[0].omissions[0].locator:",
                             "must be a string when present")

    def test_omission_with_string_locator_is_valid(self):
        def mutate(m):
            m["artifacts"][0]["omissions"] = [{"description": "ok", "locator": "Section B"}]
        self.assertEqual(errors_for_mutation(mutate), [])


class TestRobustness(unittest.TestCase):
    def test_version_type_is_checked(self):
        m = json.loads((FIXTURES / "valid" / "manifest.json").read_text())
        for bad in ("1", True, 1.0, None):
            mm = copy.deepcopy(m)
            mm["version"] = bad
            with tempfile.TemporaryDirectory() as td:
                errs = errors_for_manifest(mm, td)
            self.assertTrue(any("version" in e for e in errs), (bad, errs))

    def test_malformed_input_never_raises(self):
        """Any malformed input yields controlled error strings."""
        m = json.loads((FIXTURES / "valid" / "manifest.json").read_text())
        corruptions = [
            ("schema", None), ("schema", 42), ("version", "1"),
            ("invocation", None), ("invocation", []), ("invocation", "x"),
            ("invocation", {"dispatchId": 1, "invokedBy": None, "invokedAt": []}),
            ("reviewContract", None), ("reviewContract", []), ("reviewContract", "x"),
            ("reviewContract", {"suppliedBy": "parent"}),
            ("selectedScope", None), ("selectedScope", 7), ("selectedScope", ""),
            ("writerScanRecords", None), ("writerScanRecords", {}),
            ("writerScanRecords", [None]), ("writerScanRecords", [{"description": 5}]),
            ("writerScanRecords", [{"description": "d", "locator": 3}]),
            ("artifacts", None), ("artifacts", {}), ("artifacts", [1]), ("artifacts", ["x"]),
            ("artifacts", [{"role": 1}, {"role": None}]),
            ("artifacts", [{"role": "snapshot", "sha256": 5, "referenceMap": {"A": 9},
                            "omissions": "x", "path": None, "source": [], "revision": {},
                            "retrievedAt": 0}]),
            ("artifacts", [{"role": "snapshot", "sha256": "z" * 64,
                            "referenceMap": {"A": "z" * 64},
                            "omissions": [{"description": "d", "locator": 3}],
                            "path": 1, "source": {}, "revision": True,
                            "retrievedAt": []}]),
            ("comparisons", None), ("comparisons", False), ("comparisons", 0),
            ("comparisons", ""), ("comparisons", {}),
            ("comparisons", "x"),
            ("comparisons", [None]),
            ("comparisons", [{"claim": 1, "baseRevision": [], "baseline": 3}]),
            ("comparisons", [{"claim": "c", "baseRevision": "r6",
                              "baseline": {"candidateSha256": 5, "candidateLocator": None,
                                           "baselineSha256": [], "baselineLocator": {}}}]),
        ]
        for field, value in corruptions:
            with self.subTest(field=field, value=value):
                mm = copy.deepcopy(m)
                mm[field] = value
                with tempfile.TemporaryDirectory() as td:
                    errs = errors_for_manifest(mm, td)
                self.assertIsInstance(errs, list)
                self.assertTrue(errs, f"expected errors for corrupting {field}")
                self.assertTrue(all(isinstance(e, str) for e in errs))

    def test_unreadable_and_non_object_manifests(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "broken.json"
            p.write_text("{not json")
            self.assertEqual(len(vm.validate(p)), 1)
            p.write_text("[1, 2]")
            self.assertEqual(vm.validate(p), ["manifest: top level must be an object"])
            self.assertEqual(len(vm.validate(Path(td) / "nope.json")), 1)

    def test_invalid_utf8_manifest_never_raises(self):
        """Invalid UTF-8/decoding errors return controlled errors, never raise."""
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "bad-utf8.json"
            p.write_bytes(b'{"schema": "\xff\xfe not utf-8"}')
            errs = vm.validate(p)
        self.assertIsInstance(errs, list)
        self.assertEqual(len(errs), 1)
        self.assertTrue(errs[0].startswith("manifest: unreadable or invalid JSON"), errs)

    def test_overlay_type_garbage(self):
        m = json.loads((FIXTURES / "valid" / "manifest.json").read_text())
        for ov in (None, "generic", [], 5, {"generic": "yes"}, {"overlays": {}},
                   {"overlays": []}, {"generic": True, "overlays": []},
                   {"generic": True, "overlays": ["product-engineering"]}):
            with self.subTest(ov=ov):
                mm = copy.deepcopy(m)
                mm["reviewContract"]["overlay"] = ov
                with tempfile.TemporaryDirectory() as td:
                    errs = errors_for_manifest(mm, td)
                self.assertIsInstance(errs, list)
                self.assertTrue(any("reviewContract.overlay" in e for e in errs), (ov, errs))


class TestCli(unittest.TestCase):
    def _run(self, fixture):
        return subprocess.run(
            [sys.executable, str(SCRIPTS / "validate_manifest.py"),
             str(FIXTURES / fixture / "manifest.json")],
            capture_output=True, text=True)

    def test_cli_exit_codes(self):
        v = self._run("valid")
        self.assertEqual(v.returncode, 0, v.stdout + v.stderr)
        self.assertIn("No freshness", v.stdout)
        i = self._run("hash_mismatch")
        self.assertEqual(i.returncode, 1, i.stdout + i.stderr)
        self.assertIn("hash mismatch", i.stdout)
        b = self._run("baseline_only")
        self.assertEqual(b.returncode, 1, b.stdout + b.stderr)
        self.assertIn("exactly one artifact with role=snapshot", b.stdout)

    def test_cli_smoke_on_mutated_valid_baseline(self):
        """CLI smoke on an accessible mutated baseline: UTF-8 round trip both ways."""
        with tempfile.TemporaryDirectory() as td:
            for f in ARTIFACT_FILES:
                shutil.copy(FIXTURES / "valid" / f, Path(td) / f)
            good = Path(td) / "good.json"
            bad = Path(td) / "bad.json"
            bad.write_bytes(b'{"schema": "\xff\xfe"}')
            g = subprocess.run(
                [sys.executable, str(SCRIPTS / "validate_manifest.py"), str(good)],
                capture_output=True, text=True)
            b = subprocess.run(
                [sys.executable, str(SCRIPTS / "validate_manifest.py"), str(bad)],
                capture_output=True, text=True)
        self.assertEqual(g.returncode, 1, g.stdout + g.stderr)  # missing manifest itself
        self.assertIn("unreadable or invalid JSON", b.stdout + b.stderr)
        self.assertEqual(b.returncode, 1, b.stdout + b.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)

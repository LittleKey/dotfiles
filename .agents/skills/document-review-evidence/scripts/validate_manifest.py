#!/usr/bin/env python3
"""Mechanical validator for ORACLE_REVIEW_EVIDENCE manifests (schema v1).

Shape is documented in ../schemas/manifest.schema.json; this script is the
normative mechanical check. It verifies, and ONLY verifies:

  - structural requirements (invocation metadata, parent-owned review
    contract with scope/criteria/protected-content/documentType/audience/
    overlay, selected scope, writer scan records, artifacts with declared
    omissions, comparisons),
  - exactly one candidate snapshot artifact (a baseline-only manifest is
    invalid),
  - candidate binding: the parent-declared candidate (source/revision/
    fingerprint) checked against the observed snapshot artifact,
  - local artifact accessibility and whole-file SHA-256 match,
  - comparison backing: a scoped role=base artifact bound to the same
    candidate source identity and the comparison's declared baseRevision,
    or a precisely located candidate/base hash pair whose locators resolve
    in the relevant artifacts' reference maps and whose paired content
    hashes are equal. Scoped hashes are NEVER compared to whole-file
    artifact hashes.

It does NOT claim freshness, semantic coverage, or suitability. Those remain
parent/Oracle judgments. Declared selected scope and writer scan records are
structurally validated only (writer records are claims, not coverage proof);
there is deliberately NO requirement that evidence levels or a full scan be
independently verified here — semantic sufficiency is Oracle's call.

Malformed input never raises: validate() always returns a list of error
strings (an internal guard converts unexpected failures into errors).

Stdlib only. Exit 0 = mechanically valid, 1 = invalid.
"""

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

SCHEMA_NAME = "oracle-review-evidence/manifest"
VERSION = 1
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
# Named overlays defined by the skill's references/core.md. The distinct
# no-overlay representation is contract.overlay == {"generic": true}.
DEFINED_OVERLAYS = ("product-engineering", "external-audience")
PAIR_FIELDS = ("candidateLocator", "candidateSha256", "baselineLocator", "baselineSha256")


def _err(errors, where, msg):
    errors.append(f"{where}: {msg}")


def _s(v):
    """Non-empty string."""
    return isinstance(v, str) and v.strip() != ""


def _is_sha(v):
    return isinstance(v, str) and SHA256_RE.fullmatch(v) is not None


def _str_list(v):
    return isinstance(v, list) and bool(v) and all(_s(x) for x in v)


def _sha256_file(fp):
    return hashlib.sha256(fp.read_bytes()).hexdigest()


def _check_overlay(errors, ov):
    if not isinstance(ov, dict):
        _err(errors, "reviewContract.overlay",
             "required: absent or ambiguous overlay metadata prevents criteria selection")
        return
    generic = ov.get("generic", False)
    if "generic" in ov and not isinstance(generic, bool):
        _err(errors, "reviewContract.overlay.generic", "must be a boolean")
        generic = False
    overlays = ov.get("overlays")
    named_ok = True
    if "overlays" in ov:
        if not _str_list(overlays):
            _err(errors, "reviewContract.overlay.overlays",
                 "must be a non-empty array of overlay names")
            named_ok = False
        else:
            for name in overlays:
                if name not in DEFINED_OVERLAYS:
                    _err(errors, "reviewContract.overlay.overlays",
                         f"{name!r} is not a defined overlay")
            if len(set(overlays)) != len(overlays):
                _err(errors, "reviewContract.overlay.overlays", "must not repeat overlays")
    # Distinct representations: explicit generic OR one/more named overlays,
    # never both and never neither (neither is ambiguous).
    has_generic = generic is True
    has_named = named_ok and isinstance(overlays, list) and len(overlays) > 0
    if has_generic == has_named:
        _err(errors, "reviewContract.overlay",
             'must set exactly one of "generic": true or a non-empty "overlays" list')


def _check_contract(errors, contract):
    if not isinstance(contract, dict):
        _err(errors, "reviewContract", "required: parent-owned review contract")
        return None
    if contract.get("suppliedBy") != "parent":
        _err(errors, "reviewContract.suppliedBy", 'must be "parent"')
    if not _s(contract.get("scope")):
        _err(errors, "reviewContract.scope", "required, non-empty string")
    if not _s(contract.get("documentType")):
        _err(errors, "reviewContract.documentType", "required, parent-confirmed document type")
    if not _s(contract.get("audience")):
        _err(errors, "reviewContract.audience", "required, parent-confirmed audience")
    _check_overlay(errors, contract.get("overlay"))
    if not _str_list(contract.get("criteria")):
        _err(errors, "reviewContract.criteria", "required, non-empty array of non-empty strings")
    if not _s(contract.get("protectedContent")):
        _err(errors, "reviewContract.protectedContent",
             'required declaration (use "none" if nothing is protected)')
    cand = contract.get("candidate")
    if not isinstance(cand, dict):
        _err(errors, "reviewContract.candidate", "required: candidate identity, revision, and fingerprint")
        return None
    for f in ("source", "revision"):
        if not _s(cand.get(f)):
            _err(errors, f"reviewContract.candidate.{f}", "required, non-empty string")
    if not _is_sha(cand.get("fingerprint")):
        _err(errors, "reviewContract.candidate.fingerprint", "must be 64 lowercase hex chars")
    return cand


def _check_reference_map(errors, where, a):
    refmap = a.get("referenceMap")
    if not isinstance(refmap, dict) or not refmap:
        _err(errors, f"{where}.referenceMap",
             "required, non-empty object mapping locators to 64-hex content hashes")
        return {}
    for loc, h in refmap.items():
        if not _s(loc):
            _err(errors, f"{where}.referenceMap", "locator keys must be non-empty strings")
        if not _is_sha(h):
            _err(errors, f"{where}.referenceMap.{loc}", "must be 64 lowercase hex chars")
    return refmap


def _check_artifact(errors, a, where, cand, base_revs, snapshots, bases, manifest_dir):
    if not isinstance(a, dict):
        _err(errors, where, "must be an object")
        return
    for f in ("role", "path", "sha256", "source", "revision", "retrievedAt"):
        if not _s(a.get(f)):
            _err(errors, f"{where}.{f}", "required, non-empty string")
    role = a.get("role")
    if role not in ("snapshot", "base"):
        _err(errors, f"{where}.role", 'must be "snapshot" or "base"')
    _check_reference_map(errors, where, a)
    omissions = a.get("omissions")
    if not isinstance(omissions, list):
        _err(errors, f"{where}.omissions", "required array (may be empty; omissions must be declared)")
    else:
        for j, o in enumerate(omissions):
            if not isinstance(o, dict) or not _s(o.get("description")):
                _err(errors, f"{where}.omissions[{j}]", "each omission needs a non-empty description")
            elif "locator" in o and not isinstance(o["locator"], str):
                _err(errors, f"{where}.omissions[{j}].locator", "must be a string when present")

    sha = a.get("sha256")
    if not _is_sha(sha):
        _err(errors, f"{where}.sha256", "must be 64 lowercase hex chars")

    if role == "snapshot":
        snapshots.append(a)
        if cand:
            if _s(cand.get("source")) and a.get("source") != cand.get("source"):
                _err(errors, f"{where}.source",
                     f"snapshot source {a.get('source')!r} != contract candidate source {cand.get('source')!r}")
            if _s(cand.get("revision")) and a.get("revision") != cand.get("revision"):
                _err(errors, f"{where}.revision",
                     f"snapshot revision {a.get('revision')!r} != contract candidate revision {cand.get('revision')!r}")
            if _is_sha(sha) and _is_sha(cand.get("fingerprint")) and cand["fingerprint"] != sha:
                _err(errors, f"{where}.sha256",
                     f"does not match contract candidate fingerprint {cand['fingerprint']!r}")
    elif role == "base" and _s(a.get("revision")) and a["revision"] not in base_revs:
        _err(errors, f"{where}.revision",
             f"base artifact revision {a['revision']!r} matches no declared comparison baseRevision")
    if role == "base":
        bases.append(a)

    # Local accessibility + whole-file hash match (mechanical; a valid result
    # here says nothing about freshness or content suitability).
    ap = a.get("path", "")
    if _s(ap):
        fp = Path(ap)
        if not fp.is_absolute():
            fp = manifest_dir / fp
        if not fp.is_file():
            _err(errors, f"{where}.path", f"artifact not accessible: {fp}")
        elif _is_sha(sha):
            actual = _sha256_file(fp)
            if actual != sha:
                _err(errors, f"{where}.sha256", f"hash mismatch: expected {sha}, actual {actual}")


def _check_baseline_shape(errors, c, where):
    """Pass 1: structural shape of baseline. Returns 'artifact' | 'pair' | None."""
    baseline = c.get("baseline")
    if not isinstance(baseline, dict):
        _err(errors, f"{where}.baseline",
             "required: comparison needs a scoped role=base artifact or a located candidate/base hash pair; a bare base hash is not accepted")
        return None
    if _s(baseline.get("artifact")):
        if set(baseline) - {"artifact"}:
            _err(errors, f"{where}.baseline", "artifact-form baseline must contain only 'artifact'")
        return "artifact"
    if all(f in baseline for f in PAIR_FIELDS):
        for f in ("candidateSha256", "baselineSha256"):
            if not _is_sha(baseline.get(f)):
                _err(errors, f"{where}.baseline.{f}", "must be 64 lowercase hex chars")
        for f in ("candidateLocator", "baselineLocator"):
            if not _s(baseline.get(f)):
                _err(errors, f"{where}.baseline.{f}", "required, non-empty string")
        return "pair"
    _err(errors, f"{where}.baseline",
         'must be {"artifact": <role=base artifact path>} or a located candidate/base hash pair '
         f'({", ".join(PAIR_FIELDS)}); a bare base hash is not accepted')
    return None


def _check_comparisons_pass2(errors, comparisons, bases, snap, cand):
    """Pass 2: bind baseline references to candidate source identity and the
    comparison's declared baseRevision; verify located hash pairs against the
    relevant artifacts' reference maps. Scoped hashes are never compared to
    whole-file artifact hashes."""
    for i, c in enumerate(comparisons):
        if not isinstance(c, dict):
            continue
        where = f"comparisons[{i}]"
        b = c.get("baseline")
        if not isinstance(b, dict):
            continue
        base_rev = c.get("baseRevision")
        base_rev_ok = _s(base_rev)
        cand_source = cand.get("source") if cand else None

        if _s(b.get("artifact")):
            ref = next((a for a in bases if a.get("path") == b["artifact"]), None)
            if ref is None:
                _err(errors, f"{where}.baseline.artifact",
                     f"{b['artifact']!r} does not reference an artifact with role=base")
                continue
        else:
            if not all(f in b for f in PAIR_FIELDS):
                continue  # shape errors already reported in pass 1
            if not base_rev_ok:
                continue  # baseRevision error already reported
            ref = next((a for a in bases if a.get("revision") == base_rev), None)
            if ref is None:
                _err(errors, f"{where}.baseline",
                     f"no role=base artifact with revision matching declared baseRevision {base_rev!r}")
                continue

        # Source identity + revision binding for every baseline reference.
        if cand and _s(cand_source) and _s(ref.get("source")) and ref.get("source") != cand_source:
            _err(errors, f"{where}.baseline",
                 f"baseline source {ref.get('source')!r} != contract candidate source {cand_source!r}")
        if base_rev_ok and _s(ref.get("revision")) and ref.get("revision") != base_rev:
            _err(errors, f"{where}.baseline",
                 f"baseline artifact revision {ref.get('revision')!r} != declared baseRevision {base_rev!r}")

        # Pair-form: resolve both locators via reference maps, then require
        # equal paired content hashes.
        if not all(f in b for f in PAIR_FIELDS):
            continue
        snap_map = snap.get("referenceMap") if snap and isinstance(snap, dict) else None
        base_map = ref.get("referenceMap") if isinstance(ref, dict) else None
        c_loc, b_loc = b.get("candidateLocator"), b.get("baselineLocator")
        if not isinstance(snap_map, dict) or c_loc not in snap_map:
            _err(errors, f"{where}.baseline.candidateLocator",
                 f"{c_loc!r} not found in snapshot artifact reference map")
        if not isinstance(base_map, dict) or b_loc not in base_map:
            _err(errors, f"{where}.baseline.baselineLocator",
                 f"{b_loc!r} not found in baseline artifact reference map")
            continue
        if c_loc in (snap_map or {}) and _is_sha(b.get("candidateSha256")) \
                and snap_map[c_loc] != b["candidateSha256"]:
            _err(errors, f"{where}.baseline.candidateSha256",
                 f"does not match snapshot reference map entry for {c_loc!r}")
        if b_loc in base_map and _is_sha(b.get("baselineSha256")) \
                and base_map[b_loc] != b["baselineSha256"]:
            _err(errors, f"{where}.baseline.baselineSha256",
                 f"does not match baseline reference map entry for {b_loc!r}")
        if _is_sha(b.get("candidateSha256")) and _is_sha(b.get("baselineSha256")) \
                and b["candidateSha256"] != b["baselineSha256"]:
            _err(errors, f"{where}.baseline",
                 f"paired content hashes differ: candidate {b['candidateSha256']} vs baseline {b['baselineSha256']}")


def _check(errors, m, manifest_dir):
    if m.get("schema") != SCHEMA_NAME:
        _err(errors, "schema", f'must be "{SCHEMA_NAME}"')
    v = m.get("version")
    if not (isinstance(v, int) and not isinstance(v, bool) and v == VERSION):
        _err(errors, "version", f"must be the integer {VERSION}")

    inv = m.get("invocation")
    if not isinstance(inv, dict):
        _err(errors, "invocation", "required object (manifest-only invocation metadata)")
    else:
        for f in ("dispatchId", "invokedBy", "invokedAt"):
            if not _s(inv.get(f)):
                _err(errors, f"invocation.{f}", "required, non-empty string")

    # Structure only: these declare what was selected/reported; semantic
    # sufficiency (coverage, scan quality) is Oracle's judgment, not ours.
    if not _s(m.get("selectedScope")):
        _err(errors, "selectedScope", "required, non-empty string (declared selected scope)")
    wsr = m.get("writerScanRecords")
    if not isinstance(wsr, list):
        _err(errors, "writerScanRecords",
             "required array (may be empty; records are writer claims, structurally validated only)")
    else:
        for j, r in enumerate(wsr):
            if not isinstance(r, dict) or not _s(r.get("description")):
                _err(errors, f"writerScanRecords[{j}]", "each record needs a non-empty description")
            elif "locator" in r and not isinstance(r["locator"], str):
                _err(errors, f"writerScanRecords[{j}].locator", "must be a string when present")

    cand = _check_contract(errors, m.get("reviewContract"))

    base_revs = set()
    comparisons = m.get("comparisons", [])
    if not isinstance(comparisons, list):
        _err(errors, "comparisons", "must be an array")
        comparisons = []
    for i, c in enumerate(comparisons):
        if not isinstance(c, dict):
            _err(errors, f"comparisons[{i}]", "must be an object")
            continue
        if not _s(c.get("claim")):
            _err(errors, f"comparisons[{i}].claim", "required, non-empty string")
        base_rev = c.get("baseRevision")
        if not _s(base_rev):
            _err(errors, f"comparisons[{i}].baseRevision",
                 "required: a declared comparison must name its base revision")
        else:
            base_revs.add(base_rev)
        _check_baseline_shape(errors, c, f"comparisons[{i}]")

    artifacts = m.get("artifacts")
    if not (isinstance(artifacts, list) and artifacts):
        _err(errors, "artifacts", "required, non-empty array")
        artifacts = []
    snapshots, bases, seen_paths = [], [], set()
    for i, a in enumerate(artifacts):
        where = f"artifacts[{i}]"
        if not isinstance(a, dict):
            _err(errors, where, "must be an object")
            continue
        ap = a.get("path")
        if _s(ap):
            if ap in seen_paths:
                _err(errors, where, f"duplicate artifact path {ap!r}")
            seen_paths.add(ap)
        _check_artifact(errors, a, where, cand, base_revs, snapshots, bases, manifest_dir)

    # Exactly one candidate snapshot; candidate binding requires it.
    if len(snapshots) != 1:
        _err(errors, "artifacts",
             f"exactly one artifact with role=snapshot is required (baseline-only manifests are invalid); found {len(snapshots)}")
    snap = snapshots[0] if len(snapshots) == 1 else None

    _check_comparisons_pass2(errors, comparisons, bases, snap, cand)


def validate(manifest_path):
    """Return a list of error strings; empty list = mechanically valid.

    Never raises: unreadable files, invalid UTF-8, invalid JSON, and
    structurally malformed manifests all produce controlled error strings.
    """
    errors = []
    try:
        m = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        return [f"manifest: unreadable or invalid JSON: {e}"]
    if not isinstance(m, dict):
        return ["manifest: top level must be an object"]
    try:
        _check(errors, m, Path(manifest_path).parent)
    except Exception as e:  # last-resort guard: malformed input never raises
        _err(errors, "validator", f"internal error while validating ({e!r}); manifest treated as invalid")
    return errors


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Mechanical validation of an ORACLE_REVIEW_EVIDENCE manifest "
                    "(structure, candidate binding, artifact access/SHA-256 only).")
    ap.add_argument("manifest", help="path to the evidence manifest JSON")
    args = ap.parse_args(argv)

    errors = validate(args.manifest)
    if errors:
        print("INVALID (mechanical validation):")
        for e in errors:
            print(f"  - {e}")
        return 1
    print("VALID (mechanical checks only: structure, parent-contract candidate binding, "
          "artifact accessibility, SHA-256).")
    print("No freshness, semantic coverage, or suitability is claimed or verified.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

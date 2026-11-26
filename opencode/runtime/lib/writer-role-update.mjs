// Explicit offline source update, never imported by stage/install/model hooks.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { OWNERSHIP_MOVED } from "./ownership.mjs";

export const PAYLOAD_HASHES = Object.freeze({
  "document-writer.md": "36ef44de293053e5fbeb743851d63ba5c9965a85c78147e2b40dacc50f71fd9d",
  "routing.json": "9de5fb6d0ee5244e6398424326620ef557bfc478beef8a793d36d5f1186da115",
  "audience.md": "0e5c2d7a7ad22309dab93659b43224f7000143219813356712179c532f5c67a3",
  "oracle-line.txt": "1cbc333a6b9d0b6a2c868fa1bb3191d369f9c8a4b68f18b2e83c202aa58b0c28",
});
export const SOURCE_PREFIX = "openchamber/plugin/roles/";
export const SNAPSHOT = "runtime/resources/writer-role";
export const OUTPUTS = [
  "oh-my-opencode-slim/document-writer.md", "oh-my-opencode-slim.json",
  "oh-my-opencode-slim/orchestrator_append.md", "oh-my-opencode-slim/oracle_append.md",
  "runtime/profile.json",
];
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = message => { throw new Error(`writer-role update refused: ${message}`); };
const utf8 = bytes => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const regular = path => {
  if (!lstatSync(path).isFile()) fail(`not a regular file: ${path}`);
  return readFileSync(path);
};

// JSON is validated first; token spans let us change selected values without
// serializing the owner's other settings or changing their whitespace.
export function replaceJsonValues(text, replacements) {
  JSON.parse(text);
  const tokens = [...text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g)];
  let i = 0;
  const spans = new Map();
  function value(path) {
    const start = tokens[i].index;
    const token = tokens[i++][0];
    if (token === "{") {
      const keys = new Set();
      while (tokens[i][0] !== "}") {
        const key = JSON.parse(tokens[i++][0]);
        if (keys.has(key)) fail("duplicate JSON key");
        keys.add(key);
        i++; // colon
        value([...path, key]);
        if (tokens[i][0] !== ",") break;
        i++;
      }
      i++;
    } else if (token === "[") {
      let index = 0;
      while (tokens[i][0] !== "]") {
        value([...path, index++]);
        if (tokens[i][0] !== ",") break;
        i++;
      }
      i++;
    }
    const last = tokens[i - 1];
    spans.set(JSON.stringify(path), [start, last.index + last[0].length]);
  }
  value([]);
  const edits = replacements.map(([path, replacement]) => {
    const span = spans.get(JSON.stringify(path));
    if (!span) fail(`missing JSON field ${path.join(".")}`);
    return [...span, JSON.stringify(replacement)];
  }).sort((a, b) => b[0] - a[0]);
  for (const [start, end, replacement] of edits) text = text.slice(0, start) + replacement + text.slice(end);
  return text;
}

export function validatePayloads(payloads) {
  if (Object.keys(payloads).sort().join() !== Object.keys(PAYLOAD_HASHES).sort().join()) fail("payload allowlist mismatch");
  for (const [name, hash] of Object.entries(PAYLOAD_HASHES)) {
    if (sha256(payloads[name]) !== hash) fail(`unapproved payload hash: ${name}`);
    utf8(payloads[name]);
  }
  const routing = JSON.parse(utf8(payloads["routing.json"]));
  if (Object.keys(routing).sort().join() !== "description,orchestratorPrompt" ||
      Object.values(routing).some(v => typeof v !== "string" || !v)) fail("invalid routing shape");
  return routing;
}

const legacyAudience = "# Audience and dispatch\n- Default audience: software developer; avoid teaching familiar basics.\n- Dispatch in the recipient's working language with readable sources, constraints and expected output; send only missing context/deltas to continuing sessions. Claude's dedicated routing specifies its transport and output contract.\n- Use document-writer for formal-document wording.\n";
const legacyOracle = "- Tie findings to the inspected version, coverage and limits; include severity, location and evidence/gap. Send purely editorial formal-document issues to document-writer unless meaning changes.";
const legacyRouting = {
  description: "Create, edit and review formal product, technical and management documents; exclude internal agent plans/state.",
  orchestratorPrompt: "Use document-writer for formal documents: MODE: WRITE for creation/body edits; MODE: REVIEW for document review. Reuse a suitable writer for revisions, never to independently review its own output. Keep internal plans/state in the main session; independent platform work goes to lark-operator. Follow the main-session review policy.",
};

export function composeOutputs(current, payloads) {
  const routing = validatePayloads(payloads);
  const out = { ...current };
  const [writerPath, configPath, audiencePath, oraclePath, profilePath] = OUTPUTS;
  if (![PAYLOAD_HASHES["document-writer.md"], "4c636c7c4ba7f27421e0fcaec7150672e09f1ddbe7825c33ab9906a954526502"].includes(sha256(current[writerPath]))) fail("custom writer body");
  out[writerPath] = payloads["document-writer.md"];
  const config = utf8(current[configPath]);
  const writer = JSON.parse(config).agents?.["document-writer"];
  for (const key of Object.keys(routing)) {
    if (writer?.[key] !== legacyRouting[key] && writer?.[key] !== routing[key]) fail(`custom writer ${key}`);
  }
  out[configPath] = Buffer.from(replaceJsonValues(config,
    Object.entries(routing).map(([key, val]) => [["agents", "document-writer", key], val])));
  const audience = utf8(current[audiencePath]);
  const headings = [...audience.matchAll(/^# Audience and dispatch\r?$/gm)];
  if (headings.length !== 1) fail("missing/duplicate Audience heading");
  const start = headings[0].index;
  const next = audience.indexOf("\n# ", start + headings[0][0].length);
  const end = next === -1 ? audience.length : next + 1;
  const section = audience.slice(start, end);
  const approved = utf8(payloads["audience.md"]);
  if (section !== legacyAudience && section !== legacyAudience + "\n" &&
      section !== approved && section !== approved + "\n") fail("custom Audience section");
  // Only the Audience bullets carry the writer mention. Routing is JSON-only.
  const outside = audience.slice(0, start) + audience.slice(end);
  if (outside.includes("document-writer")) fail("duplicate/custom append routing");
  out[audiencePath] = Buffer.from(audience.slice(0, start) + approved +
    (next === -1 ? "" : "\n") + audience.slice(end));
  const oracle = utf8(current[oraclePath]);
  const newLine = utf8(payloads["oracle-line.txt"]).replace(/\n$/, "");
  const lines = oracle.split("\n");
  const slots = lines.flatMap((line, i) => line === legacyOracle || line === newLine ? [i] : []);
  if (slots.length !== 1 || lines.some((line, i) => line.includes("document-writer") && i !== slots[0])) fail("custom/duplicate oracle routing");
  lines[slots[0]] = newLine;
  out[oraclePath] = Buffer.from(lines.join("\n"));
  const profileText = utf8(current[profilePath]);
  const profile = JSON.parse(profileText);
  const changes = [
    [["inputs", "omoConfig", "sha256"], sha256(out[configPath])],
    ...[writerPath, audiencePath, oraclePath].map(path =>
      [["inputs", "omoPromptDir", "files", path.split("/").at(-1)], sha256(out[path])]),
    [["expected", "v2", "agents", "document-writer", "model"], writer.model.split("/").at(-1)],
  ];
  if (profile.expected.v2.agents["document-writer"].systemBytes !== undefined) {
    changes.push([["expected", "v2", "agents", "document-writer", "systemBytes"], out[writerPath].length]);
  }
  out[profilePath] = Buffer.from(replaceJsonValues(profileText, changes));
  return out;
}

export function sourceManifest({ origin, sourceCommit, payloads, outputs }) {
  validatePayloads(payloads);
  return {
    schemaVersion: 1, repository: origin, sourceCommit,
    deployable: sourceCommit !== null,
    status: sourceCommit === null ? "pending reviewed source commit; NOT deployable" : "bound to immutable git objects; activation unverified",
    files: Object.fromEntries(Object.keys(PAYLOAD_HASHES).map(name =>
      [name, { path: SOURCE_PREFIX + name, sha256: sha256(payloads[name]) }])),
    outputs: Object.fromEntries(OUTPUTS.map(path => [path, sha256(outputs[path])])),
  };
}

export function updateWriterRole({ root, sourceRepo, revision, beforeWrite = () => {} }) {
  const profile = JSON.parse(readFileSync(join(root, "runtime/profile.json"), "utf8"));
  if (profile.ownership?.status === "retired") fail(OWNERSHIP_MOVED);
  if (!/^[0-9a-f]{40}$/.test(revision ?? "")) fail("required full immutable 40-hex commit");
  // Git >=2.45: fail closed on unsupported flags. Global flags override
  // inherited environment, suppress replacement refs and implicit promisor IO.
  const git = args => execFileSync("git", ["--no-replace-objects", "--no-lazy-fetch", "-C", sourceRepo, ...args], { maxBuffer: 1024 * 1024 });
  if (utf8(git(["rev-parse", "--verify", `${revision}^{commit}`])).trim() !== revision) fail("not an exact commit");
  const origin = utf8(git(["config", "--get", "remote.origin.url"])).trim();
  if (!origin || /https?:\/\/[^/]*@/i.test(origin)) fail("missing or credential-bearing origin");
  const payloads = {};
  for (const name of Object.keys(PAYLOAD_HASHES)) {
    const path = SOURCE_PREFIX + name;
    const tree = utf8(git(["ls-tree", revision, "--", path])).trim();
    if (!/^100644 blob [0-9a-f]{40}\t/.test(tree) || tree.split("\t")[1] !== path) fail(`non-regular/missing git payload: ${name}`);
    payloads[name] = git(["show", `${revision}:${path}`]);
  }
  validatePayloads(payloads); // before reading any editable output
  const snapshot = join(root, SNAPSHOT);
  if (readdirSync(snapshot).sort().join() !== [...Object.keys(PAYLOAD_HASHES), "SOURCE.json"].sort().join()) fail("snapshot allowlist mismatch");
  const original = new Map();
  const remember = relative => {
    const path = join(root, relative);
    // Reject parent-directory links too: no writes through a linked target.
    if (realpathSync(path) !== path) fail(`symlink target: ${relative}`);
    const bytes = regular(path);
    original.set(relative, bytes);
    return bytes;
  };
  const manifestPath = `${SNAPSHOT}/SOURCE.json`;
  const previous = JSON.parse(utf8(remember(manifestPath)));
  if (previous.schemaVersion !== 1 || previous.repository !== origin ||
      Object.keys(previous.files).sort().join() !== Object.keys(PAYLOAD_HASHES).sort().join() ||
      Object.keys(previous.outputs).sort().join() !== [...OUTPUTS].sort().join()) fail("manifest shape/origin mismatch");
  const oldPayloads = {};
  for (const name of Object.keys(PAYLOAD_HASHES)) {
    const bytes = remember(`${SNAPSHOT}/${name}`);
    if (previous.files[name].path !== SOURCE_PREFIX + name || previous.files[name].sha256 !== sha256(bytes)) fail(`snapshot drift: ${name}`);
    oldPayloads[name] = bytes;
  }
  validatePayloads(oldPayloads);
  const current = Object.fromEntries(OUTPUTS.map(path => {
    const bytes = remember(path);
    if (sha256(bytes) !== previous.outputs[path]) fail(`composed output drift: ${path}`);
    return [path, bytes];
  }));
  const outputs = composeOutputs(current, payloads);
  const manifest = sourceManifest({ origin, sourceCommit: revision, payloads, outputs });
  const writes = new Map([
    ...Object.entries(outputs),
    ...Object.entries(payloads).map(([name, bytes]) => [`${SNAPSHOT}/${name}`, bytes]),
    [manifestPath, Buffer.from(JSON.stringify(manifest, null, 2) + "\n")],
  ]);
  beforeWrite(); // test seam: deterministic race, not a CLI option
  for (const [path, bytes] of original) {
    if (realpathSync(join(root, path)) !== join(root, path) || !regular(join(root, path)).equals(bytes)) fail(`concurrent change: ${path}`);
  }
  const changed = [];
  // Precomputed and rechecked, but deliberately NOT a cross-file transaction.
  // A write failure leaves hash guards fail-closed; operator restores/reviews.
  for (const [path, bytes] of writes) {
    if (!bytes.equals(original.get(path))) {
      writeFileSync(join(root, path), bytes);
      changed.push(path);
    }
  }
  return { changed, sourceCommit: revision };
}

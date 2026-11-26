#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { updateWriterRole } from "../lib/writer-role-update.mjs";

// No fetch, installation, code execution from source, or uncommitted input.
const [sourceRepo, revision, ...extra] = process.argv.slice(2);
if (!sourceRepo || !revision || extra.length) {
  console.error("Usage: node runtime/bin/update-writer-role.mjs <local-source-git-repo> <full-40-hex-commit>");
  process.exitCode = 2;
} else {
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
    console.log(JSON.stringify(updateWriterRole({ root, sourceRepo, revision })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ruleSetting = "hooks.blockedLiteralsFile";
const decoder = new TextDecoder("utf-8", { fatal: true });
const maxBuffer = 16 * 1024 * 1024;
let rules = [];

function redact(text) {
  // Match the original text so replacements cannot hide overlaps or rescan inserted markers.
  const spans = [];
  for (const rule of rules) {
    for (let start = text.indexOf(rule); start !== -1; start = text.indexOf(rule, start + 1)) {
      spans.push([start, start + rule.length]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  let redacted = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    if (start >= cursor) {
      redacted += text.slice(cursor, start) + "[REDACTED]";
    }
    cursor = Math.max(cursor, end);
  }
  return redacted + text.slice(cursor);
}

function fail(message, code = 1) {
  process.stderr.write(redact(`[pre-commit] ${message}\n[pre-commit] FAILED (exit ${code})\n`));
  process.exit(code);
}

function nulPaths(bytes) {
  if (bytes.length === 0) {
    return [];
  }
  if (bytes.at(-1) !== 0) {
    throw new Error("Invalid path list");
  }
  return decoder.decode(bytes.subarray(0, -1)).split("\0");
}

function git(args, input) {
  const result = spawnSync("git", ["--no-pager", "--literal-pathspecs", ...args], {
    input,
    maxBuffer,
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Git grep can return its no-match status even when a staged blob cannot be read.
  if (result.error || result.signal || result.status === null || result.stderr.length) {
    fail(
      `Git could not complete the content guard. Check ${ruleSetting}, the index and repository, then retry.`,
    );
  }
  return result;
}

function scan() {
  if (!rules.length) {
    return;
  }
  // Rename destinations must be scanned even when their bytes are unchanged.
  const changed = git([
    "diff",
    "--cached",
    "--no-renames",
    "--no-relative",
    "--name-only",
    "--diff-filter=AMT",
    "-z",
    "--",
  ]);
  if (changed.status !== 0) {
    fail("Git could not list staged files. Check the index and retry.");
  }
  const paths = nulPaths(changed.stdout);
  const matches = [];
  for (let offset = 0; offset < paths.length;) {
    const batch = [];
    let bytes = 0;
    // Bound both argv count and bytes, leaving room for Git flags and the environment.
    while (offset < paths.length && batch.length < 64) {
      const size = Buffer.byteLength(paths[offset]) + 1;
      if (batch.length && bytes + size > 16 * 1024) {
        break;
      }
      batch.push(paths[offset++]);
      bytes += size;
    }
    const found = git(
      [
        "grep",
        "--cached",
        "--fixed-strings",
        "--no-ignore-case",
        "--text",
        "--files-with-matches",
        "--null",
        "--full-name",
        "--no-color",
        "--no-textconv",
        "--no-recurse-submodules",
        "-f",
        "-",
        "--",
        ...batch,
      ],
      `${rules.join("\n")}\n`,
    );
    if (found.status !== 0 && found.status !== 1) {
      fail("Git could not search staged content. Check the index and retry.");
    }
    if (found.status === 0) {
      matches.push(...nulPaths(found.stdout));
    }
  }
  if (matches.length) {
    process.stderr.write("[pre-commit] Blocked staged content in:\n");
    for (const name of matches) {
      process.stderr.write(`  ${JSON.stringify(redact(name))}\n`);
    }
    fail("Remove the blocked literals from these files and restage them, then retry.");
  }
}

try {
  const configured = git(["config", "--path", "--get", ruleSetting]);
  if (configured.status !== 0 && configured.status !== 1) {
    fail(`Git could not read ${ruleSetting}. Check the Git configuration and retry.`);
  }
  if (configured.status === 0) {
    try {
      const rulePath = decoder.decode(configured.stdout).replace(/\n$/, "");
      rules = decoder
        .decode(readFileSync(rulePath))
        .split(/\r?\n/)
        .filter((line) => line.length > 0);
    } catch {
      fail(
        `Cannot read the private literal file selected by ${ruleSetting} as UTF-8. Set it to a readable file and retry.`,
      );
    }
    if (!rules.length || rules.some((rule) => rule.includes("\0"))) {
      fail(
        `The private literal file selected by ${ruleSetting} is empty or invalid. Use nonempty literal lines without NUL bytes and retry.`,
      );
    }
  }

  // Check before the formatter's sequencer early return or any working-tree restaging.
  scan();
  const formatted = spawnSync("bash", ["scripts/pre-commit/format-staged.sh"], {
    maxBuffer,
    stdio: ["inherit", "pipe", "pipe"],
  });
  process.stdout.write(redact(formatted.stdout?.toString("utf8") ?? ""));
  process.stderr.write(redact(formatted.stderr?.toString("utf8") ?? ""));
  if (formatted.error || formatted.signal || formatted.status === null) {
    fail("Formatter could not complete. Check the formatting helpers and retry.");
  }
  if (formatted.status !== 0) {
    fail("Formatter failed. Fix the reported error and retry.", formatted.status);
  }
  // Formatting may change bytes or stage entirely new paths; enumerate the index again.
  scan();
} catch {
  fail(
    `The staged scan could not complete. Check ${ruleSetting} and repository state, then retry.`,
  );
}

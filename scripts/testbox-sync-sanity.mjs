#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  evaluateLocalTestboxKey,
  evaluateOpenClawTestboxClaim,
  resolveTestboxId,
} from "./blacksmith-testbox-state.mjs";

const DEFAULT_DELETION_THRESHOLD = 200;
const REQUIRED_ROOT_FILES = ["package.json", "pnpm-lock.yaml", ".gitignore"];

function parseBooleanEnv(value) {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function parsePositiveInteger(value, fallback) {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseGitShortStatus(raw) {
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3);
      return {
        line,
        path: rawPath.includes(" -> ") ? (rawPath.split(" -> ").at(-1) ?? rawPath) : rawPath,
        status,
        trackedDeletion: status.includes("D") && status !== "??",
      };
    });
}

export function evaluateTestboxSyncSanity({
  cwd,
  statusRaw,
  exists = fs.existsSync,
  deletionThreshold = DEFAULT_DELETION_THRESHOLD,
  allowMassDeletions = false,
}) {
  const missingRootFiles = REQUIRED_ROOT_FILES.filter((file) => !exists(path.join(cwd, file)));
  const statusEntries = parseGitShortStatus(statusRaw);
  const trackedDeletions = statusEntries.filter((entry) => entry.trackedDeletion);
  const problems = [];

  if (missingRootFiles.length > 0) {
    problems.push(`missing required root files: ${missingRootFiles.join(", ")}`);
  }
  if (!allowMassDeletions && trackedDeletions.length >= deletionThreshold) {
    const examples = trackedDeletions
      .slice(0, 8)
      .map((entry) => entry.path)
      .join(", ");
    problems.push(
      `remote git status has ${trackedDeletions.length} tracked deletions (threshold ${deletionThreshold}); examples: ${examples}`,
    );
  }

  return {
    ok: problems.length === 0,
    missingRootFiles,
    problems,
    statusEntryCount: statusEntries.length,
    trackedDeletionCount: trackedDeletions.length,
  };
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export function runTestboxSyncSanity({
  cwd = process.cwd(),
  env = process.env,
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const root = git(["rev-parse", "--show-toplevel"], cwd).trim();
  const statusRaw = git(["status", "--short", "--untracked-files=all"], root);
  const testboxId = resolveTestboxId({ argv, env });
  const keyResult = evaluateLocalTestboxKey({
    env,
    testboxId,
  });
  const claimResult = evaluateOpenClawTestboxClaim({
    cwd: root,
    env,
    testboxId,
  });
  const result = evaluateTestboxSyncSanity({
    cwd: root,
    statusRaw,
    deletionThreshold: parsePositiveInteger(
      env.OPENCLAW_TESTBOX_DELETION_THRESHOLD,
      DEFAULT_DELETION_THRESHOLD,
    ),
    allowMassDeletions: parseBooleanEnv(env.OPENCLAW_TESTBOX_ALLOW_MASS_DELETIONS),
  });
  result.problems.push(...keyResult.problems);
  result.problems.push(...claimResult.problems);
  result.ok = result.problems.length === 0;

  if (!result.ok) {
    stderr.write(`Testbox sync sanity failed:\n- ${result.problems.join("\n- ")}\n`);
    stderr.write(
      "Warm a fresh box, keep using the id from this session, or rerun from a clean repo root before spending a gate.\n",
    );
    return 1;
  }

  if (keyResult.checked) {
    stdout.write(`Testbox local key and OpenClaw claim ok: ${keyResult.testboxId}\n`);
  }
  stdout.write(
    `Testbox sync sanity ok: ${result.statusEntryCount} changed entries, ${result.trackedDeletionCount} tracked deletions.\n`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = runTestboxSyncSanity();
}

#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const FORWARDED_OPTIONS = new Set([
  "--artifact",
  "--producer-run-id",
  "--producer-run-attempt",
  "--producer-workflow-full-ref",
  "--producer-workflow-sha",
]);

function main() {
  const [rootFlag, root, validatorFlag, validator, policyFlag, policyFile, ...forwarded] =
    process.argv.slice(2);
  if (
    rootFlag !== "--repository-root" ||
    !root ||
    validatorFlag !== "--validator" ||
    !validator ||
    policyFlag !== "--policy" ||
    !policyFile
  ) {
    throw new Error("expected --repository-root <path> --validator <path> --policy <path>");
  }
  const seen = new Set();
  for (let index = 0; index < forwarded.length; index += 2) {
    const option = forwarded[index];
    const value = forwarded[index + 1];
    if (!FORWARDED_OPTIONS.has(option) || seen.has(option) || !value || value.startsWith("--")) {
      throw new Error(`invalid focused evidence verifier option: ${option ?? "<missing>"}`);
    }
    seen.add(option);
  }

  const repositoryRoot = resolve(root);
  const validatorPath = resolve(validator);
  const policyPath = resolve(policyFile);
  if (policyPath !== join(dirname(validatorPath), "authorized-beta-focused-policy.json")) {
    throw new Error("focused evidence policy must be the trusted validator's adjacent policy");
  }
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  if (
    policy === null ||
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    policy.schema !== "openclaw.authorized-beta-focused-policy.v1" ||
    policy.mode !== "authorized-beta-focused-v1" ||
    typeof policy.candidateSha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(policy.candidateSha)
  ) {
    throw new Error("invalid trusted focused evidence policy or candidate SHA");
  }

  const candidateSha = policy.candidateSha;
  const git = (args, options = {}) =>
    execFileSync("git", ["-C", repositoryRoot, ...args], { stdio: "inherit", ...options });
  const hasCandidate = () =>
    spawnSync("git", ["-C", repositoryRoot, "cat-file", "-e", `${candidateSha}^{commit}`], {
      stdio: "ignore",
    }).status === 0;
  if (!hasCandidate()) {
    git(["fetch", "--no-tags", "origin", candidateSha], { timeout: 120_000 });
    if (!hasCandidate()) {
      throw new Error(`trusted focused evidence candidate is unavailable: ${candidateSha}`);
    }
  }

  const directory = mkdtempSync(join(tmpdir(), "authorized-beta-focused-candidate-"));
  const candidateRoot = join(directory, "candidate");
  let worktreeAdded = false;
  try {
    // Verification reads Git objects only; no checkout also prevents candidate checkout hooks.
    git(["worktree", "add", "--detach", "--no-checkout", candidateRoot, candidateSha]);
    worktreeAdded = true;
    execFileSync(
      process.execPath,
      [validatorPath, "verify", "--candidate-root", candidateRoot, ...forwarded],
      { cwd: repositoryRoot, stdio: "inherit" },
    );
  } finally {
    try {
      if (worktreeAdded) {
        git(["worktree", "remove", "--force", candidateRoot]);
      }
    } finally {
      try {
        rmSync(directory, { force: true, recursive: true });
      } finally {
        git(["worktree", "prune", "--expire", "now"]);
      }
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "unknown error");
  console.error("[authorized-beta-focused-candidate] FAILED (exit 1)");
  process.exitCode = 1;
}

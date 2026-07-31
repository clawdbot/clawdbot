// Resolve OpenClaw ref tests cover the release workflow ref resolver script.
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/github/resolve-openclaw-ref.sh";
const tempDirs = createTempDirTracker();
let remoteRepo: string;
let remoteSha: string;

afterAll(() => {
  tempDirs.cleanup();
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRemoteRepo() {
  const repo = tempDirs.make("openclaw-ref-remote-");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test-user"]);
  git(repo, ["config", "user.name", "Test User"]);
  execFileSync("bash", ["-c", "printf seed > seed.txt"], { cwd: repo });
  git(repo, ["add", "seed.txt"]);
  git(repo, ["commit", "-qm", "seed"]);
  const sha = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["branch", "release/test"]);
  git(repo, ["branch", "ambiguous"]);
  git(repo, ["-c", "tag.gpgSign=false", "tag", "v2026.6.21"]);
  git(repo, ["-c", "tag.gpgSign=false", "tag", "ambiguous"]);
  return { repo, sha };
}

beforeAll(() => {
  ({ repo: remoteRepo, sha: remoteSha } = createRemoteRepo());
});

function runResolver(remote: string, args: string[]) {
  return spawnSync("bash", [SCRIPT_PATH, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: "",
      OPENCLAW_REF_REMOTE: remote,
    },
  });
}

function parseOutput(output: string): Record<string, string> {
  return Object.fromEntries(
    output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function expectSuccessfulOutput(result: ReturnType<typeof runResolver>): Record<string, string> {
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return parseOutput(result.stdout);
}

describe("scripts/github/resolve-openclaw-ref.sh", () => {
  it("resolves branch and tag refs with git ls-remote", () => {
    expect(expectSuccessfulOutput(runResolver(remoteRepo, ["--ref", "release/test"]))).toEqual({
      fallback: "false",
      fast: "true",
      ref_kind: "branch",
      sha: remoteSha,
    });
    expect(expectSuccessfulOutput(runResolver(remoteRepo, ["--ref", "v2026.6.21"]))).toEqual({
      fallback: "false",
      fast: "true",
      ref_kind: "tag",
      sha: remoteSha,
    });
  });

  it("accepts full commit SHA refs without remote lookup", () => {
    const result = runResolver(remoteRepo, ["--ref", remoteSha.toUpperCase()]);

    expect(expectSuccessfulOutput(result)).toEqual({
      fallback: "true",
      fast: "false",
      ref_kind: "sha",
      sha: remoteSha,
    });
  });

  it("writes fallback outputs for unresolved refs when a caller supplies an expected SHA", () => {
    const outputPath = join(tempDirs.make("openclaw-ref-output-"), "github-output.txt");
    const result = runResolver(remoteRepo, [
      "--ref",
      "missing-ref",
      "--expected-sha",
      remoteSha,
      "--fallback-ok",
      "--github-output",
      outputPath,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(parseOutput(execFileSync("cat", [outputPath], { encoding: "utf8" }))).toEqual({
      fallback: "true",
      fast: "false",
      ref_kind: "unknown",
      sha: remoteSha,
    });
  });

  it("does not let fallback mode hide remote lookup failures", () => {
    const missingRemote = join(tempDirs.make("openclaw-ref-missing-"), "missing.git");
    const result = runResolver(missingRemote, [
      "--ref",
      "missing-ref",
      "--expected-sha",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "--fallback-ok",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not appear to be a git repository");
    expect(result.stdout).toBe("");
  });

  it("rejects ambiguous branch and tag names before emitting outputs", () => {
    const result = runResolver(remoteRepo, ["--ref", "ambiguous"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Ref resolved ambiguously as both branch and tag: ambiguous");
    expect(result.stdout).toBe("");
  });
});

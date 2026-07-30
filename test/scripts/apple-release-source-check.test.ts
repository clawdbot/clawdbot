import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "apple-release-source-check.sh");
const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";
const tempDirs: string[] = [];

function makeRepository(): { root: string; commit: string } {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-apple-release-source-"));
  tempDirs.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "release-test@openclaw.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "OpenClaw Release Test"], { cwd: root });
  writeFileSync(path.join(root, "tracked.txt"), "clean\n", "utf8");
  execFileSync("git", ["add", "tracked.txt"], { cwd: root });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "initial"], {
    cwd: root,
  });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  return { root, commit };
}

function runCheck(root: string, commit: string) {
  const args = process.platform === "win32" ? [SCRIPT] : ["--noprofile", "--norc", SCRIPT];
  return spawnSync(BASH_BIN, [...args, "--root", root, "--expected-commit", commit], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Apple release source check", () => {
  it("accepts a matching full commit from a clean checkout", () => {
    const repository = makeRepository();
    const result = runCheck(repository.root, repository.commit.toUpperCase());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `Verified Apple release source: commit=${repository.commit} clean=true`,
    );
  });

  it("rejects release metadata from a different commit", () => {
    const repository = makeRepository();
    const mismatch = `${repository.commit[0] === "a" ? "b" : "a"}${repository.commit.slice(1)}`;
    const result = runCheck(repository.root, mismatch);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Apple release commit mismatch: metadata ${mismatch}, checkout ${repository.commit}.`,
    );
  });

  it("rejects tracked, staged, and untracked release checkout changes", () => {
    const fixtures = [
      () => {
        const repository = makeRepository();
        writeFileSync(path.join(repository.root, "tracked.txt"), "dirty\n", "utf8");
        return repository;
      },
      () => {
        const repository = makeRepository();
        writeFileSync(path.join(repository.root, "staged.txt"), "staged\n", "utf8");
        execFileSync("git", ["add", "staged.txt"], { cwd: repository.root });
        return repository;
      },
      () => {
        const repository = makeRepository();
        writeFileSync(path.join(repository.root, "untracked.txt"), "untracked\n", "utf8");
        return repository;
      },
    ];

    for (const makeFixture of fixtures) {
      const repository = makeFixture();
      const result = runCheck(repository.root, repository.commit);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Apple release builds require a clean Git checkout.");
    }
  });
});

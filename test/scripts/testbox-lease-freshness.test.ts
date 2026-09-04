import { execFileSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  prepareTestboxLeaseFreshness,
  recordTestboxLeaseFreshness,
  testboxLeaseStaleReasons,
} from "../../scripts/testbox-lease-freshness.mts";

const fingerprint = {
  version: 1,
  baseSha: "a".repeat(40),
  headSha: "d".repeat(40),
  dependencyDigest: "b".repeat(64),
  environmentDigest: "c".repeat(64),
  workflow: ".github/workflows/ci-check-testbox.yml",
  job: "check",
  ref: "main",
};

describe("Testbox lease freshness", () => {
  it("reuses a lease when hydrated inputs still match", () => {
    expect(testboxLeaseStaleReasons(fingerprint, { ...fingerprint })).toEqual([]);
  });

  it("rejects unknown provenance schemas", () => {
    expect(testboxLeaseStaleReasons({ ...fingerprint, version: 2 }, fingerprint)).toEqual([
      "state schema",
    ]);
  });

  it("records and reuses a lease with more than a buffer of source deletions", () => {
    const fixture = createLeaseFixture();
    const blob = fixture.git(["hash-object", "-w", "--stdin"], "");
    // Index-only files keep this real large-status fixture cheap to create and remove.
    const entries = Array.from(
      { length: 6_000 },
      (_, index) => `100644 ${blob}\t${String(index).padStart(4, "0")}-${"s".repeat(180)}.ts\n`,
    ).join("");
    fixture.git(["update-index", "--index-info"], entries);
    fixture.advanceBase();
    const outputPath = join(fixture.root, "status.txt");
    const output = openSync(outputPath, "w");
    try {
      execFileSync("git", ["-C", fixture.root, "status", "--porcelain=v1"], {
        stdio: ["ignore", output, "pipe"],
      });
    } finally {
      closeSync(output);
    }
    expect(statSync(outputPath).size).toBeGreaterThan(1024 * 1024);

    const prepared = fixture.prepare();
    expect(prepared).not.toBeNull();
    recordTestboxLeaseFreshness(prepared);
    expect(fixture.prepare()).toEqual(prepared);
  });

  it("invalidates saved proof when executable source-sync owners change", () => {
    const fixture = createLeaseFixture();
    mkdirSync(join(fixture.root, "scripts"));
    const owners = [
      "crabbox-wrapper.mjs",
      "crabbox-wrapper.mts",
      "crabbox-source-capsule.mts",
      "crabbox-source-receiver.mts",
    ];
    for (const owner of owners) {
      writeFileSync(join(fixture.root, "scripts", owner), "original\n");
    }
    fixture.git(["add", "scripts"]);
    fixture.advanceBase();
    recordTestboxLeaseFreshness(fixture.prepare());
    writeFileSync(join(fixture.root, "unrelated-source.ts"), "source change\n");
    expect(() => fixture.prepare()).not.toThrow();
    for (const owner of owners) {
      const file = join(fixture.root, "scripts", owner);
      writeFileSync(file, "changed executable owner\n");
      expect(() => fixture.prepare(), owner).toThrow("environmentDigest");
      writeFileSync(file, "original\n");
    }
  });

  it.each(["baseSha", "dependencyDigest", "environmentDigest", "workflow", "job", "ref"])(
    "rejects recorded leases after %s changes",
    (field) => {
      const fixture = createLeaseFixture();
      const prepared = fixture.prepare();
      expect(prepared).not.toBeNull();
      recordTestboxLeaseFreshness(prepared);
      const saved = readFileSync(fixture.statePath, "utf8");
      let args: string[] = [];
      if (field === "baseSha") {
        fixture.advanceBase();
      } else if (field === "dependencyDigest") {
        writeFileSync(join(fixture.root, "package.json"), '{"name":"changed"}\n');
      } else if (field === "environmentDigest") {
        writeFileSync(join(fixture.root, ".node-version"), "26.8.1\n");
      } else {
        args = [`--blacksmith-${field}`, "changed"];
      }
      expect(() => fixture.prepare(args)).toThrow(`is stale (${field})`);
      expect(readFileSync(fixture.statePath, "utf8")).toBe(saved);
    },
  );
});

function createLeaseFixture() {
  const root = mkdtempSync(join(tmpdir(), "openclaw-testbox-freshness-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Lease fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Lease fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (args: string[], input?: string) =>
    execFileSync("git", ["-C", root, ...args], { env, encoding: "utf8", input }).trim();
  git(["init", "--quiet", "--initial-branch=main"]);
  const tree = git(["write-tree"]);
  const initial = git(["commit-tree", tree], "Initial fixture\n");
  git(["update-ref", "HEAD", initial]);
  git(["update-ref", "refs/remotes/origin/main", initial]);
  const stateDir = join(root, "lease-state");
  return {
    root,
    git,
    statePath: join(stateDir, "tbx_fixture.json"),
    advanceBase() {
      const commit = git(["commit-tree", git(["write-tree"]), "-p", "HEAD"], "Advance fixture\n");
      git(["update-ref", "HEAD", commit]);
      git(["update-ref", "refs/remotes/origin/main", commit]);
    },
    prepare(extraArgs: string[] = []) {
      return prepareTestboxLeaseFreshness({
        repoRoot: root,
        provider: "blacksmith-testbox",
        args: ["run", "--id", "tbx_fixture", ...extraArgs],
        env: { VITEST: "1", OPENCLAW_TESTBOX_LEASE_STATE_DIR: stateDir },
      });
    },
  };
}

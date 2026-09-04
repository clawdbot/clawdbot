import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareTestboxLeaseFreshness,
  recordTestboxLeaseFreshness,
  testboxLeaseStaleReasons,
} from "../../scripts/testbox-lease-freshness.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const fingerprint = {
  version: 1,
  baseSha: "a".repeat(40),
  headSha: "d".repeat(40),
  workingTreeClean: true,
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

  it("rotates a lease when base, dependency, or workflow inputs drift", () => {
    expect(
      testboxLeaseStaleReasons(fingerprint, {
        ...fingerprint,
        baseSha: "d".repeat(40),
        dependencyDigest: "e".repeat(64),
        workflow: "other.yml",
      }),
    ).toEqual(["baseSha", "dependencyDigest", "workflow"]);
  });

  it("rejects unknown provenance schemas", () => {
    expect(testboxLeaseStaleReasons({ ...fingerprint, version: 2 }, fingerprint)).toEqual([
      "state schema",
    ]);
  });

  it("invalidates saved proof when executable source-sync owners change", () => {
    const root = tempDirs.make("openclaw-testbox-freshness-");
    mkdirSync(path.join(root, "scripts"));
    const owners = [
      "crabbox-wrapper.mjs",
      "crabbox-wrapper.mts",
      "crabbox-source-capsule.mts",
      "crabbox-source-receiver.mts",
    ];
    for (const owner of owners) {
      writeFileSync(path.join(root, "scripts", owner), "original\n");
    }
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        stdio: "pipe",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
    git(["init", "-q"]);
    git(["add", "scripts"]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ]);
    const prepare = () =>
      prepareTestboxLeaseFreshness({
        args: ["run", "--id", "tbx_fixture"],
        env: { OPENCLAW_TESTBOX_LEASE_STATE_DIR: path.join(root, "proof") },
        provider: "blacksmith-testbox",
        repoRoot: root,
      });
    recordTestboxLeaseFreshness(prepare());
    writeFileSync(path.join(root, "unrelated-source.ts"), "source change\n");
    expect(() => prepare()).not.toThrow();
    for (const owner of owners) {
      const file = path.join(root, "scripts", owner);
      writeFileSync(file, "changed executable owner\n");
      expect(() => prepare(), owner).toThrow("environmentDigest");
      writeFileSync(file, "original\n");
    }
  });
});

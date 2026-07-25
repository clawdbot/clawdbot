// Release prepare tests cover shadow planning, cutover commands, and candidate manifests.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  buildReleasePreparationManifest,
  createReleasePrepareSteps,
  parseReleasePrepareArgs,
  runReleasePrepareStep,
  runReleasePrepareSteps,
} from "../../scripts/release-prepare.ts";

function worktreeState(
  overrides: Partial<{
    changedFiles: string[];
    fingerprint: string;
    head: string;
    packageVersion: string;
    status: string;
  }> = {},
) {
  return {
    changedFiles: [],
    fingerprint: "f".repeat(64),
    head: "a".repeat(40),
    packageVersion: "2026.6.11",
    status: "",
    ...overrides,
  };
}

describe("release preparation arguments", () => {
  it("defaults to non-mutating shadow mode", () => {
    expect(parseReleasePrepareArgs(["--version", "2026.7.2-beta.1"])).toMatchObject({
      android: false,
      jobs: 4,
      mode: "shadow",
      version: "2026.7.2-beta.1",
    });
  });

  it("rejects ambiguous modes and invalid concurrency", () => {
    expect(() => parseReleasePrepareArgs(["--version", "2026.7.2", "--check", "--write"])).toThrow(
      "Use only one mode flag",
    );
    expect(() => parseReleasePrepareArgs(["--version", "2026.7.2", "--jobs", "17"])).toThrow(
      "Expected 1 through 16",
    );
  });
});

describe("release preparation plan", () => {
  it("builds the write cutover from atomic versioning and scoped preflight", () => {
    const steps = createReleasePrepareSteps({
      android: true,
      jobs: 6,
      mode: "write",
      rootDir: "/repo",
      version: "2026.7.2-beta.1",
    });

    expect(expectDefined(steps[0], "release version preparation step").args).toEqual([
      "--import",
      "tsx",
      "scripts/release-version.ts",
      "--root",
      "/repo",
      "--version",
      "2026.7.2-beta.1",
      "--android",
      "--write",
    ]);
    expect(expectDefined(steps[1], "release preflight preparation step").args).toEqual([
      "scripts/release-preflight.mjs",
      "--fix",
      "--scope",
      "version",
      "--jobs",
      "6",
    ]);
  });

  it("does not execute commands in shadow mode", () => {
    const steps = createReleasePrepareSteps({
      android: false,
      jobs: 4,
      mode: "shadow",
      rootDir: "/repo",
      version: "2026.7.2",
    });
    let calls = 0;
    const results = runReleasePrepareSteps({
      cwd: "/repo",
      mode: "shadow",
      runStep: () => {
        calls += 1;
        return 0;
      },
      steps,
    });

    expect(calls).toBe(0);
    expect(results.map((result) => result.status)).toEqual(["planned", "planned"]);
  });

  it("stops after a failed prerequisite and records the blocked step", () => {
    const steps = createReleasePrepareSteps({
      android: false,
      jobs: 4,
      mode: "check",
      rootDir: "/repo",
      version: "2026.7.2",
    });
    const results = runReleasePrepareSteps({
      cwd: "/repo",
      mode: "check",
      runStep: () => 1,
      steps,
    });

    expect(results.map((result) => result.status)).toEqual(["failed", "skipped"]);
  });

  it("keeps JSON mode child output off stdout", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      const status = runReleasePrepareStep(
        {
          args: [
            "-e",
            'process.stdout.write("child stdout\\n"); process.stderr.write("child stderr\\n");',
          ],
          command: process.execPath,
          id: "release-version",
          name: "JSON child",
        },
        process.cwd(),
        { json: true },
      );

      expect(status).toBe(0);
      expect(stdout.join("")).toBe("");
      expect(stderr.join("")).toContain("[release-prepare] JSON child");
      expect(stderr.join("")).toContain("child stdout");
      expect(stderr.join("")).toContain("child stderr");
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});

describe("release preparation manifest", () => {
  it("binds the plan to the exact source and worktree fingerprint", () => {
    const steps = runReleasePrepareSteps({
      cwd: "/repo",
      mode: "shadow",
      steps: createReleasePrepareSteps({
        android: false,
        jobs: 4,
        mode: "shadow",
        rootDir: "/repo",
        version: "2026.7.2",
      }),
    });
    const manifest = buildReleasePreparationManifest({
      after: worktreeState({
        changedFiles: ["package.json"],
        fingerprint: "b".repeat(64),
      }),
      before: worktreeState(),
      mode: "shadow",
      steps,
      version: "2026.7.2",
    });

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      requestedVersion: "2026.7.2",
      mode: "shadow",
      status: "shadow",
      sourceHead: "a".repeat(40),
      candidateFingerprint: "b".repeat(64),
    });
    expect(manifest.steps.map((step) => step.status)).toEqual(["planned", "planned"]);
  });
});

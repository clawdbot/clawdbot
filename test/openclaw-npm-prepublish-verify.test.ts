import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readWorkerDeployTargetPaths } from "../scripts/lib/worker-deploy-target-contract.mts";
import {
  openClawNpmPrepublishVerifyUsage,
  parseOpenClawNpmPrepublishVerifyArgs,
  usesPreparedLocalDependencyInstall,
} from "../scripts/openclaw-npm-prepublish-verify.ts";

describe("parseOpenClawNpmPrepublishVerifyArgs", () => {
  it("supports help, optional versions, and package-manager separators", () => {
    expect(parseOpenClawNpmPrepublishVerifyArgs(["--help"])).toEqual({
      dependencyTarballPaths: [],
      help: true,
      tarballPath: "",
    });
    expect(parseOpenClawNpmPrepublishVerifyArgs(["openclaw.tgz"])).toEqual({
      dependencyTarballPaths: [],
      help: false,
      tarballPath: "openclaw.tgz",
    });
    expect(parseOpenClawNpmPrepublishVerifyArgs(["--", "openclaw.tgz", "2026.3.23"])).toEqual({
      dependencyTarballPaths: [],
      expectedVersion: "2026.3.23",
      help: false,
      tarballPath: "openclaw.tgz",
    });
  });

  it("rejects missing, option-like, and extra arguments before installing", () => {
    expect(() => parseOpenClawNpmPrepublishVerifyArgs([])).toThrow(
      openClawNpmPrepublishVerifyUsage(),
    );
    expect(() => parseOpenClawNpmPrepublishVerifyArgs(["--tag"])).toThrow(
      "Unknown openclaw npm prepublish verifier option: --tag",
    );
    expect(() => parseOpenClawNpmPrepublishVerifyArgs(["openclaw.tgz", "--tag"])).toThrow(
      "Unknown openclaw npm prepublish verifier option: --tag",
    );
    expect(
      parseOpenClawNpmPrepublishVerifyArgs(["openclaw.tgz", "2026.3.23", "llm-core.tgz", "ai.tgz"]),
    ).toEqual({
      dependencyTarballPaths: ["llm-core.tgz", "ai.tgz"],
      expectedVersion: "2026.3.23",
      help: false,
      tarballPath: "openclaw.tgz",
    });
    expect(() =>
      parseOpenClawNpmPrepublishVerifyArgs(["openclaw.tgz", "2026.3.23", "--bad"]),
    ).toThrow("Invalid dependency tarball path: --bad");
  });
});

describe("usesPreparedLocalDependencyInstall", () => {
  it("uses the prepared local project only for the single AI tarball release path", () => {
    expect(usesPreparedLocalDependencyInstall(0)).toBe(false);
    expect(usesPreparedLocalDependencyInstall(1)).toBe(true);
    expect(usesPreparedLocalDependencyInstall(2)).toBe(false);
  });
});

describe("readWorkerDeployTargetPaths", () => {
  it.each([
    ["historical", ""],
    [
      "modern",
      'export const WORKER_BUNDLE_GITHUB_EXEC_LAUNCHER_PATH = "github-exec-launcher.mjs";\n',
    ],
  ])("reads the %s target contract without executing it", (_, extraDeclaration) => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-worker-target-"));
    try {
      const sourceDir = join(root, "src/shared");
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(
        join(sourceDir, "worker-bundle-hash.ts"),
        'export const WORKER_BUNDLE_ENTRY_PATH = "worker.mjs";\n' +
          'export const WORKER_BUNDLE_RSYNC_RECEIVER_PATH = "workspace-rsync-receiver.mjs";\n' +
          extraDeclaration +
          'throw new Error("must not execute target source");\n',
      );
      expect(readWorkerDeployTargetPaths(root)).toEqual(
        [
          "dist/worker/worker.mjs",
          "dist/worker/workspace-rsync-receiver.mjs",
          ...(extraDeclaration ? ["dist/worker/github-exec-launcher.mjs"] : []),
        ].toSorted(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "unsafe basenames",
      'export const WORKER_BUNDLE_ENTRY_PATH = "../worker.mjs";\n' +
        'export const WORKER_BUNDLE_RSYNC_RECEIVER_PATH = "workspace-rsync-receiver.mjs";\n',
      "Target worker artifact declaration is invalid: WORKER_BUNDLE_ENTRY_PATH.",
    ],
    [
      "duplicate basenames",
      'export const WORKER_BUNDLE_ENTRY_PATH = "worker.mjs";\n' +
        'export const WORKER_BUNDLE_RSYNC_RECEIVER_PATH = "worker.mjs";\n',
      "Target worker artifact declaration is invalid: WORKER_BUNDLE_RSYNC_RECEIVER_PATH.",
    ],
    [
      "unbounded declarations",
      Array.from(
        { length: 17 },
        (_, index) => `export const WORKER_BUNDLE_${index}_PATH = "worker-${index}.mjs";`,
      ).join("\n"),
      "Target worker artifact count must be between 2 and 16.",
    ],
  ])("rejects %s", (_, source, expectedError) => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-worker-target-invalid-"));
    try {
      const sourceDir = join(root, "src/shared");
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(join(sourceDir, "worker-bundle-hash.ts"), source);
      expect(() => readWorkerDeployTargetPaths(root)).toThrow(expectedError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

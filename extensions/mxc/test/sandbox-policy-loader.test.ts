import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  loadSandboxBaselinePolicy,
  MAX_SANDBOX_POLICY_FILE_BYTES,
} from "../src/sandbox-policy-loader.js";

const describeOnWindows = describe.runIf(process.platform === "win32");

const testDirs: string[] = [];

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function makeTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-mxc-policy-"));
  testDirs.push(dir);
  return dir;
}

function makeExistingDir(rootDir: string, name: string): string {
  const dir = join(rootDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writePolicy(path: string, policy: unknown): void {
  writeFileSync(path, `${JSON.stringify(policy)}\n`, "utf-8");
}

function expectPolicyFileFailure(policyPath: string, action: () => unknown, detail: string): void {
  try {
    action();
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(policyPath);
    expect((err as Error).message).toContain(detail);
    return;
  }
  throw new Error("Expected policy loader failure.");
}

describeOnWindows("loadSandboxBaselinePolicy", () => {
  test("resolves no configured policy files with the default baseline", () => {
    const policy = loadSandboxBaselinePolicy();

    expect(policy.filesystem.restrictToProjectDir).toBe(true);
    expect(policy.filesystem.additionalReadonlyPaths).toEqual([]);
    expect(policy.filesystem.additionalReadwritePaths).toEqual([]);
    expect(policy.process.timeoutSeconds).toBe(300);
    expect(policy.process.timeoutSecondsConfigured).toBe(false);
    expect(policy.configuredPaths.readonlyPaths).toEqual([]);
    expect(policy.configuredPaths.readwritePaths).toEqual([]);
  });

  test("fails closed when a configured policy file is missing", () => {
    const missingPolicyPath = join(makeTestDir(), "missing-policy.json");

    expect(() => loadSandboxBaselinePolicy({ policyPaths: [missingPolicyPath] })).toThrow(
      /does not exist/u,
    );
  });

  test("layers configured policy files in deterministic array order", () => {
    const dir = makeTestDir();
    const firstPolicyPath = join(dir, "first-policy.json");
    const secondPolicyPath = join(dir, "second-policy.json");
    const firstReadonlyPath = makeExistingDir(dir, "readonly-first");
    const secondReadonlyPath = makeExistingDir(dir, "readonly-second");
    const firstReadwritePath = makeExistingDir(dir, "readwrite-first");
    const sharedReadwritePath = makeExistingDir(dir, "readwrite-shared");
    const secondReadwritePath = makeExistingDir(dir, "readwrite-second");

    writePolicy(firstPolicyPath, {
      filesystem: {
        additionalReadonlyPaths: [`  ${firstReadonlyPath}  `],
        additionalReadwritePaths: [firstReadwritePath, sharedReadwritePath],
      },
      process: {
        timeoutSeconds: 90,
      },
    });
    writePolicy(secondPolicyPath, {
      filesystem: {
        additionalReadonlyPaths: [secondReadonlyPath],
        additionalReadwritePaths: [secondReadwritePath, sharedReadwritePath],
      },
      process: {
        timeoutSeconds: 120,
      },
    });

    const policy = loadSandboxBaselinePolicy({ policyPaths: [firstPolicyPath, secondPolicyPath] });

    expect(policy.filesystem.additionalReadonlyPaths).toEqual([
      firstReadonlyPath,
      secondReadonlyPath,
    ]);
    expect(policy.filesystem.additionalReadwritePaths).toEqual([
      firstReadwritePath,
      sharedReadwritePath,
      secondReadwritePath,
    ]);
    expect(policy.configuredPaths.readwritePaths).toEqual([
      {
        path: firstReadwritePath,
        sources: [`${firstPolicyPath}.filesystem.additionalReadwritePaths[0]`],
      },
      {
        path: sharedReadwritePath,
        sources: [
          `${firstPolicyPath}.filesystem.additionalReadwritePaths[1]`,
          `${secondPolicyPath}.filesystem.additionalReadwritePaths[1]`,
        ],
      },
      {
        path: secondReadwritePath,
        sources: [`${secondPolicyPath}.filesystem.additionalReadwritePaths[0]`],
      },
    ]);
    expect(policy.process.timeoutSeconds).toBe(90);
    expect(policy.process.timeoutSecondsConfigured).toBe(true);
  });

  test("hardening booleans can only remain restrictive", () => {
    const dir = makeTestDir();
    const policyPath = join(dir, "policy.json");
    writePolicy(policyPath, {
      filesystem: {
        restrictToProjectDir: false,
      },
    });

    expect(() => loadSandboxBaselinePolicy({ policyPaths: [policyPath] })).toThrow(
      /restrictToProjectDir/u,
    );
  });
});

describeOnWindows("loadSandboxBaselinePolicy validation", () => {
  test("fails closed for blank read-only paths", () => {
    const dir = makeTestDir();
    const policyPath = join(dir, "blank-path.json");
    writePolicy(policyPath, {
      filesystem: {
        additionalReadonlyPaths: ["   "],
      },
    });

    expectPolicyFileFailure(
      policyPath,
      () => loadSandboxBaselinePolicy({ policyPaths: [policyPath] }),
      "must not be blank",
    );
  });

  test("fails closed for relative read-write paths", () => {
    const dir = makeTestDir();
    const policyPath = join(dir, "relative-path.json");
    writePolicy(policyPath, {
      filesystem: {
        additionalReadwritePaths: ["relative\\path"],
      },
    });

    expectPolicyFileFailure(
      policyPath,
      () => loadSandboxBaselinePolicy({ policyPaths: [policyPath] }),
      "absolute Windows path",
    );
  });

  test("fails closed for nonexistent read-only paths", () => {
    const dir = makeTestDir();
    const policyPath = join(dir, "missing-path.json");
    writePolicy(policyPath, {
      filesystem: {
        additionalReadonlyPaths: [join(dir, "missing-readonly")],
      },
    });

    expectPolicyFileFailure(
      policyPath,
      () => loadSandboxBaselinePolicy({ policyPaths: [policyPath] }),
      "does not exist on the host",
    );
  });

  test("fails closed with path-inclusive errors for malformed existing files", () => {
    const dir = makeTestDir();
    const cases: ReadonlyArray<{
      name: string;
      content: string;
      detail: string;
    }> = [
      {
        name: "invalid-json.json",
        content: "{",
        detail: "Failed to load sandbox policy file at",
      },
      {
        name: "array.json",
        content: "[]",
        detail: "must be a JSON object",
      },
      {
        name: "unknown-key.json",
        content: JSON.stringify({ network: { additionalDeniedHosts: ["metadata"] } }),
        detail: "is not supported",
      },
    ];

    for (const item of cases) {
      const policyPath = join(dir, item.name);
      writeFileSync(policyPath, item.content, "utf-8");

      expectPolicyFileFailure(
        policyPath,
        () => loadSandboxBaselinePolicy({ policyPaths: [policyPath] }),
        item.detail,
      );
    }
  });
});

describe("sandbox policy bounded reads", () => {
  test("small valid policy file loads successfully", () => {
    const dir = makeTestDir();
    const policyPath = join(dir, "normal-policy.json");
    writePolicy(policyPath, {
      filesystem: { additionalReadonlyPaths: [] },
      process: { timeoutSeconds: 60 },
    });

    const policy = loadSandboxBaselinePolicy({ policyPaths: [policyPath] });

    expect(policy.process.timeoutSeconds).toBe(60);
  });

  test("loads a configured policy through a symlink", () => {
    const dir = makeTestDir();
    const targetPath = join(dir, "target-policy.json");
    const policyPath = join(dir, "linked-policy.json");
    writePolicy(targetPath, { process: { timeoutSeconds: 45 } });
    symlinkSync(targetPath, policyPath, "file");

    const policy = loadSandboxBaselinePolicy({ policyPaths: [policyPath] });

    expect(policy.process.timeoutSeconds).toBe(45);
  });

  test("accepts a policy file at the inclusive size limit", () => {
    const dir = makeTestDir();
    const policyPath = join(dir, "boundary-policy.json");
    const policyJson = JSON.stringify({ process: { timeoutSeconds: 45 } });
    writeFileSync(
      policyPath,
      policyJson + " ".repeat(MAX_SANDBOX_POLICY_FILE_BYTES - Buffer.byteLength(policyJson)),
      "utf-8",
    );

    const policy = loadSandboxBaselinePolicy({ policyPaths: [policyPath] });

    expect(policy.process.timeoutSeconds).toBe(45);
  });

  test("oversized policy file is rejected with the documented size limit", () => {
    const dir = makeTestDir();
    const policyPath = join(dir, "huge-policy.json");
    writeFileSync(policyPath, "x".repeat(MAX_SANDBOX_POLICY_FILE_BYTES + 1), "utf-8");

    expect(() => loadSandboxBaselinePolicy({ policyPaths: [policyPath] })).toThrow(
      `Configured sandbox policy file ${policyPath} exceeds the maximum policy file size of ${MAX_SANDBOX_POLICY_FILE_BYTES} bytes (${MAX_SANDBOX_POLICY_FILE_BYTES / (1024 * 1024)} MiB). Reduce the file to 1 MiB or less or remove it from mxcPolicyPaths.`,
    );
  });
});

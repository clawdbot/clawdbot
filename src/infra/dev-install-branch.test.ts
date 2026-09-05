import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { runCommandWithTimeout } from "../process/exec.js";

type RunCommand = typeof runCommandWithTimeout;

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let root: string;

beforeAll(() => {
  root = tempDirs.make("openclaw-dev-branch-");
});

function makeRunCommand(byArg: {
  toplevel?: { code: number; stdout: string };
  branch?: { code: number; stdout: string };
}): RunCommand {
  return async (argv: string[]) => {
    const key = argv.includes("--show-toplevel") ? "toplevel" : "branch";
    const res = byArg[key];
    if (!res) {
      throw new Error(`unexpected git invocation: ${argv.join(" ")}`);
    }
    return {
      stdout: res.stdout,
      stderr: "",
      code: res.code,
      signal: null,
      killed: false,
      termination: "exit" as const,
    };
  };
}

async function resolveBranch(params: {
  root: string | null;
  runCommand: RunCommand;
}): Promise<string | null> {
  vi.doMock("../process/exec.js", () => ({ runCommandWithTimeout: params.runCommand }));
  vi.doMock("./openclaw-root.js", () => ({
    resolveOpenClawPackageRoot: vi.fn(async () => params.root),
  }));
  const { resolveDevInstallGitBranch } = await import("./dev-install-branch.js");
  return await resolveDevInstallGitBranch();
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../process/exec.js");
  vi.doUnmock("./openclaw-root.js");
});

describe("resolveDevInstallGitBranch", () => {
  it("returns the branch for a source checkout on a feature branch", async () => {
    const branch = await resolveBranch({
      root,
      runCommand: makeRunCommand({
        toplevel: { code: 0, stdout: `${root}\n` },
        branch: { code: 0, stdout: "feat/dev-branch-badge\n" },
      }),
    });
    expect(branch).toBe("feat/dev-branch-badge");
  });

  it("returns null without a package root", async () => {
    const branch = await resolveBranch({ root: null, runCommand: makeRunCommand({}) });
    expect(branch).toBeNull();
  });

  it("returns null when the root is not inside a git repo", async () => {
    const branch = await resolveBranch({
      root,
      runCommand: makeRunCommand({ toplevel: { code: 128, stdout: "" } }),
    });
    expect(branch).toBeNull();
  });

  it("returns null when the package root is nested inside an unrelated repo", async () => {
    const nested = path.join(root, "node_modules", "openclaw");
    await fs.mkdir(nested, { recursive: true });
    const branch = await resolveBranch({
      root: nested,
      runCommand: makeRunCommand({
        toplevel: { code: 0, stdout: `${root}\n` },
        branch: { code: 0, stdout: "some-branch\n" },
      }),
    });
    expect(branch).toBeNull();
  });

  it.each(["main", "master", "HEAD", ""])("hides mainline/detached state %j", async (name) => {
    const branch = await resolveBranch({
      root,
      runCommand: makeRunCommand({
        toplevel: { code: 0, stdout: `${root}\n` },
        branch: { code: 0, stdout: `${name}\n` },
      }),
    });
    expect(branch).toBeNull();
  });

  it("returns null when git branch resolution fails", async () => {
    const branch = await resolveBranch({
      root,
      runCommand: makeRunCommand({
        toplevel: { code: 0, stdout: `${root}\n` },
        branch: { code: 128, stdout: "" },
      }),
    });
    expect(branch).toBeNull();
  });
});

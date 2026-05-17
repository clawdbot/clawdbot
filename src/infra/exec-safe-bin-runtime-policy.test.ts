import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  isInterpreterLikeSafeBin,
  listInterpreterLikeSafeBins,
  resolveExecSafeBinRuntimePolicy,
  resolveMergedSafeBinProfileFixtures,
} from "./exec-safe-bin-runtime-policy.js";
import { isTrustedSafeBinPath } from "./exec-safe-bin-trust.js";

describe("exec safe-bin runtime policy", () => {
  const interpreterCases: Array<{ bin: string; expected: boolean }> = [
    { bin: "python3", expected: true },
    { bin: "python3.12", expected: true },
    { bin: " C:\\Tools\\Python3.EXE ", expected: true },
    { bin: "node", expected: true },
    { bin: "node20", expected: true },
    { bin: "/usr/local/bin/node20", expected: true },
    { bin: "awk", expected: true },
    { bin: "/opt/homebrew/bin/gawk", expected: true },
    { bin: "mawk", expected: true },
    { bin: "nawk", expected: true },
    { bin: "sed", expected: true },
    { bin: "gsed", expected: true },
    { bin: "ruby3.2", expected: true },
    { bin: "bash", expected: true },
    { bin: "busybox", expected: true },
    { bin: "toybox", expected: true },
    { bin: "myfilter", expected: false },
    { bin: "jq", expected: false },
  ];

  for (const testCase of interpreterCases) {
    it(`classifies interpreter-like safe bin '${testCase.bin}'`, () => {
      expect(isInterpreterLikeSafeBin(testCase.bin)).toBe(testCase.expected);
    });
  }

  it("lists interpreter-like bins from a mixed set", () => {
    expect(
      listInterpreterLikeSafeBins([
        "jq",
        " C:\\Tools\\Python3.EXE ",
        "myfilter",
        "busybox",
        "toybox",
        "/usr/bin/node",
        "/opt/homebrew/bin/gawk",
      ]),
    ).toEqual(["busybox", "gawk", "node", "python3", "toybox"]);
  });

  it("merges and normalizes safe-bin profile fixtures", () => {
    const merged = resolveMergedSafeBinProfileFixtures({
      global: {
        safeBinProfiles: {
          " MyFilter ": {
            deniedFlags: ["--file", " --file ", ""],
          },
        },
      },
      local: {
        safeBinProfiles: {
          myfilter: {
            maxPositional: 0,
          },
        },
      },
    });
    expect(merged).toEqual({
      myfilter: {
        maxPositional: 0,
      },
    });
  });

  it("computes unprofiled interpreter entries separately from custom profiled bins", () => {
    const policy = resolveExecSafeBinRuntimePolicy({
      local: {
        safeBins: ["python3", "myfilter"],
        safeBinProfiles: {
          myfilter: { maxPositional: 0 },
        },
      },
    });

    expect(policy.safeBins.has("python3")).toBe(true);
    expect(policy.safeBins.has("myfilter")).toBe(true);
    expect(policy.unprofiledSafeBins).toEqual(["python3"]);
    expect(policy.unprofiledInterpreterSafeBins).toEqual(["python3"]);
  });

  it("prefers local safe bins over global ones when both are configured", () => {
    const policy = resolveExecSafeBinRuntimePolicy({
      global: {
        safeBins: ["python3", "jq"],
      },
      local: {
        safeBins: ["sort"],
      },
    });

    expect([...policy.safeBins]).toEqual(["sort"]);
  });

  it("merges explicit safe-bin trusted dirs from global and local config", () => {
    const customDir = path.join(path.sep, "custom", "bin");
    const agentDir = path.join(path.sep, "agent", "bin");
    const policy = resolveExecSafeBinRuntimePolicy({
      global: {
        safeBinTrustedDirs: [` ${customDir} `, customDir],
      },
      local: {
        safeBinTrustedDirs: [agentDir],
      },
    });

    expect(policy.trustedSafeBinDirs.has(path.resolve(customDir))).toBe(true);
    expect(policy.trustedSafeBinDirs.has(path.resolve(agentDir))).toBe(true);
  });

  it("does not trust package-manager bin dirs unless explicitly configured", () => {
    const defaultPolicy = resolveExecSafeBinRuntimePolicy({});
    expect(defaultPolicy.trustedSafeBinDirs.has(path.resolve("/opt/homebrew/bin"))).toBe(false);
    expect(defaultPolicy.trustedSafeBinDirs.has(path.resolve("/usr/local/bin"))).toBe(false);

    const optedIn = resolveExecSafeBinRuntimePolicy({
      global: {
        safeBinTrustedDirs: ["/opt/homebrew/bin", "/usr/local/bin"],
      },
    });
    expect(optedIn.trustedSafeBinDirs.has(path.resolve("/opt/homebrew/bin"))).toBe(true);
    expect(optedIn.trustedSafeBinDirs.has(path.resolve("/usr/local/bin"))).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "expands trusted package-manager symlink dirs to current safe-bin target dirs",
    async () => {
      await withTempDir({ prefix: "openclaw-safe-bin-trusted-symlink-" }, async (root) => {
        const trustedDir = path.join(root, "bin");
        const targetDir = path.join(root, "cellar", "jq", "1.7.1", "bin");
        const target = path.join(targetDir, "jq");
        const link = path.join(trustedDir, "jq");
        await fs.mkdir(trustedDir, { recursive: true });
        await fs.mkdir(targetDir, { recursive: true });
        await fs.writeFile(target, "#!/bin/sh\n", "utf8");
        await fs.chmod(target, 0o755);
        await fs.symlink(target, link);

        const policy = resolveExecSafeBinRuntimePolicy({
          local: {
            safeBins: ["jq"],
            safeBinTrustedDirs: [trustedDir],
          },
        });

        expect(
          isTrustedSafeBinPath({
            resolvedPath: await fs.realpath(target),
            trustedDirs: policy.trustedSafeBinDirs,
          }),
        ).toBe(true);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "refreshes trusted package-manager target dirs when safe-bin symlinks retarget",
    async () => {
      await withTempDir({ prefix: "openclaw-safe-bin-trusted-retarget-" }, async (root) => {
        const trustedDir = path.join(root, "bin");
        const targetDir1 = path.join(root, "cellar", "jq", "1.7.1", "bin");
        const targetDir2 = path.join(root, "cellar", "jq", "1.8.0", "bin");
        const target1 = path.join(targetDir1, "jq");
        const target2 = path.join(targetDir2, "jq");
        const link = path.join(trustedDir, "jq");
        await fs.mkdir(trustedDir, { recursive: true });
        await fs.mkdir(targetDir1, { recursive: true });
        await fs.mkdir(targetDir2, { recursive: true });
        await fs.writeFile(target1, "#!/bin/sh\n", "utf8");
        await fs.writeFile(target2, "#!/bin/sh\n", "utf8");
        await fs.chmod(target1, 0o755);
        await fs.chmod(target2, 0o755);
        await fs.symlink(target1, link);

        const first = resolveExecSafeBinRuntimePolicy({
          local: {
            safeBins: ["jq"],
            safeBinTrustedDirs: [trustedDir],
          },
        });
        const realTarget1 = await fs.realpath(target1);
        expect(
          isTrustedSafeBinPath({
            resolvedPath: realTarget1,
            trustedDirs: first.trustedSafeBinDirs,
          }),
        ).toBe(true);

        await fs.unlink(link);
        await fs.symlink(target2, link);

        const second = resolveExecSafeBinRuntimePolicy({
          local: {
            safeBins: ["jq"],
            safeBinTrustedDirs: [trustedDir],
          },
        });
        const realTarget2 = await fs.realpath(target2);
        expect(
          isTrustedSafeBinPath({
            resolvedPath: realTarget1,
            trustedDirs: second.trustedSafeBinDirs,
          }),
        ).toBe(false);
        expect(
          isTrustedSafeBinPath({
            resolvedPath: realTarget2,
            trustedDirs: second.trustedSafeBinDirs,
          }),
        ).toBe(true);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not derive target-dir trust from non-executable safe-bin links",
    async () => {
      await withTempDir({ prefix: "openclaw-safe-bin-trusted-nonexec-" }, async (root) => {
        const trustedDir = path.join(root, "bin");
        const nonExecutableDir = path.join(root, "targets", "nonexec");
        const directoryTarget = path.join(root, "targets", "directory");
        const executableDir = path.join(root, "targets", "executable");
        const nonExecutable = path.join(nonExecutableDir, "placeholder");
        const executableInNonExecutableDir = path.join(nonExecutableDir, "jq");
        const executableInDirectoryParent = path.join(root, "targets", "curl");
        const executable = path.join(executableDir, "jq");
        const nonExecutableLink = path.join(trustedDir, "jq");
        const directoryLink = path.join(trustedDir, "curl");

        await fs.mkdir(trustedDir, { recursive: true });
        await fs.mkdir(nonExecutableDir, { recursive: true });
        await fs.mkdir(directoryTarget, { recursive: true });
        await fs.mkdir(executableDir, { recursive: true });
        await fs.writeFile(nonExecutable, "#!/bin/sh\n", "utf8");
        await fs.chmod(nonExecutable, 0o644);
        await fs.writeFile(executableInNonExecutableDir, "#!/bin/sh\n", "utf8");
        await fs.chmod(executableInNonExecutableDir, 0o755);
        await fs.writeFile(executableInDirectoryParent, "#!/bin/sh\n", "utf8");
        await fs.chmod(executableInDirectoryParent, 0o755);
        await fs.writeFile(executable, "#!/bin/sh\n", "utf8");
        await fs.chmod(executable, 0o755);
        await fs.symlink(nonExecutable, nonExecutableLink);
        await fs.symlink(directoryTarget, directoryLink);

        const policy = resolveExecSafeBinRuntimePolicy({
          local: {
            safeBins: ["jq", "curl"],
            safeBinTrustedDirs: [trustedDir],
          },
        });

        expect(
          isTrustedSafeBinPath({
            resolvedPath: await fs.realpath(executable),
            trustedDirs: policy.trustedSafeBinDirs,
          }),
        ).toBe(false);
        expect(
          isTrustedSafeBinPath({
            resolvedPath: await fs.realpath(executableInNonExecutableDir),
            trustedDirs: policy.trustedSafeBinDirs,
          }),
        ).toBe(false);
        expect(
          isTrustedSafeBinPath({
            resolvedPath: await fs.realpath(executableInDirectoryParent),
            trustedDirs: policy.trustedSafeBinDirs,
          }),
        ).toBe(false);
      });
    },
  );

  it("emits runtime warning when explicitly trusted dir is writable", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withTempDir({ prefix: "openclaw-safe-bin-runtime-" }, async (dir) => {
      try {
        await fs.chmod(dir, 0o777);
        const onWarning = vi.fn();
        const policy = resolveExecSafeBinRuntimePolicy({
          global: {
            safeBinTrustedDirs: [dir],
          },
          onWarning,
        });

        expect(policy.writableTrustedSafeBinDirs).toEqual([
          {
            dir: path.resolve(dir),
            groupWritable: true,
            worldWritable: true,
          },
        ]);
        expect(onWarning).toHaveBeenCalledExactlyOnceWith(
          `exec: safeBinTrustedDirs includes world-writable directory '${path.resolve(dir)}'; remove trust or tighten permissions (for example chmod 755).`,
        );
      } finally {
        await fs.chmod(dir, 0o755).catch(() => undefined);
      }
    });
  });
});

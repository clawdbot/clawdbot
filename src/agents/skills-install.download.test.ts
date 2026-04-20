import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installDownloadSpec } from "./skills-install-download.js";
import { setTempStateDir } from "./skills-install.download-test-utils.js";
import {
  fetchWithSsrFGuardMock,
  hasBinaryMock,
  runCommandWithTimeoutMock,
} from "./skills-install.test-mocks.js";
import { createCanonicalFixtureSkill } from "./skills.test-helpers.js";
import { resolveSkillToolsRootDir } from "./skills/tools-dir.js";
import type { SkillEntry, SkillInstallSpec } from "./skills/types.js";

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
}));

// Download tests cover installer path handling; fs-safe has dedicated pinned-helper coverage.
vi.mock("../infra/fs-pinned-write-helper.js", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { pipeline } = await import("node:stream/promises");
  return {
    runPinnedWriteHelper: async (params: {
      rootPath: string;
      relativeParentPath: string;
      basename: string;
      mkdir: boolean;
      mode: number;
      input:
        | { kind: "buffer"; data: string | Buffer; encoding?: BufferEncoding }
        | { kind: "stream"; stream: NodeJS.ReadableStream };
    }) => {
      const parentPath = params.relativeParentPath
        ? path.join(params.rootPath, ...params.relativeParentPath.split("/"))
        : params.rootPath;
      if (params.mkdir) {
        await fs.mkdir(parentPath, { recursive: true });
      }
      const targetPath = path.join(parentPath, params.basename);
      if (params.input.kind === "buffer") {
        await fs.writeFile(targetPath, params.input.data, {
          encoding: params.input.encoding,
          mode: params.mode,
        });
      } else {
        const handle = await fs.open(targetPath, "w", params.mode);
        try {
          await pipeline(params.input.stream, handle.createWriteStream());
        } finally {
          await handle.close().catch(() => undefined);
        }
      }
      const stat = await fs.stat(targetPath);
      return { dev: stat.dev, ino: stat.ino };
    },
  };
});

vi.mock("./skills.js", () => ({
  hasBinary: (bin: string) => hasBinaryMock(bin),
}));

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildEntry(name: string): SkillEntry {
  const skillDir = path.join(workspaceDir, "skills", name);
  const filePath = path.join(skillDir, "SKILL.md");
  return {
    skill: createFixtureSkill({
      name,
      description: `${name} test skill`,
      filePath,
      baseDir: skillDir,
      source: "openclaw-workspace",
    }),
    frontmatter: {},
  };
}

function createFixtureSkill(params: {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
}): SkillEntry["skill"] {
  return createCanonicalFixtureSkill(params);
}

function buildDownloadSpec(params: {
  url: string;
  archive: "tar.gz" | "tar.bz2" | "zip";
  targetDir: string;
  stripComponents?: number;
}): SkillInstallSpec {
  return {
    kind: "download",
    id: "dl",
    url: params.url,
    archive: params.archive,
    extract: true,
    targetDir: params.targetDir,
    ...(typeof params.stripComponents === "number"
      ? { stripComponents: params.stripComponents }
      : {}),
  };
}

async function installDownloadSkill(params: {
  name: string;
  url: string;
  archive: "tar.gz" | "tar.bz2" | "zip";
  targetDir: string;
  stripComponents?: number;
}) {
  return installDownloadSpec({
    entry: buildEntry(params.name),
    spec: buildDownloadSpec(params),
    timeoutMs: 30_000,
  });
}

function mockArchiveResponse(buffer: Uint8Array): void {
  fetchWithSsrFGuardMock.mockResolvedValue({
    response: {
      ok: true,
      status: 200,
      statusText: "OK",
      body: Readable.from([Buffer.from(buffer)]),
    },
    release: async () => undefined,
  });
}

function runCommandResult(params?: Partial<Record<"code" | "stdout" | "stderr", string | number>>) {
  return {
    code: 0,
    stdout: "",
    stderr: "",
    signal: null,
    killed: false,
    ...params,
  };
}

function mockTarExtractionFlow(params: {
  listOutput: string;
  verboseListOutput: string;
  extract: "ok" | "reject";
}) {
  runCommandWithTimeoutMock.mockImplementation(async (...argv: unknown[]) => {
    const cmd = (argv[0] ?? []) as string[];
    if (cmd[0] === "tar" && cmd[1] === "tf") {
      return runCommandResult({ stdout: params.listOutput });
    }
    if (cmd[0] === "tar" && cmd[1] === "tvf") {
      return runCommandResult({ stdout: params.verboseListOutput });
    }
    if (cmd[0] === "tar" && cmd[1] === "xf") {
      if (params.extract === "reject") {
        throw new Error("should not extract");
      }
      return runCommandResult({ stdout: "ok" });
    }
    return runCommandResult();
  });
}

let workspaceDir = "";
let stateDir = "";

beforeAll(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-install-"));
  stateDir = setTempStateDir(workspaceDir);
});

afterAll(async () => {
  if (workspaceDir) {
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    workspaceDir = "";
    stateDir = "";
  }
});

beforeEach(() => {
  runCommandWithTimeoutMock.mockReset();
  runCommandWithTimeoutMock.mockResolvedValue(runCommandResult());
  fetchWithSsrFGuardMock.mockReset();
  hasBinaryMock.mockReset();
  hasBinaryMock.mockReturnValue(true);
});

describe("installDownloadSpec extraction safety", () => {
  it("rejects targetDir escapes outside the per-skill tools root", async () => {
    const beforeFetchCalls = fetchWithSsrFGuardMock.mock.calls.length;

    const result = await installDownloadSkill({
      name: "relative-traversal",
      url: "https://example.invalid/good.zip",
      archive: "zip",
      targetDir: "../outside",
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Refusing to install outside the skill tools directory");
    expect(fetchWithSsrFGuardMock.mock.calls.length).toBe(beforeFetchCalls);
    expect(stateDir.length).toBeGreaterThan(0);
  });

  it("allows relative targetDir inside the per-skill tools root", async () => {
    mockArchiveResponse(new TextEncoder().encode("payload"));
    const entry = buildEntry("relative-targetdir");

    const result = await installDownloadSpec({
      entry,
      spec: {
        kind: "download",
        id: "dl",
        url: "https://example.invalid/payload.bin",
        extract: false,
        targetDir: "runtime",
      },
      timeoutMs: 30_000,
    });
    expect(result.ok).toBe(true);
    expect(
      await fs.readFile(
        path.join(resolveSkillToolsRootDir(entry), "runtime", "payload.bin"),
        "utf-8",
      ),
    ).toBe("payload");
  });

  it.runIf(process.platform !== "win32")(
    "fails closed when the lexical tools root is rebound before the final copy",
    async () => {
      const entry = buildEntry("base-rebind");
      const safeRoot = resolveSkillToolsRootDir(entry);
      const outsideRoot = path.join(workspaceDir, "outside-root");
      await fs.mkdir(outsideRoot, { recursive: true });

      fetchWithSsrFGuardMock.mockResolvedValue({
        response: {
          ok: true,
          status: 200,
          statusText: "OK",
          body: Readable.from(
            (async function* () {
              yield Buffer.from("payload");
              const reboundRoot = `${safeRoot}-rebound`;
              await fs.rename(safeRoot, reboundRoot);
              await fs.symlink(outsideRoot, safeRoot);
            })(),
          ),
        },
        release: async () => undefined,
      });

      const result = await installDownloadSpec({
        entry,
        spec: {
          kind: "download",
          id: "dl",
          url: "https://example.invalid/payload.bin",
          extract: false,
          targetDir: "runtime",
        },
        timeoutMs: 30_000,
      });

      expect(result.ok).toBe(false);
      expect(await fileExists(path.join(outsideRoot, "runtime", "payload.bin"))).toBe(false);
    },
  );
});

describe("installDownloadSpec extraction safety (tar.bz2)", () => {
  it("handles tar.bz2 extraction safety edge-cases", async () => {
    for (const testCase of [
      {
        label: "rejects archives containing symlinks",
        name: "tbz2-symlink",
        url: "https://example.invalid/evil.tbz2",
        listOutput: "link\n",
        verboseListOutput: "lrwxr-xr-x  0 0 0 0 Jan  1 00:00 link -> ../outside\n",
        extract: "reject" as const,
        expectedOk: false,
        expectedExtract: false,
        expectedStderrSubstring: "link",
      },
      {
        label: "extracts safe archives with stripComponents",
        name: "tbz2-ok",
        url: "https://example.invalid/good.tbz2",
        listOutput: "package/hello.txt\n",
        verboseListOutput: "-rw-r--r--  0 0 0 0 Jan  1 00:00 package/hello.txt\n",
        stripComponents: 1,
        extract: "ok" as const,
        expectedOk: true,
        expectedExtract: true,
      },
    ]) {
      const entry = buildEntry(testCase.name);
      const targetDir = path.join(resolveSkillToolsRootDir(entry), "target");
      const commandCallCount = runCommandWithTimeoutMock.mock.calls.length;

      mockArchiveResponse(new Uint8Array([1, 2, 3]));
      mockTarExtractionFlow({
        listOutput: testCase.listOutput,
        verboseListOutput: testCase.verboseListOutput,
        extract: testCase.extract,
      });

      const result = await installDownloadSkill({
        name: testCase.name,
        url: testCase.url,
        archive: "tar.bz2",
        stripComponents: testCase.stripComponents,
        targetDir,
      });
      expect(result.ok, testCase.label).toBe(testCase.expectedOk);

      const extractionAttempted = runCommandWithTimeoutMock.mock.calls
        .slice(commandCallCount)
        .some((call) => (call[0] as string[])[1] === "xf");
      expect(extractionAttempted, testCase.label).toBe(testCase.expectedExtract);

      if (typeof testCase.expectedStderrSubstring === "string") {
        expect(result.stderr.toLowerCase(), testCase.label).toContain(
          testCase.expectedStderrSubstring,
        );
      }
    }
  });

  it("rejects tar.bz2 archives that change after preflight", async () => {
    const entry = buildEntry("tbz2-preflight-change");
    const targetDir = path.join(resolveSkillToolsRootDir(entry), "target");
    const commandCallCount = runCommandWithTimeoutMock.mock.calls.length;

    mockArchiveResponse(new Uint8Array([1, 2, 3]));

    runCommandWithTimeoutMock.mockImplementation(async (...argv: unknown[]) => {
      const cmd = (argv[0] ?? []) as string[];
      if (cmd[0] === "tar" && cmd[1] === "tf") {
        return runCommandResult({ stdout: "package/hello.txt\n" });
      }
      if (cmd[0] === "tar" && cmd[1] === "tvf") {
        const archivePath = cmd[2] ?? "";
        if (archivePath) {
          await fs.appendFile(archivePath, "mutated");
        }
        return runCommandResult({ stdout: "-rw-r--r--  0 0 0 0 Jan  1 00:00 package/hello.txt\n" });
      }
      if (cmd[0] === "tar" && cmd[1] === "xf") {
        throw new Error("should not extract");
      }
      return runCommandResult();
    });

    const result = await installDownloadSkill({
      name: "tbz2-preflight-change",
      url: "https://example.invalid/change.tbz2",
      archive: "tar.bz2",
      targetDir,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("changed during safety preflight");
    const extractionAttempted = runCommandWithTimeoutMock.mock.calls
      .slice(commandCallCount)
      .some((call) => (call[0] as string[])[1] === "xf");
    expect(extractionAttempted).toBe(false);
  });

  it("rejects tar.bz2 entries that traverse pre-existing targetDir symlinks", async () => {
    const entry = buildEntry("tbz2-targetdir-symlink");
    const targetDir = path.join(resolveSkillToolsRootDir(entry), "target");
    const outsideDir = path.join(workspaceDir, "tbz2-targetdir-outside");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.symlink(
      outsideDir,
      path.join(targetDir, "escape"),
      process.platform === "win32" ? "junction" : undefined,
    );

    mockArchiveResponse(new Uint8Array([1, 2, 3]));

    runCommandWithTimeoutMock.mockImplementation(async (...argv: unknown[]) => {
      const cmd = (argv[0] ?? []) as string[];
      if (cmd[0] === "tar" && cmd[1] === "tf") {
        return runCommandResult({ stdout: "escape/pwn.txt\n" });
      }
      if (cmd[0] === "tar" && cmd[1] === "tvf") {
        return runCommandResult({ stdout: "-rw-r--r--  0 0 0 0 Jan  1 00:00 escape/pwn.txt\n" });
      }
      if (cmd[0] === "tar" && cmd[1] === "xf") {
        const stagingDir = cmd[cmd.indexOf("-C") + 1] ?? "";
        await fs.mkdir(path.join(stagingDir, "escape"), { recursive: true });
        await fs.writeFile(path.join(stagingDir, "escape", "pwn.txt"), "owned");
        return runCommandResult({ stdout: "ok" });
      }
      return runCommandResult();
    });

    const result = await installDownloadSkill({
      name: "tbz2-targetdir-symlink",
      url: "https://example.invalid/evil.tbz2",
      archive: "tar.bz2",
      targetDir,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr.toLowerCase()).toContain("archive entry traverses symlink in destination");
    expect(await fileExists(path.join(outsideDir, "pwn.txt"))).toBe(false);
  });
});

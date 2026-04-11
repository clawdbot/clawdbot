import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

vi.mock("./skills.js", async () => ({
  ...(await vi.importActual<typeof import("./skills.js")>("./skills.js")),
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

const SAFE_ZIP_BUFFER = Buffer.from(
  "UEsDBAoAAAAAAMOJVlysKpPYAgAAAAIAAAAJAAAAaGVsbG8udHh0aGlQSwECFAAKAAAAAADDiVZcrCqT2AIAAAACAAAACQAAAAAAAAAAAAAAAAAAAAAAaGVsbG8udHh0UEsFBgAAAAABAAEANwAAACkAAAAAAA==",
  "base64",
);
const STRIP_COMPONENTS_ZIP_BUFFER = Buffer.from(
  "UEsDBAoAAAAAAMOJVlwAAAAAAAAAAAAAAAAIAAAAcGFja2FnZS9QSwMECgAAAAAAw4lWXKwqk9gCAAAAAgAAABEAAABwYWNrYWdlL2hlbGxvLnR4dGhpUEsBAhQACgAAAAAAw4lWXAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAQAAAAAAAAAHBhY2thZ2UvUEsBAhQACgAAAAAAw4lWXKwqk9gCAAAAAgAAABEAAAAAAAAAAAAAAAAAJgAAAHBhY2thZ2UvaGVsbG8udHh0UEsFBgAAAAACAAIAdQAAAFcAAAAAAA==",
  "base64",
);
const ZIP_SLIP_BUFFER = Buffer.from(
  "UEsDBAoAAAAAAMOJVlwAAAAAAAAAAAAAAAADAAAALi4vUEsDBAoAAAAAAMOJVlwAAAAAAAAAAAAAAAARAAAALi4vb3V0c2lkZS13cml0ZS9QSwMECgAAAAAAw4lWXD3iZKoEAAAABAAAABoAAAAuLi9vdXRzaWRlLXdyaXRlL3B3bmVkLnR4dHB3bmRQSwECFAAKAAAAAADDiVZcAAAAAAAAAAAAAAAAAwAAAAAAAAAAABAAAAAAAAAALi4vUEsBAhQACgAAAAAAw4lWXAAAAAAAAAAAAAAAABEAAAAAAAAAAAAQAAAAIQAAAC4uL291dHNpZGUtd3JpdGUvUEsBAhQACgAAAAAAw4lWXD3iZKoEAAAABAAAABoAAAAAAAAAAAAAAAAAUAAAAC4uL291dHNpZGUtd3JpdGUvcHduZWQudHh0UEsFBgAAAAADAAMAuAAAAIwAAAAAAA==",
  "base64",
);
const TAR_GZ_TRAVERSAL_BUFFER = Buffer.from(
  // Prebuilt archive containing ../outside-write/pwned.txt.
  "H4sIAK4xm2kAA+2VvU7DMBDH3UoIUWaYLXbcS5PYZegQEKhBRUBbIT4GZBpXCqJNSFySlSdgZed1eCgcUvFRaMsQgVD9k05nW3eWz8nfR0g1GMnY98RmEvlSVMllmAyFR2QqUUEAALUsnHlG7VcPtXwO+djEhm1YlJpAbYrBYAYDhKGoA8xiFEseqaPEUvihkGJanArr92fsk5eC3/x/YWl9GZUROuA9fNjBp3hMtoZWlNWU3SrL5k8/29LpdtvjYZbxqGx1IqT0vr7WCwaEh+GNIGEU3IkhH/YEKpXRxv3FQznsPxdQpGYaZFL/RzxtCu6JqFrYOzBX/wZ81n8NmEERTosocB4Lrn8T8ED6A9EwmHp0Wd1idQK2ZVIAm1ZshlvuttPeabonuyTlUkbkO7k2nGPXcYO9q+tkPzmPk4q1hTsqqXU2K+mDxit/fQ+Lyhf9F9795+tf/WoT/Z8yi+n+/xuoz+1p8Wk0Gs3i8QJSs3VlABAAAA==", // pragma: allowlist secret
  "base64",
);

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
  const blobPart = Uint8Array.from(buffer);
  fetchWithSsrFGuardMock.mockResolvedValue({
    response: new Response(new Blob([blobPart]), { status: 200 }),
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
  it("rejects archive traversal writes outside targetDir", async () => {
    for (const testCase of [
      {
        label: "zip-slip",
        name: "zip-slip",
        url: "https://example.invalid/evil.zip",
        archive: "zip" as const,
        buffer: ZIP_SLIP_BUFFER,
      },
      {
        label: "tar-slip",
        name: "tar-slip",
        url: "https://example.invalid/evil",
        archive: "tar.gz" as const,
        buffer: TAR_GZ_TRAVERSAL_BUFFER,
      },
    ]) {
      const entry = buildEntry(testCase.name);
      const targetDir = path.join(resolveSkillToolsRootDir(entry), "target");
      const outsideWritePath = path.join(workspaceDir, "outside-write", "pwned.txt");

      mockArchiveResponse(new Uint8Array(testCase.buffer));

      const result = await installDownloadSkill({
        ...testCase,
        targetDir,
      });
      expect(result.ok, testCase.label).toBe(false);
      expect(await fileExists(outsideWritePath), testCase.label).toBe(false);
    }
  });

  it("extracts zip with stripComponents safely", async () => {
    const entry = buildEntry("zip-good");
    const targetDir = path.join(resolveSkillToolsRootDir(entry), "target");

    mockArchiveResponse(new Uint8Array(STRIP_COMPONENTS_ZIP_BUFFER));

    const result = await installDownloadSkill({
      name: "zip-good",
      url: "https://example.invalid/good.zip",
      archive: "zip",
      stripComponents: 1,
      targetDir,
    });
    expect(result.ok).toBe(true);
    expect(await fs.readFile(path.join(targetDir, "hello.txt"), "utf-8")).toBe("hi");
  });

  it("rejects targetDir escapes outside the per-skill tools root", async () => {
    mockArchiveResponse(new Uint8Array(SAFE_ZIP_BUFFER));
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
    mockArchiveResponse(new Uint8Array(SAFE_ZIP_BUFFER));
    const entry = buildEntry("relative-targetdir");

    const result = await installDownloadSkill({
      name: "relative-targetdir",
      url: "https://example.invalid/good.zip",
      archive: "zip",
      targetDir: "runtime",
    });
    expect(result.ok).toBe(true);
    expect(
      await fs.readFile(
        path.join(resolveSkillToolsRootDir(entry), "runtime", "hello.txt"),
        "utf-8",
      ),
    ).toBe("hi");
  });

  it.runIf(process.platform !== "win32")(
    "fails closed when the lexical tools root is rebound before the final copy",
    async () => {
      const entry = buildEntry("base-rebind");
      const safeRoot = resolveSkillToolsRootDir(entry);
      const outsideRoot = path.join(workspaceDir, "outside-root");
      await fs.mkdir(outsideRoot, { recursive: true });

      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new Uint8Array(Buffer.from("payload")));
              const reboundRoot = `${safeRoot}-rebound`;
              await fs.rename(safeRoot, reboundRoot);
              await fs.symlink(outsideRoot, safeRoot);
              controller.close();
            },
          }),
          { status: 200 },
        ),
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
        label: "rejects archives containing FIFO entries",
        name: "tbz2-fifo",
        url: "https://example.invalid/evil.tbz2",
        listOutput: "evil-fifo\n",
        verboseListOutput: "prw-r--r--  0 0 0 0 Jan  1 00:00 evil-fifo\n",
        extract: "reject" as const,
        expectedOk: false,
        expectedExtract: false,
        expectedStderrSubstring: "link",
      },
      {
        label: "rejects oversized extracted entries",
        name: "tbz2-oversized",
        url: "https://example.invalid/oversized.tbz2",
        listOutput: "big.bin\n",
        verboseListOutput: "-rw-r--r--  0 0 0 314572800 Jan  1 00:00 big.bin\n",
        extract: "reject" as const,
        expectedOk: false,
        expectedExtract: false,
        expectedStderrSubstring: "archive entry extracted size exceeds limit",
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
      {
        label: "rejects stripComponents escapes",
        name: "tbz2-strip-escape",
        url: "https://example.invalid/evil.tbz2",
        listOutput: "a/../b.txt\n",
        verboseListOutput: "-rw-r--r--  0 0 0 0 Jan  1 00:00 a/../b.txt\n",
        stripComponents: 1,
        extract: "reject" as const,
        expectedOk: false,
        expectedExtract: false,
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

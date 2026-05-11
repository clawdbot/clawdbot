import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  packNpmSpecToArchive,
  resolveArchiveSourcePath,
  withTempDir,
} from "./install-source-utils.js";

const runCommandWithTimeoutMock = vi.fn();
const TEMP_DIR_PREFIX = "openclaw-install-source-utils-";
const tempDirs = createTrackedTempDirs();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

async function createTempDir(prefix: string) {
  return await tempDirs.make(prefix);
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.stat(targetPath);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const statError = error as NodeJS.ErrnoException;
    expect({
      code: statError.code,
      path: statError.path,
      syscall: statError.syscall,
    }).toEqual({
      code: "ENOENT",
      path: targetPath,
      syscall: "stat",
    });
    return;
  }
  throw new Error(`Expected path to be missing: ${targetPath}`);
}

async function createFixtureDir() {
  return await createTempDir(TEMP_DIR_PREFIX);
}

async function createFixtureFile(params: {
  fileName: string;
  contents: string;
  dir?: string;
}): Promise<{ dir: string; filePath: string }> {
  const dir = params.dir ?? (await createFixtureDir());
  const filePath = path.join(dir, params.fileName);
  await fs.writeFile(filePath, params.contents, "utf-8");
  return { dir, filePath };
}

function mockPackCommandResult(params: { stdout: string; stderr?: string; code?: number }) {
  runCommandWithTimeoutMock.mockResolvedValue({
    stdout: params.stdout,
    stderr: params.stderr ?? "",
    code: params.code ?? 0,
    signal: null,
    killed: false,
  });
}

async function runPack(spec: string, cwd: string, timeoutMs = 1000) {
  return await packNpmSpecToArchive({
    spec,
    timeoutMs,
    cwd,
  });
}

async function expectPackFallsBackToDetectedArchive(params: {
  stdout: string;
  expectedMetadata?: Record<string, unknown>;
}) {
  const cwd = await createTempDir("openclaw-install-source-utils-");
  const archivePath = path.join(cwd, "openclaw-plugin-1.2.3.tgz");
  await fs.writeFile(archivePath, "", "utf-8");
  runCommandWithTimeoutMock.mockResolvedValue({
    stdout: params.stdout,
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
  });

  const result = await packNpmSpecToArchive({
    spec: "openclaw-plugin@1.2.3",
    timeoutMs: 5000,
    cwd,
  });

  expect(result).toEqual({
    ok: true,
    archivePath,
    metadata: params.expectedMetadata ?? {},
  });
}

function expectPackError(result: { ok: boolean; error?: string }, expected: string[]): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  for (const part of expected) {
    expect(result.error ?? "").toContain(part);
  }
}

beforeEach(() => {
  runCommandWithTimeoutMock.mockClear();
});

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("withTempDir", () => {
  it("creates a temp dir and always removes it after callback", async () => {
    let observedDir = "";
    const markerFile = "marker.txt";

    const value = await withTempDir("openclaw-install-source-utils-", async (tmpDir) => {
      observedDir = tmpDir;
      await fs.writeFile(path.join(tmpDir, markerFile), "ok", "utf-8");
      await expect(fs.readFile(path.join(tmpDir, markerFile), "utf8")).resolves.toBe("ok");
      return "done";
    });

    expect(value).toBe("done");
    await expectPathMissing(observedDir);
  });
});

describe("resolveArchiveSourcePath", () => {
  it.each([
    {
      name: "returns not found error for missing archive paths",
      path: async () => "/tmp/does-not-exist-openclaw-archive.tgz",
      expected: "archive not found",
    },
    {
      name: "rejects unsupported archive extensions",
      path: async () =>
        (
          await createFixtureFile({
            fileName: "plugin.txt",
            contents: "not-an-archive",
          })
        ).filePath,
      expected: "unsupported archive",
    },
  ])("$name", async ({ path: resolvePath, expected }) => {
    expectPackError(await resolveArchiveSourcePath(await resolvePath()), [expected]);
  });

  it.each(["plugin.zip", "plugin.tgz", "plugin.tar.gz"])(
    "accepts supported archive extension %s",
    async (fileName) => {
      const { filePath } = await createFixtureFile({
        fileName,
        contents: "",
      });

      const result = await resolveArchiveSourcePath(filePath);
      expect(result).toEqual({ ok: true, path: filePath });
    },
  );
});

describe("packNpmSpecToArchive", () => {
  it("packs spec and returns archive path using JSON output metadata", async () => {
    const cwd = await createFixtureDir();
    const archivePath = path.join(cwd, "openclaw-plugin-1.2.3.tgz");
    await fs.writeFile(archivePath, "", "utf-8");
    mockPackCommandResult({
      stdout: JSON.stringify([
        {
          id: "openclaw-plugin@1.2.3",
          name: "openclaw-plugin",
          version: "1.2.3",
          filename: "openclaw-plugin-1.2.3.tgz",
          integrity: "sha512-test-integrity",
          shasum: "abc123",
        },
      ]),
    });

    const result = await runPack("openclaw-plugin@1.2.3", cwd);

    expect(result).toEqual({
      ok: true,
      archivePath,
      metadata: {
        name: "openclaw-plugin",
        version: "1.2.3",
        resolvedSpec: "openclaw-plugin@1.2.3",
        integrity: "sha512-test-integrity",
        shasum: "abc123",
      },
    });
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      ["npm", "pack", "openclaw-plugin@1.2.3", "--ignore-scripts", "--json"],
      {
        cwd,
        timeoutMs: 300_000,
        env: {
          COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
          NPM_CONFIG_IGNORE_SCRIPTS: "true",
        },
      },
    );
  });

  it("falls back to parsing final stdout line when npm json output is unavailable", async () => {
    const cwd = await createFixtureDir();
    const expectedArchivePath = path.join(cwd, "openclaw-plugin-1.2.3.tgz");
    await fs.writeFile(expectedArchivePath, "", "utf-8");
    mockPackCommandResult({
      stdout: "npm notice created package\nopenclaw-plugin-1.2.3.tgz\n",
    });

    const result = await runPack("openclaw-plugin@1.2.3", cwd);

    expect(result).toEqual({
      ok: true,
      archivePath: expectedArchivePath,
      metadata: {},
    });
  });

  it("returns npm pack error details when command fails", async () => {
    const cwd = await createFixtureDir();
    mockPackCommandResult({
      stdout: "fallback stdout",
      stderr: "registry timeout",
      code: 1,
    });

    const result = await runPack("bad-spec", cwd, 5000);
    expectPackError(result, ["npm pack failed", "registry timeout"]);
  });

  it.each([
    {
      name: "falls back to archive detected in cwd when npm pack stdout is empty",
      stdout: " \n\n",
    },
    {
      name: "falls back to archive detected in cwd when stdout does not contain a tgz",
      stdout: "npm pack completed successfully\n",
    },
    {
      name: "falls back to cwd archive when logged JSON metadata omits filename",
      stdout:
        'npm notice using cache\n[{"id":"openclaw-plugin@1.2.3","name":"openclaw-plugin","version":"1.2.3","integrity":"sha512-test-integrity","shasum":"abc123"}]\n',
      expectedMetadata: {
        name: "openclaw-plugin",
        version: "1.2.3",
        resolvedSpec: "openclaw-plugin@1.2.3",
        integrity: "sha512-test-integrity",
        shasum: "abc123",
      },
    },
  ])("$name", async ({ stdout, expectedMetadata }) => {
    await expectPackFallsBackToDetectedArchive({ stdout, expectedMetadata });
  });

  it("returns friendly error for 404 (package not on npm)", async () => {
    const cwd = await createFixtureDir();
    mockPackCommandResult({
      stdout: "",
      stderr: "npm error code E404\nnpm error 404  '@openclaw/whatsapp@*' is not in this registry.",
      code: 1,
    });

    const result = await runPack("@openclaw/whatsapp", cwd);
    expectPackError(result, [
      "Package not found on npm",
      "@openclaw/whatsapp",
      "docs.openclaw.ai/tools/plugin",
    ]);
  });

  it("returns explicit error when npm pack produces no archive name", async () => {
    const cwd = await createFixtureDir();
    mockPackCommandResult({
      stdout: " \n\n",
    });

    const result = await runPack("openclaw-plugin@1.2.3", cwd, 5000);

    expect(result).toEqual({
      ok: false,
      error: "npm pack produced no archive",
    });
  });

  it("parses scoped metadata from id-only json output even with npm notice prefix", async () => {
    const cwd = await createFixtureDir();
    await fs.writeFile(path.join(cwd, "openclaw-plugin-demo-2.0.0.tgz"), "", "utf-8");
    mockPackCommandResult({
      stdout:
        "npm notice creating package\n" +
        JSON.stringify([
          {
            id: "@openclaw/plugin-demo@2.0.0",
            filename: "openclaw-plugin-demo-2.0.0.tgz",
          },
        ]),
    });

    const result = await runPack("@openclaw/plugin-demo@2.0.0", cwd);
    expect(result).toEqual({
      ok: true,
      archivePath: path.join(cwd, "openclaw-plugin-demo-2.0.0.tgz"),
      metadata: {
        resolvedSpec: "@openclaw/plugin-demo@2.0.0",
      },
    });
  });

  it("uses stdout fallback error text when stderr is empty", async () => {
    const cwd = await createFixtureDir();
    mockPackCommandResult({
      stdout: "network timeout",
      stderr: " ",
      code: 1,
    });

    const result = await runPack("bad-spec", cwd);
    expect(result).toEqual({
      ok: false,
      error: "npm pack failed: network timeout",
    });
  });
});

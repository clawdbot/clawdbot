// Install download tests cover downloading skill archives before extraction.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveSkillToolsRootDir } from "../runtime/tools-dir.js";
import { createInstallDownloadTestState } from "../test-support/install-download-test-utils.js";
import {
  fetchWithSsrFGuardMock,
  hasBinaryMock,
  runCommandWithTimeoutMock,
} from "../test-support/install-test-mocks.js";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import type { SkillEntry, SkillInstallSpec } from "../types.js";
import { installDownloadSpec } from "./install-download.js";

vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
}));

vi.mock("../loading/config.js", () => ({
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
    skill: createCanonicalFixtureSkill({
      name,
      description: `${name} test skill`,
      filePath,
      baseDir: skillDir,
      source: "openclaw-workspace",
    }),
    frontmatter: {},
  };
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
      headers: new Headers(),
      body: Readable.from([Buffer.from(buffer)]),
    },
    release: async () => undefined,
  });
}

function createCancelableBody() {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
    },
    cancel() {
      canceled = true;
    },
  });
  return { stream, wasCanceled: () => canceled };
}

async function withDownloadServer(
  respond: (response: ServerResponse) => Promise<void> | void,
  run: (origin: string, release: ReturnType<typeof vi.fn>) => Promise<void>,
): Promise<void> {
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => {
    void Promise.resolve(respond(response)).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral loopback server address");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const release = vi.fn();
  const actualFetchGuard = await vi.importActual<typeof import("../../infra/net/fetch-guard.js")>(
    "../../infra/net/fetch-guard.js",
  );
  fetchWithSsrFGuardMock.mockImplementation(async (...args: unknown[]) => {
    const params = args[0] as Parameters<typeof actualFetchGuard.fetchWithSsrFGuard>[0];
    const guarded = await actualFetchGuard.fetchWithSsrFGuard({
      ...params,
      policy: { allowedOrigins: [origin] },
    });
    return {
      ...guarded,
      release: async () => {
        release();
        await guarded.release();
      },
    };
  });

  try {
    await run(origin, release);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function runCommandResult(
  params?: Partial<Record<"code" | "stdout" | "stderr" | "stdoutTruncatedBytes", string | number>>,
) {
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
let testState: OpenClawTestState | undefined;
beforeAll(async () => {
  testState = await createInstallDownloadTestState();
  workspaceDir = testState.workspaceDir;
});

afterAll(async () => {
  await testState?.cleanup();
  testState = undefined;
  workspaceDir = "";
});

beforeEach(() => {
  runCommandWithTimeoutMock.mockReset();
  runCommandWithTimeoutMock.mockResolvedValue(runCommandResult());
  fetchWithSsrFGuardMock.mockReset();
  hasBinaryMock.mockReset();
  hasBinaryMock.mockReturnValue(true);
});

describe("installDownloadSpec extraction safety", () => {
  it("rejects oversized advertised HTTP downloads before staging the response body", async () => {
    let responseCompleted = false;
    let resolveConnectionClosed: (() => void) | undefined;
    const connectionClosed = new Promise<void>((resolve) => {
      resolveConnectionClosed = resolve;
    });

    await withDownloadServer(
      (response) => {
        response.once("close", () => resolveConnectionClosed?.());
        response.once("finish", () => {
          responseCompleted = true;
        });
        response.writeHead(200, {
          "content-length": "268435457",
          "content-type": "application/octet-stream",
        });
        response.write(Buffer.from([1]));
      },
      async (origin, release) => {
        const entry = buildEntry("oversized-advertised-http-download");
        const toolsRoot = resolveSkillToolsRootDir(entry);
        const result = await installDownloadSpec({
          entry,
          spec: {
            kind: "download",
            id: "dl",
            url: `${origin}/oversized.bin`,
            extract: false,
            targetDir: "runtime",
          },
          timeoutMs: 1_000,
        });

        expect(result.ok).toBe(false);
        expect(result.stderr).toBe(
          "Skill download exceeds 268435456-byte limit (declared 268435457 bytes)",
        );
        await connectionClosed;
        expect(responseCompleted).toBe(false);
        expect(release).toHaveBeenCalledOnce();
        await expect(fileExists(path.join(toolsRoot, "runtime", "oversized.bin"))).resolves.toBe(
          false,
        );
        await expect(fileExists(path.join(toolsRoot, ".openclaw-download-staging"))).resolves.toBe(
          false,
        );
      },
    );
  }, 10_000);

  it.each([
    {
      name: "encoded-response-length",
      headers: new Headers({ "content-encoding": "gzip", "content-length": "268435457" }),
    },
    {
      name: "malformed-response-length",
      headers: new Headers({ "content-length": "1e9" }),
    },
  ])("streams a decoded response with an unusable declared length ($name)", async (testCase) => {
    const body = Buffer.from("decoded skill artifact");
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(body, { status: 200, headers: testCase.headers }),
      release,
    });
    const entry = buildEntry(testCase.name);
    const toolsRoot = resolveSkillToolsRootDir(entry);

    const result = await installDownloadSpec({
      entry,
      spec: {
        kind: "download",
        id: "dl",
        url: "https://example.invalid/artifact.bin",
        extract: false,
        targetDir: "runtime",
      },
      timeoutMs: 30_000,
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe(`downloaded=${body.byteLength}`);
    await expect(fs.readFile(path.join(toolsRoot, "runtime", "artifact.bin"))).resolves.toEqual(
      body,
    );
    expect(release).toHaveBeenCalledOnce();
    await expect(fileExists(path.join(toolsRoot, ".openclaw-download-staging"))).resolves.toBe(
      false,
    );
  });

  it("aborts oversized chunked HTTP downloads and removes partial staging data", async () => {
    const maxBytes = 256 * 1024 * 1024;
    const chunk = Buffer.alloc(1024 * 1024);
    let producedBytes = 0;
    let producedPlannedTail = false;
    let resolveConnectionClosed: (() => void) | undefined;
    const connectionClosed = new Promise<void>((resolve) => {
      resolveConnectionClosed = resolve;
    });

    await withDownloadServer(
      async (response) => {
        response.once("close", () => resolveConnectionClosed?.());
        response.writeHead(200, { "content-type": "application/octet-stream" });

        while (producedBytes < maxBytes && !response.destroyed) {
          const writable = response.write(chunk);
          producedBytes += chunk.byteLength;
          if (!writable) {
            await new Promise<void>((resolve) => {
              const onDrain = () => {
                response.off("close", onClose);
                resolve();
              };
              const onClose = () => {
                response.off("drain", onDrain);
                resolve();
              };
              response.once("drain", onDrain);
              response.once("close", onClose);
            });
          }
        }

        if (response.destroyed) {
          return;
        }
        response.write(Buffer.from([1]));
        producedBytes += 1;
        const tailDeadline = setTimeout(() => {
          producedPlannedTail = true;
          response.end(chunk.subarray(0, 64 * 1024));
        }, 3_000);
        response.once("close", () => clearTimeout(tailDeadline));
      },
      async (origin, release) => {
        const entry = buildEntry("oversized-http-download");
        const toolsRoot = resolveSkillToolsRootDir(entry);
        const result = await installDownloadSpec({
          entry,
          spec: {
            kind: "download",
            id: "dl",
            url: `${origin}/oversized.bin`,
            extract: false,
            targetDir: "runtime",
          },
          timeoutMs: 30_000,
        });

        expect(result.ok).toBe(false);
        expect(result.stderr).toContain("Skill download exceeds 268435456-byte limit");
        await connectionClosed;
        expect(producedBytes).toBe(maxBytes + 1);
        expect(producedPlannedTail).toBe(false);
        expect(release).toHaveBeenCalledOnce();
        await expect(fileExists(path.join(toolsRoot, "runtime", "oversized.bin"))).resolves.toBe(
          false,
        );
        await expect(fileExists(path.join(toolsRoot, ".openclaw-download-staging"))).resolves.toBe(
          false,
        );
      },
    );
  }, 45_000);

  it("installs exact bytes from a chunked HTTP response and releases guarded resources", async () => {
    const chunks = [Buffer.from("skill "), Buffer.from("artifact"), Buffer.from([0, 255])];

    await withDownloadServer(
      (response) => {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        for (const chunk of chunks) {
          response.write(chunk);
        }
        response.end();
      },
      async (origin, release) => {
        const entry = buildEntry("successful-http-download");
        const toolsRoot = resolveSkillToolsRootDir(entry);
        const result = await installDownloadSpec({
          entry,
          spec: {
            kind: "download",
            id: "dl",
            url: `${origin}/artifact.bin`,
            extract: false,
            targetDir: "runtime",
          },
          timeoutMs: 30_000,
        });

        expect(result.ok).toBe(true);
        expect(result.stdout).toBe(`downloaded=${Buffer.concat(chunks).byteLength}`);
        await expect(fs.readFile(path.join(toolsRoot, "runtime", "artifact.bin"))).resolves.toEqual(
          Buffer.concat(chunks),
        );
        expect(release).toHaveBeenCalledOnce();
        await expect(fileExists(path.join(toolsRoot, ".openclaw-download-staging"))).resolves.toBe(
          false,
        );
      },
    );
  });

  it.each([
    { name: "new destination", existing: false },
    { name: "existing destination", existing: true },
  ])("rejects a SHA-256 mismatch without changing a $name", async ({ existing }) => {
    const archive = Buffer.from("unverified archive bytes");
    const expected = "0".repeat(64);
    const actual = createHash("sha256").update(archive).digest("hex");
    const entry = buildEntry(`digest-mismatch-${existing ? "existing" : "new"}`);
    const toolsRoot = resolveSkillToolsRootDir(entry);
    const targetDir = path.join(toolsRoot, "runtime");
    if (existing) {
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(path.join(targetDir, "existing.txt"), "preserved");
    }
    mockArchiveResponse(archive);

    const result = await installDownloadSpec({
      entry,
      spec: {
        ...buildDownloadSpec({
          url: "https://example.invalid/runtime.tar.bz2?token=do-not-disclose",
          archive: "tar.bz2",
          targetDir: "runtime",
        }),
        sha256: expected,
      },
      timeoutMs: 30_000,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("runtime.tar.bz2");
    expect(result.stderr).toContain(expected);
    expect(result.stderr).toContain(actual);
    expect(result.stderr).toContain("download was discarded");
    expect(result.stderr).toContain("verify the publisher checksum");
    expect(result.stderr).not.toContain("do-not-disclose");
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    await expect(fileExists(path.join(targetDir, "runtime.tar.bz2"))).resolves.toBe(false);
    if (existing) {
      await expect(fs.readdir(toolsRoot)).resolves.toEqual(["runtime"]);
      await expect(fs.readdir(targetDir)).resolves.toEqual(["existing.txt"]);
      await expect(fs.readFile(path.join(targetDir, "existing.txt"), "utf8")).resolves.toBe(
        "preserved",
      );
    } else {
      await expect(fs.readdir(toolsRoot)).resolves.toEqual([]);
      await expect(fileExists(targetDir)).resolves.toBe(false);
    }
  });

  it.each([
    { name: "a matching SHA-256 digest", verified: true },
    { name: "no declared digest", verified: false },
  ])("installs and extracts a download with $name", async ({ verified }) => {
    const payload = Buffer.from("verified download payload");
    const entry = buildEntry(`digest-success-${verified ? "verified" : "legacy"}`);
    const toolsRoot = resolveSkillToolsRootDir(entry);
    const sha256 = createHash("sha256").update(payload).digest("hex");
    mockArchiveResponse(payload);
    mockTarExtractionFlow({
      listOutput: "package/runtime.txt\n",
      verboseListOutput: "-rw-r--r--  0 0 0 0 Jan  1 00:00 package/runtime.txt\n",
      extract: "ok",
    });

    const result = await installDownloadSpec({
      entry,
      spec: {
        kind: "download",
        url: "https://example.invalid/runtime.tar.bz2",
        archive: "tar.bz2",
        extract: true,
        targetDir: "runtime",
        ...(verified ? { sha256 } : {}),
      },
      timeoutMs: 30_000,
    });

    expect(result.ok).toBe(true);
    expect(
      runCommandWithTimeoutMock.mock.calls.some((call) => (call[0] as string[])[1] === "xf"),
    ).toBe(true);
    await expect(fs.readFile(path.join(toolsRoot, "runtime", "runtime.tar.bz2"))).resolves.toEqual(
      payload,
    );
    await expect(fs.readdir(toolsRoot)).resolves.toEqual(["runtime"]);
    await expect(fs.readdir(path.join(toolsRoot, "runtime"))).resolves.toEqual(["runtime.tar.bz2"]);
  });

  it("rejects targetDir escapes outside the per-skill tools root", async () => {
    const beforeFetchCalls = fetchWithSsrFGuardMock.mock.calls.length;
    const entry = buildEntry("relative-traversal");
    const toolsRoot = resolveSkillToolsRootDir(entry);
    const escapedTargetDir = path.resolve(toolsRoot, "../outside");

    const result = await installDownloadSpec({
      entry,
      spec: buildDownloadSpec({
        url: "https://example.invalid/good.zip",
        archive: "zip",
        targetDir: "../outside",
      }),
      timeoutMs: 30_000,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Refusing to install outside the skill tools directory");
    expect(fetchWithSsrFGuardMock.mock.calls.length).toBe(beforeFetchCalls);
    await expect(fileExists(toolsRoot)).resolves.toBe(true);
    await expect(fileExists(escapedTargetDir)).resolves.toBe(false);
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

  it("cancels failed download response bodies before returning the error", async () => {
    const { stream, wasCanceled } = createCancelableBody();
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: {
        ok: false,
        status: 500,
        statusText: "Server Error",
        body: stream,
      },
      release,
    });

    const result = await installDownloadSpec({
      entry: buildEntry("failed-download-body"),
      spec: {
        kind: "download",
        id: "dl",
        url: "https://example.invalid/broken.bin",
        extract: false,
        targetDir: "runtime",
      },
      timeoutMs: 30_000,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Download failed (500 Server Error)");
    expect(wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it.runIf(process.platform !== "win32").each([
    { name: "a legacy download", verified: false },
    { name: "a matching-digest download", verified: true },
  ])(
    "fails closed when $name rebinds the lexical tools root before the final copy",
    async ({ verified }) => {
      const entry = buildEntry(`base-rebind-${verified ? "verified" : "legacy"}`);
      const safeToolsRoot = resolveSkillToolsRootDir(entry);
      const outsideRoot = path.join(
        workspaceDir,
        `outside-root-${verified ? "verified" : "legacy"}`,
      );
      const payload = Buffer.from("payload");
      await fs.mkdir(safeToolsRoot, { recursive: true });
      await fs.mkdir(outsideRoot, { recursive: true });

      fetchWithSsrFGuardMock.mockResolvedValue({
        response: {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
          body: Readable.from(
            (async function* () {
              yield payload;
              const reboundRoot = `${safeToolsRoot}-rebound`;
              await fs.rename(safeToolsRoot, reboundRoot);
              await fs.symlink(outsideRoot, safeToolsRoot);
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
          ...(verified ? { sha256: createHash("sha256").update(payload).digest("hex") } : {}),
        },
        timeoutMs: 30_000,
      });

      expect(result.ok).toBe(false);
      expect(await fileExists(path.join(outsideRoot, "runtime", "payload.bin"))).toBe(false);
    },
  );
});

describe("installDownloadSpec extraction safety (tar.bz2)", () => {
  it.each(["plain", "verbose"] as const)(
    "rejects truncated %s tar listings before extraction",
    async (truncatedListing) => {
      const name = `tbz2-truncated-${truncatedListing}`;
      const entry = buildEntry(name);
      const targetDir = path.join(resolveSkillToolsRootDir(entry), "target");

      mockArchiveResponse(new Uint8Array([1, 2, 3]));
      runCommandWithTimeoutMock.mockImplementation(async (...argv: unknown[]) => {
        const cmd = (argv[0] ?? []) as string[];
        if (cmd[0] === "tar" && cmd[1] === "tf") {
          return runCommandResult({
            stdout: "package/hello.txt\n",
            ...(truncatedListing === "plain" ? { stdoutTruncatedBytes: 1 } : {}),
          });
        }
        if (cmd[0] === "tar" && cmd[1] === "tvf") {
          return runCommandResult({
            stdout: "-rw-r--r--  0 0 0 0 Jan  1 00:00 package/hello.txt\n",
            ...(truncatedListing === "verbose" ? { stdoutTruncatedBytes: 1 } : {}),
          });
        }
        if (cmd[0] === "tar" && cmd[1] === "xf") {
          throw new Error("should not extract");
        }
        return runCommandResult();
      });

      const result = await installDownloadSkill({
        name,
        url: `https://example.invalid/${name}.tbz2`,
        archive: "tar.bz2",
        targetDir,
      });

      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("tar listing output was truncated");
      expect(
        runCommandWithTimeoutMock.mock.calls.some(
          (call) => (call[0] as string[])[0] === "tar" && (call[0] as string[])[1] === "xf",
        ),
      ).toBe(false);
    },
  );

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

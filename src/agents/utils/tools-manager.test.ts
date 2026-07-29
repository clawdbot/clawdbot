import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());
const extractArchiveMock = vi.hoisted(() => vi.fn());

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: spawnSyncMock,
}));

vi.mock("../../infra/archive.js", () => ({
  extractArchive: extractArchiveMock,
}));

let originalAgentDir: string | undefined;
let tempAgentDir: string | undefined;

beforeEach(() => {
  originalAgentDir = process.env.OPENCLAW_AGENT_DIR;
  tempAgentDir = mkdtempSync(join(tmpdir(), "openclaw-tools-manager-"));
  setTestEnvValue("OPENCLAW_AGENT_DIR", tempAgentDir);
  fetchWithSsrFGuardMock.mockReset();
  extractArchiveMock.mockReset();
  spawnSyncMock.mockReturnValue({
    error: new Error("ENOENT"),
    status: null,
    stderr: Buffer.alloc(0),
    stdout: Buffer.alloc(0),
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  if (originalAgentDir === undefined) {
    deleteTestEnvValue("OPENCLAW_AGENT_DIR");
  } else {
    setTestEnvValue("OPENCLAW_AGENT_DIR", originalAgentDir);
  }
  if (tempAgentDir) {
    rmSync(tempAgentDir, { recursive: true, force: true });
  }
  tempAgentDir = undefined;
});

describe("ensureTool", () => {
  it("cancels release-check error bodies before releasing guarded fetches", async () => {
    const { ensureTool } = await import("./tools-manager.js");
    const release = vi.fn(async () => {});
    const response = new Response("server error", { status: 503 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response,
      release,
      finalUrl: "https://api.github.com/repos/sharkdp/fd/releases/latest",
    });

    await expect(ensureTool("fd", true)).resolves.toBeUndefined();

    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("cancels download error bodies before releasing guarded fetches", async () => {
    const { ensureTool } = await import("./tools-manager.js");
    const releaseCheckRelease = vi.fn(async () => {});
    const downloadRelease = vi.fn(async () => {});
    const downloadResponse = new Response("missing asset", { status: 404 });
    const cancel = vi.spyOn(downloadResponse.body!, "cancel").mockResolvedValue(undefined);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ tag_name: "14.1.1" }), { status: 200 }),
        release: releaseCheckRelease,
        finalUrl: "https://api.github.com/repos/BurntSushi/ripgrep/releases/latest",
      })
      .mockResolvedValueOnce({
        response: downloadResponse,
        release: downloadRelease,
        finalUrl: "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/archive",
      });

    await expect(ensureTool("rg", true)).resolves.toBeUndefined();

    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseCheckRelease).toHaveBeenCalledOnce();
    expect(downloadRelease).toHaveBeenCalledOnce();
  });

  it("extracts Windows zip downloads via safe archive API with size limits", async () => {
    vi.doMock("node:os", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:os")>()),
      arch: () => "x64",
      platform: () => "win32",
    }));

    const { ensureTool } = await import("./tools-manager.js");
    const releaseCheckRelease = vi.fn(async () => {});
    const downloadRelease = vi.fn(async () => {});
    extractArchiveMock.mockImplementation(async (params: { destDir: string }) => {
      writeFileSync(join(params.destDir, "rg.exe"), "binary");
    });
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ tag_name: "14.1.1" }), { status: 200 }),
        release: releaseCheckRelease,
        finalUrl: "https://api.github.com/repos/BurntSushi/ripgrep/releases/latest",
      })
      .mockResolvedValueOnce({
        response: new Response("zip-bytes", { status: 200 }),
        release: downloadRelease,
        finalUrl: "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/archive.zip",
      });

    await expect(ensureTool("rg", true)).resolves.toBe(join(tempAgentDir!, "bin", "rg.exe"));

    expect(extractArchiveMock).toHaveBeenCalledOnce();
    expect(extractArchiveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        archivePath: expect.stringContaining(".zip"),
        destDir: expect.stringContaining("extract_tmp_rg_"),
        timeoutMs: 60_000,
        limits: {
          maxArchiveBytes: 100 * 1024 * 1024,
          maxExtractedBytes: 500 * 1024 * 1024,
          maxEntries: 1_000,
        },
      }),
    );
  });

  it("rejects downloads whose declared size exceeds the byte cap", async () => {
    const response = new Response("oversized-body", {
      status: 200,
      headers: { "content-length": "11" },
    });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response,
      release,
      finalUrl: "https://example.com/archive.tar.gz",
    });
    const destination = join(tempAgentDir!, "archive.tar.gz");
    const { testing } = await import("./tools-manager.test-support.js");

    await expect(
      testing.downloadFile("https://example.com/archive.tar.gz", destination, 10),
    ).rejects.toThrow("Download exceeds the 10-byte archive limit");

    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects streamed bytes above the cap and removes the partial file", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6]));
          controller.enqueue(new Uint8Array([7, 8, 9, 10, 11, 12]));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-length": "6" } },
    );
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response,
      release,
      finalUrl: "https://example.com/archive.tar.gz",
    });
    const destination = join(tempAgentDir!, "archive.tar.gz");
    const { testing } = await import("./tools-manager.test-support.js");

    await expect(
      testing.downloadFile("https://example.com/archive.tar.gz", destination, 10),
    ).rejects.toThrow("Download exceeded the 10-byte archive limit");

    expect(release).toHaveBeenCalledOnce();
    expect(existsSync(destination)).toBe(false);
  });

  it("accepts downloads exactly at the byte cap", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(body, {
        status: 200,
        headers: { "content-length": String(body.byteLength) },
      }),
      release,
      finalUrl: "https://example.com/archive.tar.gz",
    });
    const destination = join(tempAgentDir!, "archive.tar.gz");
    const { testing } = await import("./tools-manager.test-support.js");

    await testing.downloadFile("https://example.com/archive.tar.gz", destination, body.byteLength);

    expect(release).toHaveBeenCalledOnce();
    expect(readFileSync(destination)).toEqual(Buffer.from(body));
  });

  it("bounds GitHub release metadata reads", async () => {
    let reads = 0;
    let canceled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (reads >= 20) {
            controller.close();
            return;
          }
          reads += 1;
          controller.enqueue(new Uint8Array(512 * 1024));
        },
        cancel() {
          canceled = true;
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response,
      release,
      finalUrl: "https://api.github.com/repos/sharkdp/fd/releases/latest",
    });

    const { ensureTool } = await import("./tools-manager.js");
    await expect(ensureTool("fd", true)).resolves.toBeUndefined();

    expect(reads).toBeLessThan(20);
    expect(canceled).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("ensureTool exit-status handling", () => {
  it("treats a binary that spawns but exits non-zero as missing", async () => {
    const { ensureTool } = await import("./tools-manager.js");
    // execve succeeded (no result.error) but the child exited non-zero — the
    // signature of an installed-but-broken binary (GLIBC / shared-lib mismatch).
    // Must not be reported as available, or ensureTool skips its download path.
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 1,
      stderr: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
    });
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response("unavailable", { status: 503 }),
      release,
      finalUrl: "https://api.github.com/repos/sharkdp/fd/releases/latest",
    });

    await expect(ensureTool("fd", true)).resolves.toBeUndefined();
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("reports a binary present when it spawns and exits 0", async () => {
    const { ensureTool } = await import("./tools-manager.js");
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stderr: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
    });
    await expect(ensureTool("fd", true)).resolves.toBe("fd");
    expect(spawnSyncMock).toHaveBeenCalledWith("fd", ["--version"], {
      killSignal: "SIGKILL",
      stdio: "pipe",
      timeout: 5_000,
    });
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });
});

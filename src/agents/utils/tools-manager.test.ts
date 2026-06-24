import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: spawnSyncMock,
}));

let originalAgentDir: string | undefined;
let tempAgentDir: string | undefined;

beforeEach(() => {
  originalAgentDir = process.env.OPENCLAW_AGENT_DIR;
  tempAgentDir = mkdtempSync(join(tmpdir(), "openclaw-tools-manager-"));
  process.env.OPENCLAW_AGENT_DIR = tempAgentDir;
  fetchWithSsrFGuardMock.mockReset();
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
    delete process.env.OPENCLAW_AGENT_DIR;
  } else {
    process.env.OPENCLAW_AGENT_DIR = originalAgentDir;
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

  it("extracts Windows zip downloads with trusted System32 tools", async () => {
    vi.doMock("node:os", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:os")>()),
      arch: () => "x64",
      platform: () => "win32",
    }));

    const { ensureTool } = await import("./tools-manager.js");
    const releaseCheckRelease = vi.fn(async () => {});
    const downloadRelease = vi.fn(async () => {});
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
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === "C:\\Windows\\System32\\tar.exe") {
        return {
          error: undefined,
          status: 1,
          stderr: Buffer.from("tar failed"),
          stdout: Buffer.alloc(0),
        };
      }
      if (command === "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe") {
        const extractDir = args.at(-1);
        if (!extractDir) {
          throw new Error("expected extraction destination");
        }
        writeFileSync(join(extractDir, "rg.exe"), "binary");
        return {
          error: undefined,
          status: 0,
          stderr: Buffer.alloc(0),
          stdout: Buffer.alloc(0),
        };
      }
      return {
        error: new Error(`unexpected command: ${command}`),
        status: null,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      };
    });

    await expect(ensureTool("rg", true)).resolves.toBe(join(tempAgentDir!, "bin", "rg.exe"));

    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      2,
      "C:\\Windows\\System32\\tar.exe",
      expect.any(Array),
      { stdio: "pipe" },
    );
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      3,
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      expect.any(Array),
      { stdio: "pipe" },
    );
  });
});

describe("getToolPath exit-status handling", () => {
  it("treats a binary that spawns but exits non-zero as missing", async () => {
    const { getToolPath } = await import("./tools-manager.js");
    // execve succeeded (no result.error) but the child exited non-zero — the
    // signature of an installed-but-broken binary (GLIBC / shared-lib mismatch).
    // Must not be reported as available, or ensureTool skips its download path.
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 1,
      stderr: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
    });
    expect(getToolPath("fd")).toBeNull();
  });

  it("reports a binary present when it spawns and exits 0", async () => {
    const { getToolPath } = await import("./tools-manager.js");
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stderr: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
    });
    expect(getToolPath("fd")).toBe("fd");
  });
});

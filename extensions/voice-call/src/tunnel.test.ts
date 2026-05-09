import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killedWith: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killedWith = signal;
    queueMicrotask(() => this.emit("close", null));
    return true;
  }

  close(code: number | null = 0): void {
    this.emit("close", code);
  }

  fail(error: Error): void {
    this.emit("error", error);
  }
}

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  getTailscaleDnsName: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}));

vi.mock("./webhook/tailscale.js", () => ({
  getTailscaleDnsName: mocks.getTailscaleDnsName,
}));

import { isNgrokAvailable, startNgrokTunnel, startTailscaleTunnel, startTunnel } from "./tunnel.js";

function nextProcess(): FakeChildProcess {
  const proc = new FakeChildProcess();
  mocks.spawn.mockReturnValueOnce(proc as never);
  return proc;
}

function emitNgrokUrl(proc: FakeChildProcess, url: string): void {
  proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ msg: "started tunnel", url })}\n`));
}

describe("voice-call tunnels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTailscaleDnsName.mockReset();
  });

  it("checks ngrok availability from the version command exit code", async () => {
    const proc = nextProcess();
    const result = isNgrokAvailable();
    proc.close(0);

    await expect(result).resolves.toBe(true);
    expect(mocks.spawn).toHaveBeenCalledWith("ngrok", ["version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("treats ngrok spawn failures as unavailable", async () => {
    const proc = nextProcess();
    const result = isNgrokAvailable();
    proc.fail(new Error("spawn ngrok ENOENT"));

    await expect(result).resolves.toBe(false);
  });

  it("starts ngrok and appends the webhook path to the public URL", async () => {
    const proc = nextProcess();
    const result = startNgrokTunnel({ port: 3334, path: "/voice/webhook" });

    emitNgrokUrl(proc, "https://abc.ngrok.io");

    await expect(result).resolves.toMatchObject({
      publicUrl: "https://abc.ngrok.io/voice/webhook",
      provider: "ngrok",
    });
    expect(mocks.spawn).toHaveBeenCalledWith("ngrok", expect.arrayContaining(["http", "3334"]), {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("sets ngrok auth token before starting the tunnel", async () => {
    const authProc = nextProcess();
    const tunnelProc = nextProcess();
    const result = startNgrokTunnel({
      port: 3334,
      path: "/hook",
      authToken: "token",
    });

    authProc.close(0);
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2));
    emitNgrokUrl(tunnelProc, "https://auth.ngrok.io");

    await expect(result).resolves.toMatchObject({
      publicUrl: "https://auth.ngrok.io/hook",
    });
    expect(mocks.spawn).toHaveBeenNthCalledWith(1, "ngrok", ["config", "add-authtoken", "token"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("rejects ngrok startup errors from stderr", async () => {
    const proc = nextProcess();
    const result = startNgrokTunnel({ port: 3334, path: "/hook" });

    proc.stderr.emit("data", Buffer.from("ERR_NGROK_3200: invalid auth token"));

    await expect(result).rejects.toThrow("ngrok error:");
  });

  it("starts Tailscale serve using the resolved tailnet DNS name", async () => {
    mocks.getTailscaleDnsName.mockResolvedValue("host.tailnet.ts.net");
    const proc = nextProcess();
    const result = startTailscaleTunnel({
      mode: "serve",
      port: 3334,
      path: "voice/webhook",
    });

    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
    proc.close(0);

    await expect(result).resolves.toMatchObject({
      publicUrl: "https://host.tailnet.ts.net/voice/webhook",
      provider: "tailscale-serve",
    });
    expect(mocks.spawn).toHaveBeenCalledWith(
      "tailscale",
      expect.arrayContaining(["serve", "--set-path", "/voice/webhook"]),
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("rejects Tailscale tunnel startup when the DNS name is unavailable", async () => {
    mocks.getTailscaleDnsName.mockResolvedValue(null);

    await expect(
      startTailscaleTunnel({ mode: "funnel", port: 3334, path: "/hook" }),
    ).rejects.toThrow("Could not get Tailscale DNS name");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("dispatches tunnel providers from config", async () => {
    await expect(startTunnel({ provider: "none", port: 3334, path: "/hook" })).resolves.toBeNull();

    const proc = nextProcess();
    const result = startTunnel({ provider: "ngrok", port: 3334, path: "/hook" });
    emitNgrokUrl(proc, "https://dispatch.ngrok.io");

    await expect(result).resolves.toMatchObject({
      publicUrl: "https://dispatch.ngrok.io/hook",
      provider: "ngrok",
    });
  });
});

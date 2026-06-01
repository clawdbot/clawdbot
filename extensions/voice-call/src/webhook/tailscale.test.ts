import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

const tailscaleSpawnOptions = { stdio: ["ignore", "pipe", "ignore"] } as const;

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawn: spawnMock,
    },
  );
});

import {
  appendTailscaleCommandStdout,
  cleanupTailscaleExposure,
  cleanupTailscaleExposureRoute,
  getTailscaleDnsName,
  getTailscaleSelfInfo,
  setupTailscaleExposure,
  setupTailscaleExposureRoute,
  TAILSCALE_COMMAND_STDOUT_MAX_BYTES,
} from "./tailscale.js";

function createProc(params?: { code?: number; stdout?: string }) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.kill = vi.fn();
  const originalOn = proc.on.bind(proc);
  proc.on = ((eventName: string | symbol, listener: (...args: unknown[]) => void) => {
    const result = originalOn(eventName, listener);
    if (eventName === "close") {
      if (params?.stdout) {
        proc.stdout.emit("data", Buffer.from(params.stdout));
      }
      listener(params?.code ?? 0);
    }
    return result;
  }) as typeof proc.on;
  return proc;
}

function createErrorProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.kill = vi.fn();
  const originalOn = proc.on.bind(proc);
  proc.on = ((eventName: string | symbol, listener: (...args: unknown[]) => void) => {
    const result = originalOn(eventName, listener);
    if (eventName === "error") {
      listener(Object.assign(new Error("spawn tailscale ENOENT"), { code: "ENOENT" }));
    }
    return result;
  }) as typeof proc.on;
  return proc;
}

describe("voice-call tailscale helpers", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("reads dns and node id from tailscale status json", async () => {
    spawnMock
      .mockReturnValueOnce(
        createProc({
          stdout: JSON.stringify({
            Self: {
              DNSName: "bot.example.ts.net.",
              ID: "node-123",
            },
          }),
        }),
      )
      .mockReturnValueOnce(
        createProc({
          stdout: JSON.stringify({
            Self: {
              DNSName: "bot.example.ts.net.",
              ID: "node-123",
            },
          }),
        }),
      );

    await expect(getTailscaleSelfInfo()).resolves.toEqual({
      dnsName: "bot.example.ts.net",
      nodeId: "node-123",
    });
    await expect(getTailscaleDnsName()).resolves.toBe("bot.example.ts.net");
  });

  it("returns null for failing or invalid status responses", async () => {
    spawnMock.mockReturnValueOnce(createProc({ code: 1, stdout: "bad" }));
    await expect(getTailscaleSelfInfo()).resolves.toBeNull();

    spawnMock.mockReturnValueOnce(createProc({ stdout: "{not-json" }));
    await expect(getTailscaleSelfInfo()).resolves.toBeNull();
  });

  it("treats missing tailscale binary as unavailable instead of leaking spawn errors", async () => {
    spawnMock.mockReturnValueOnce(createErrorProc());

    await expect(getTailscaleSelfInfo()).resolves.toBeNull();
  });

  it("tracks tailscale stdout without retaining over-limit output", () => {
    let stdout = appendTailscaleCommandStdout({ bytes: 0, exceeded: false, text: "" }, "ok", 4);
    stdout = appendTailscaleCommandStdout(stdout, "boom", 4);

    expect(stdout).toEqual({ bytes: 6, exceeded: true, text: "" });
  });

  it("kills tailscale status when stdout exceeds the capture limit", async () => {
    const proc = createProc({ stdout: "x".repeat(TAILSCALE_COMMAND_STDOUT_MAX_BYTES + 1) });
    spawnMock.mockReturnValueOnce(proc);

    await expect(getTailscaleSelfInfo()).resolves.toBeNull();
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("sets up and cleans up exposure routes with the selected mode", async () => {
    spawnMock
      .mockReturnValueOnce(
        createProc({
          stdout: JSON.stringify({ Self: { DNSName: "bot.example.ts.net." } }),
        }),
      )
      .mockReturnValueOnce(createProc({ code: 0 }))
      .mockReturnValueOnce(createProc({ code: 0 }));

    await expect(
      setupTailscaleExposureRoute({
        mode: "serve",
        path: "/voice",
        localUrl: "http://127.0.0.1:8787/webhook",
      }),
    ).resolves.toBe("https://bot.example.ts.net/voice");

    await cleanupTailscaleExposureRoute({ mode: "serve", path: "/voice" });

    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      "tailscale",
      ["status", "--json", "--peers=false"],
      tailscaleSpawnOptions,
    );
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      "tailscale",
      ["serve", "--bg", "--yes", "--set-path", "/voice", "http://127.0.0.1:8787/webhook"],
      tailscaleSpawnOptions,
    );
    expect(spawnMock).toHaveBeenNthCalledWith(
      3,
      "tailscale",
      ["serve", "off", "/voice"],
      tailscaleSpawnOptions,
    );
  });

  it("returns null when setup cannot resolve dns or route activation fails", async () => {
    spawnMock
      .mockReturnValueOnce(createProc({ code: 1 }))
      .mockReturnValueOnce(
        createProc({
          stdout: JSON.stringify({ Self: { DNSName: "bot.example.ts.net." } }),
        }),
      )
      .mockReturnValueOnce(createProc({ code: 1 }));

    await expect(
      setupTailscaleExposureRoute({
        mode: "funnel",
        path: "/voice",
        localUrl: "http://127.0.0.1:8787/webhook",
      }),
    ).resolves.toBeNull();

    await expect(
      setupTailscaleExposureRoute({
        mode: "funnel",
        path: "/voice",
        localUrl: "http://127.0.0.1:8787/webhook",
      }),
    ).resolves.toBeNull();
  });

  it("maps config modes to serve or funnel and skips off", async () => {
    spawnMock
      .mockReturnValueOnce(
        createProc({
          stdout: JSON.stringify({ Self: { DNSName: "bot.example.ts.net." } }),
        }),
      )
      .mockReturnValueOnce(createProc({ code: 0 }))
      .mockReturnValueOnce(createProc({ code: 0 }));

    await expect(
      setupTailscaleExposure({
        tailscale: { mode: "off", path: "/voice" },
        serve: { port: 8787, path: "/webhook" },
      } as never),
    ).resolves.toBeNull();

    await expect(
      setupTailscaleExposure({
        tailscale: { mode: "funnel", path: "/voice" },
        serve: { port: 8787, path: "/webhook" },
      } as never),
    ).resolves.toBe("https://bot.example.ts.net/voice");

    await cleanupTailscaleExposure({
      tailscale: { mode: "serve", path: "/voice" },
      serve: { port: 8787, path: "/webhook" },
    } as never);

    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      "tailscale",
      ["funnel", "--bg", "--yes", "--set-path", "/voice", "http://127.0.0.1:8787/webhook"],
      tailscaleSpawnOptions,
    );
    expect(spawnMock).toHaveBeenNthCalledWith(
      3,
      "tailscale",
      ["serve", "off", "/voice"],
      tailscaleSpawnOptions,
    );
  });
});

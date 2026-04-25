import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("../../../../test/helpers/node-builtin-mocks.js");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawn: spawnMock,
    },
  );
});

import {
  cleanupTailscaleExposure,
  cleanupTailscaleExposureRoute,
  getTailscaleDnsName,
  getTailscaleSelfInfo,
  setupTailscaleExposure,
  setupTailscaleExposureRoute,
} from "./tailscale.js";

function createProc(params?: { code?: number; stdout?: string }) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.kill = vi.fn();
  setTimeout(() => {
    if (params?.stdout) {
      proc.stdout.emit("data", Buffer.from(params.stdout));
    }
    proc.emit("close", params?.code ?? 0);
  }, 0);
  return proc;
}

function createErrorProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.kill = vi.fn();
  setTimeout(() => {
    proc.emit("error", Object.assign(new Error("spawn tailscale ENOENT"), { code: "ENOENT" }));
  }, 0);
  return proc;
}

describe("voice-call tailscale helpers", () => {
  beforeEach(() => {
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
      ["status", "--json"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      "tailscale",
      ["serve", "--bg", "--yes", "--set-path", "/voice", "http://127.0.0.1:8787/webhook"],
      expect.any(Object),
    );
    expect(spawnMock).toHaveBeenNthCalledWith(
      3,
      "tailscale",
      ["serve", "off", "/voice"],
      expect.any(Object),
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
      expect.any(Object),
    );
    expect(spawnMock).toHaveBeenNthCalledWith(
      3,
      "tailscale",
      ["serve", "off", "/voice"],
      expect.any(Object),
    );
  });
});

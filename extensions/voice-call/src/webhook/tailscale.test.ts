// Voice Call tests cover bounded Tailscale command execution.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runCommandMock } = vi.hoisted(() => ({ runCommandMock: vi.fn() }));

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  runCommandWithTimeout: runCommandMock,
}));

import {
  cleanupTailscaleExposure,
  cleanupTailscaleExposureRoute,
  getTailscaleSelfInfo,
  setupTailscaleExposure,
  setupTailscaleExposureRoutes,
} from "./tailscale.js";

function commandResult(overrides: Record<string, unknown> = {}) {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

describe("voice-call tailscale helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runCommandMock.mockResolvedValue(commandResult());
  });

  it("reads dns and node id through the canonical bounded wrapper", async () => {
    const stdout = JSON.stringify({
      Self: { DNSName: "bot.example.ts.net.", ID: "node-123" },
    });
    runCommandMock.mockResolvedValue(commandResult({ stdout }));

    await expect(getTailscaleSelfInfo()).resolves.toEqual({
      dnsName: "bot.example.ts.net",
      nodeId: "node-123",
    });
    expect(runCommandMock).toHaveBeenCalledWith(
      ["tailscale", "status", "--json", "--peers=false"],
      expect.objectContaining({
        killProcessTree: true,
        maxOutputBytes: { stdout: 4 * 1024 * 1024, stderr: 1 },
        terminateOnOutputLimit: { stdout: true },
        timeoutMs: 2500,
      }),
    );
  });

  it("returns null for command, timeout, output-limit, and JSON failures", async () => {
    runCommandMock.mockResolvedValueOnce(commandResult({ code: 1, stdout: "bad" }));
    await expect(getTailscaleSelfInfo()).resolves.toBeNull();

    runCommandMock.mockResolvedValueOnce(commandResult({ stdout: "{not-json" }));
    await expect(getTailscaleSelfInfo()).resolves.toBeNull();

    runCommandMock.mockRejectedValueOnce(new Error("tailscale missing"));
    await expect(getTailscaleSelfInfo()).resolves.toBeNull();

    runCommandMock.mockResolvedValueOnce(commandResult({ code: null, termination: "timeout" }));
    await expect(getTailscaleSelfInfo()).resolves.toBeNull();

    runCommandMock.mockResolvedValueOnce(
      commandResult({ code: null, termination: "signal", outputLimitExceeded: true }),
    );
    await expect(getTailscaleSelfInfo()).resolves.toBeNull();
  });

  it("sets up and cleans up exposure routes with the selected mode", async () => {
    runCommandMock
      .mockResolvedValueOnce(
        commandResult({ stdout: JSON.stringify({ Self: { DNSName: "bot.example.ts.net." } }) }),
      )
      .mockResolvedValueOnce(commandResult())
      .mockResolvedValueOnce(commandResult());

    await expect(
      setupTailscaleExposureRoutes({
        mode: "serve",
        port: 443,
        routes: [{ path: "/voice", localUrl: "http://127.0.0.1:8787/webhook" }],
      }),
    ).resolves.toBe("https://bot.example.ts.net/voice");
    await cleanupTailscaleExposureRoute({ mode: "serve", port: 443, path: "/voice" });

    expect(runCommandMock).toHaveBeenNthCalledWith(
      2,
      [
        "tailscale",
        "serve",
        "--bg",
        "--yes",
        "--set-path",
        "/voice",
        "http://127.0.0.1:8787/webhook",
      ],
      expect.any(Object),
    );
    expect(runCommandMock).toHaveBeenNthCalledWith(
      3,
      ["tailscale", "serve", "off", "/voice"],
      expect.any(Object),
    );
  });

  it("returns null when setup cannot resolve dns or route activation fails", async () => {
    runCommandMock
      .mockResolvedValueOnce(commandResult({ code: 1 }))
      .mockResolvedValueOnce(
        commandResult({ stdout: JSON.stringify({ Self: { DNSName: "bot.example.ts.net." } }) }),
      )
      .mockResolvedValueOnce(commandResult({ code: 1 }));

    await expect(
      setupTailscaleExposureRoutes({
        mode: "funnel",
        port: 443,
        routes: [{ path: "/voice", localUrl: "http://127.0.0.1:8787/webhook" }],
      }),
    ).resolves.toBeNull();
    await expect(
      setupTailscaleExposureRoutes({
        mode: "funnel",
        port: 443,
        routes: [{ path: "/voice", localUrl: "http://127.0.0.1:8787/webhook" }],
      }),
    ).resolves.toBeNull();
  });

  it("maps config modes to serve or funnel and skips off", async () => {
    runCommandMock
      .mockResolvedValueOnce(
        commandResult({ stdout: JSON.stringify({ Self: { DNSName: "bot.example.ts.net." } }) }),
      )
      .mockResolvedValueOnce(commandResult())
      .mockResolvedValueOnce(commandResult());

    await expect(
      setupTailscaleExposure({
        tailscale: { mode: "off", port: 443, path: "/voice" },
        serve: { port: 8787, path: "/webhook" },
        realtime: { enabled: false },
        streaming: { enabled: false },
      } as never),
    ).resolves.toBeNull();
    await expect(
      setupTailscaleExposure({
        tailscale: { mode: "funnel", port: 443, path: "/voice" },
        serve: { port: 8787, path: "/webhook" },
        realtime: { enabled: false },
        streaming: { enabled: false },
      } as never),
    ).resolves.toBe("https://bot.example.ts.net/voice");
    await cleanupTailscaleExposure({
      tailscale: { mode: "serve", port: 443, path: "/voice" },
      serve: { port: 8787, path: "/webhook" },
      realtime: { enabled: false },
      streaming: { enabled: false },
    } as never);

    expect(runCommandMock.mock.calls[1]?.[0]).toEqual([
      "tailscale",
      "funnel",
      "--bg",
      "--yes",
      "--set-path",
      "/voice",
      "http://127.0.0.1:8787/webhook",
    ]);
    expect(runCommandMock.mock.calls[2]?.[0]).toEqual(["tailscale", "serve", "off", "/voice"]);
  });

  it.each([
    {
      name: "realtime",
      config: { realtime: { enabled: true, streamPath: "/voice/stream/realtime" } },
      streamPath: "/voice/stream/realtime",
      publicStreamPath: "/edge/voice/stream/realtime",
    },
    {
      name: "streaming",
      config: { streaming: { enabled: true, streamPath: "/voice/stream" } },
      streamPath: "/voice/stream",
      publicStreamPath: "/voice/stream",
    },
  ])(
    "mounts and cleans up the enabled $name stream path",
    async ({ config, streamPath, publicStreamPath }) => {
      runCommandMock.mockImplementation(async (command: string[]) =>
        command[1] === "status"
          ? commandResult({
              stdout: JSON.stringify({ Self: { DNSName: "bot.example.ts.net." } }),
            })
          : commandResult(),
      );
      const voiceCallConfig = {
        tailscale: { mode: "funnel", port: 443, path: "/edge/voice/webhook" },
        serve: { port: 8787, path: "/voice/webhook" },
        realtime: { enabled: false },
        streaming: { enabled: false },
        ...config,
      } as never;

      await setupTailscaleExposure(voiceCallConfig);
      await cleanupTailscaleExposure(voiceCallConfig);

      expect(runCommandMock).toHaveBeenCalledWith(
        [
          "tailscale",
          "funnel",
          "--bg",
          "--yes",
          "--set-path",
          publicStreamPath,
          `http://127.0.0.1:8787${streamPath}`,
        ],
        expect.any(Object),
      );
      expect(runCommandMock).toHaveBeenCalledWith(
        ["tailscale", "funnel", "off", publicStreamPath],
        expect.any(Object),
      );
    },
  );

  it("uses HTTPS 8443 for legacy webhook and realtime routes and cleanup", async () => {
    runCommandMock.mockImplementation(async (command: string[]) =>
      command[1] === "status"
        ? commandResult({
            stdout: JSON.stringify({ Self: { DNSName: "bot.example.ts.net." } }),
          })
        : commandResult(),
    );
    const config = {
      tailscale: { mode: "funnel", port: 8443, path: "/voice/webhook" },
      serve: { port: 8787, path: "/voice/webhook" },
      realtime: { enabled: true, streamPath: "/voice/stream/realtime" },
      streaming: { enabled: false },
    } as never;

    await expect(setupTailscaleExposure(config)).resolves.toBe(
      "https://bot.example.ts.net:8443/voice/webhook",
    );
    await cleanupTailscaleExposure(config);

    expect(runCommandMock.mock.calls.map(([command]) => command)).toEqual([
      ["tailscale", "status", "--json", "--peers=false"],
      [
        "tailscale",
        "funnel",
        "--bg",
        "--yes",
        "--https",
        "8443",
        "--set-path",
        "/voice/webhook",
        "http://127.0.0.1:8787/voice/webhook",
      ],
      [
        "tailscale",
        "funnel",
        "--bg",
        "--yes",
        "--https",
        "8443",
        "--set-path",
        "/voice/stream/realtime",
        "http://127.0.0.1:8787/voice/stream/realtime",
      ],
      [
        "tailscale",
        "funnel",
        "--bg",
        "--yes",
        "--https",
        "8443",
        "--set-path",
        "/voice/webhook",
        "off",
      ],
      [
        "tailscale",
        "funnel",
        "--bg",
        "--yes",
        "--https",
        "8443",
        "--set-path",
        "/voice/stream/realtime",
        "off",
      ],
    ]);
  });

  it("deduplicates equal realtime and streaming paths", async () => {
    runCommandMock.mockImplementation(async (command: string[]) =>
      command[1] === "status"
        ? commandResult({
            stdout: JSON.stringify({ Self: { DNSName: "bot.example.ts.net." } }),
          })
        : commandResult(),
    );
    const config = {
      tailscale: { mode: "funnel", port: 443, path: "/voice/webhook" },
      serve: { port: 8787, path: "/voice/webhook" },
      realtime: { enabled: true, streamPath: "/voice/stream" },
      streaming: { enabled: true, streamPath: "/voice/stream" },
    } as never;

    await setupTailscaleExposure(config);

    const streamMounts = runCommandMock.mock.calls.filter(
      ([command]) => command[5] === "/voice/stream",
    );
    expect(streamMounts).toHaveLength(1);
  });

  it("rolls back direct exposure when a stream route cannot be mounted", async () => {
    runCommandMock.mockImplementation(async (command: string[]) => {
      if (command[1] === "status") {
        return commandResult({
          stdout: JSON.stringify({ Self: { DNSName: "bot.example.ts.net." } }),
        });
      }
      if (command[1] === "funnel" && command[5] === "/voice/stream/realtime") {
        return commandResult({ code: 1 });
      }
      return commandResult();
    });
    const config = {
      tailscale: { mode: "funnel", port: 443, path: "/voice/webhook" },
      serve: { port: 8787, path: "/voice/webhook" },
      realtime: { enabled: true, streamPath: "/voice/stream/realtime" },
      streaming: { enabled: false },
    } as never;

    await expect(setupTailscaleExposure(config)).resolves.toBeNull();
    expect(runCommandMock).toHaveBeenCalledWith(
      ["tailscale", "funnel", "off", "/voice/webhook"],
      expect.any(Object),
    );
  });
});

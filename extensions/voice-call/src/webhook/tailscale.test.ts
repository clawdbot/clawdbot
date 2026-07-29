// Voice Call tests cover bounded Tailscale command execution.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runCommandMock } = vi.hoisted(() => ({ runCommandMock: vi.fn() }));

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  runCommandWithTimeout: runCommandMock,
}));

import {
  cleanupTailscaleExposure,
  cleanupTailscaleExposureRoute,
  getTailscaleDnsName,
  getTailscaleSelfInfo,
  setupTailscaleExposure,
  setupTailscaleExposureRoute,
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
    await expect(getTailscaleDnsName()).resolves.toBe("bot.example.ts.net");
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
      setupTailscaleExposureRoute({
        mode: "serve",
        path: "/voice",
        localUrl: "http://127.0.0.1:8787/webhook",
      }),
    ).resolves.toBe("https://bot.example.ts.net/voice");
    await cleanupTailscaleExposureRoute({ mode: "serve", path: "/voice" });

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
    runCommandMock
      .mockResolvedValueOnce(
        commandResult({ stdout: JSON.stringify({ Self: { DNSName: "bot.example.ts.net." } }) }),
      )
      .mockResolvedValueOnce(commandResult())
      .mockResolvedValueOnce(commandResult());

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
});

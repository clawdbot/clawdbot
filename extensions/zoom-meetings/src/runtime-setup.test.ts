import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import { zoomMeetingsConfig } from "./config.js";
import { getZoomMeetingsSetupStatus } from "./runtime-setup.js";

const resolveZoomMeetingsConfig = zoomMeetingsConfig.resolveConfig;

function runtimeWithNode(invoke: (params: Record<string, unknown>) => Promise<unknown>) {
  return {
    nodes: {
      invoke: vi.fn(invoke),
      list: vi.fn(async () => ({
        nodes: [
          {
            caps: ["browser"],
            commands: ["browser.proxy", "zoommeetings.chrome"],
            connected: true,
            displayName: "zoom-node",
            nodeId: "node-1",
          },
        ],
      })),
    },
  } as unknown as PluginRuntime;
}

describe("Zoom meetings runtime setup", () => {
  it("accepts fresh-tab launch when existing-tab reuse is disabled", async () => {
    const status = await getZoomMeetingsSetupStatus({
      config: resolveZoomMeetingsConfig({
        defaultMode: "transcribe",
        chrome: { launch: true, reuseExistingTab: false },
      }),
      fullConfig: {},
      runtime: {} as PluginRuntime,
      options: { mode: "transcribe", transport: "chrome" },
    });

    expect(status.checks).toContainEqual({
      id: "guest-join",
      message: "Guest name, auto-join, and a Chrome launch or reuse path are configured",
      ok: true,
    });
    expect(status.ok).toBe(true);
  });

  it("probes remote talk-back prerequisites through the selected Chrome node", async () => {
    const runtime = runtimeWithNode(async () => ({ ok: true }));
    const config = resolveZoomMeetingsConfig({
      chromeNode: { node: "zoom-node" },
    });
    const status = await getZoomMeetingsSetupStatus({
      config,
      fullConfig: {},
      runtime,
      options: { mode: "agent", transport: "chrome-node" },
    });

    expect(runtime.nodes.invoke).toHaveBeenCalledWith({
      command: "zoommeetings.chrome",
      nodeId: "node-1",
      params: {
        action: "setup",
        audioBackend: "auto",
        audioBufferBytes: 4_096,
        audioFormat: "pcm16-24khz",
      },
      timeoutMs: 12_000,
    });
    expect(status.checks).toContainEqual({
      id: "chrome-node-audio-prerequisites",
      message: "Remote virtual audio backend and command-pair prerequisites are ready",
      ok: true,
    });
    expect(status.ok).toBe(true);
  });

  it("fails setup when the remote prerequisite probe fails", async () => {
    const runtime = runtimeWithNode(async () => {
      throw new Error("SoX audio command not found on the node.");
    });
    const status = await getZoomMeetingsSetupStatus({
      config: resolveZoomMeetingsConfig({ chromeNode: { node: "zoom-node" } }),
      fullConfig: {},
      runtime,
      options: { mode: "bidi", transport: "chrome-node" },
    });

    expect(status.ok).toBe(false);
    expect(status.checks).toContainEqual({
      id: "chrome-node-audio-prerequisites",
      message: "SoX audio command not found on the node.",
      ok: false,
    });
  });

  it("returns structured diagnostics when local talk-back is unsupported", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const runCommandWithTimeout = vi.fn();
    try {
      const status = await getZoomMeetingsSetupStatus({
        config: resolveZoomMeetingsConfig({}),
        fullConfig: {},
        runtime: { system: { runCommandWithTimeout } } as unknown as PluginRuntime,
        options: { mode: "agent", transport: "chrome" },
      });

      expect(status.ok).toBe(false);
      expect(status.checks).toContainEqual({
        id: "chrome-local-audio-device",
        message: expect.stringContaining("unsupported on win32"),
        ok: false,
      });
      expect(status.checks.some((check) => check.id === "chrome-local-audio-commands")).toBe(false);
      expect(runCommandWithTimeout).not.toHaveBeenCalled();
    } finally {
      platform.mockRestore();
    }
  });
});

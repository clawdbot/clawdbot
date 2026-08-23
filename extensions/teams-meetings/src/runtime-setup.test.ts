import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import { teamsMeetingsConfig } from "./config.js";
import { getTeamsMeetingsSetupStatus } from "./runtime-setup.js";

const resolveTeamsMeetingsConfig = teamsMeetingsConfig.resolveConfig;

function runtimeWithNode(invoke: (params: Record<string, unknown>) => Promise<unknown>) {
  return {
    nodes: {
      invoke: vi.fn(invoke),
      list: vi.fn(async () => ({
        nodes: [
          {
            caps: ["browser"],
            commands: ["browser.proxy", "teamsmeetings.chrome"],
            connected: true,
            displayName: "teams-node",
            nodeId: "node-1",
          },
        ],
      })),
    },
  } as unknown as PluginRuntime;
}

describe("Microsoft Teams meetings runtime setup", () => {
  it("probes remote talk-back prerequisites through the selected Chrome node", async () => {
    const runtime = runtimeWithNode(async () => ({ ok: true }));
    const config = resolveTeamsMeetingsConfig({
      chrome: {
        audioInputCommand: ["custom-input", "--read"],
        audioOutputCommand: ["custom-output", "--write"],
        bargeInInputCommand: ["custom-barge-in"],
      },
      chromeNode: { node: "teams-node" },
    });
    const status = await getTeamsMeetingsSetupStatus({
      config,
      fullConfig: {},
      runtime,
      options: { mode: "agent", transport: "chrome-node" },
    });

    expect(runtime.nodes.invoke).toHaveBeenCalledWith({
      command: "teamsmeetings.chrome",
      nodeId: "node-1",
      params: {
        action: "setup",
        audioBackend: "auto",
        audioBufferBytes: 4_096,
        audioFormat: "pcm16-24khz",
        audioInputCommand: ["custom-input", "--read"],
        audioOutputCommand: ["custom-output", "--write"],
        bargeInInputCommand: ["custom-barge-in"],
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
    const status = await getTeamsMeetingsSetupStatus({
      config: resolveTeamsMeetingsConfig({ chromeNode: { node: "teams-node" } }),
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
      const status = await getTeamsMeetingsSetupStatus({
        config: resolveTeamsMeetingsConfig({}),
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

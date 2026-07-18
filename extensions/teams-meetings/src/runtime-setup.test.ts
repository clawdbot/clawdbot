import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import { resolveTeamsMeetingsConfig } from "./config.js";
import { getTeamsMeetingsSetupStatus } from "./runtime-setup.js";

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
        audioInputCommand: ["custom-input", "--read"],
        audioOutputCommand: ["custom-output", "--write"],
        bargeInInputCommand: ["custom-barge-in"],
      },
      timeoutMs: 12_000,
    });
    expect(status.checks).toContainEqual({
      id: "chrome-node-audio-prerequisites",
      message: "Remote macOS, BlackHole 2ch, and SoX prerequisites are ready",
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
});

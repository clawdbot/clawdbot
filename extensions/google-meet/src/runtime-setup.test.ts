import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import { resolveGoogleMeetConfig } from "./config.js";
import { getGoogleMeetRuntimeSetupStatus } from "./runtime-setup.js";

describe("Google Meet runtime setup", () => {
  it("lets the Chrome node generate commands for its own platform", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const runtime = {
      nodes: {
        invoke,
        list: vi.fn(async () => ({
          nodes: [
            {
              caps: ["browser"],
              commands: ["browser.proxy", "googlemeet.chrome"],
              connected: true,
              displayName: "meet-node",
              nodeId: "node-1",
            },
          ],
        })),
      },
    } as unknown as PluginRuntime;

    const status = await getGoogleMeetRuntimeSetupStatus({
      config: resolveGoogleMeetConfig({ chromeNode: { node: "meet-node" } }),
      fullConfig: {},
      runtime,
      options: { mode: "agent", transport: "chrome-node" },
    });

    expect(invoke).toHaveBeenCalledWith({
      command: "googlemeet.chrome",
      nodeId: "node-1",
      params: {
        action: "setup",
        audioBackend: "auto",
        audioBufferBytes: 4_096,
        audioFormat: "pcm16-24khz",
      },
      timeoutMs: 12_000,
    });
    expect(status.ok).toBe(true);
  });
});

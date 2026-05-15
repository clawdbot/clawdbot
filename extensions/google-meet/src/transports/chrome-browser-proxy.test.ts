import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import { callBrowserProxyOnNode } from "./chrome-browser-proxy.js";

describe("Google Meet Chrome browser proxy", () => {
  it("reports malformed node proxy payloadJSON with an owned error", async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      payloadJSON: "{not json",
    }));
    const runtime = {
      nodes: {
        invoke,
      },
    } as unknown as PluginRuntime;

    await expect(
      callBrowserProxyOnNode({
        runtime,
        nodeId: "node-1",
        method: "GET",
        path: "/tabs",
        timeoutMs: 100,
      }),
    ).rejects.toThrow("Google Meet browser proxy returned malformed payloadJSON.");

    expect(invoke).toHaveBeenCalledWith({
      nodeId: "node-1",
      command: "browser.proxy",
      params: {
        method: "GET",
        path: "/tabs",
        body: undefined,
        timeoutMs: 100,
      },
      timeoutMs: 5_100,
    });
  });
});

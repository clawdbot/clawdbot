import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
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

  it("caps oversized node proxy gateway timeouts", async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      payloadJSON: JSON.stringify({ result: { ok: true } }),
    }));
    const runtime = {
      nodes: {
        invoke,
      },
    } as unknown as PluginRuntime;

    await callBrowserProxyOnNode({
      runtime,
      nodeId: "node-1",
      method: "GET",
      path: "/tabs",
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: MAX_TIMER_TIMEOUT_MS,
      }),
    );
  });
});

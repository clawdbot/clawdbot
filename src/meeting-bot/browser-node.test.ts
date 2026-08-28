import { describe, expect, it, vi } from "vitest";
import { attachBrowserNodeDelegationResolver } from "../plugins/runtime/browser-node-delegation.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { callMeetingBrowserProxyOnNode } from "./browser-node.js";

const adapter = {
  displayName: "Test meeting",
  nodeCommandName: "test-meeting.chrome",
  nodeConfigPath: "plugins.entries.test-meeting.config.chromeNode.node",
};

describe("meeting browser node routes", () => {
  it("routes the legacy node helper through the Browser Gateway without host fallback", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const runtime = {
      gateway: {
        isAvailable: vi.fn(async () => true),
        request,
      },
    } as unknown as PluginRuntime;

    await callMeetingBrowserProxyOnNode({
      runtime,
      adapter,
      nodeId: "node-1",
      method: "GET",
      path: "/tabs",
      timeoutMs: 1_000,
    });

    expect(request).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        allowAutomaticHostFallback: false,
        legacyMeetingRuntime: true,
        nodeId: "node-1",
      }),
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
  });

  it("uses the attached Browser-owned capability before the compatibility route", async () => {
    const runtime = {
      gateway: {
        isAvailable: vi.fn(async () => true),
        request: vi.fn(),
      },
    } as unknown as PluginRuntime;
    const request = vi.fn(async () => ({ ok: true }));
    attachBrowserNodeDelegationResolver(runtime, () => ({ request }));

    await callMeetingBrowserProxyOnNode({
      runtime,
      adapter,
      nodeId: "node-1",
      browserRouting: "browser-steward",
      method: "DELETE",
      path: "/tabs/tab-1",
      timeoutMs: 1_000,
    });

    expect(request).toHaveBeenCalledWith({
      method: "DELETE",
      path: "/tabs/tab-1",
      timeoutMs: 1_000,
      nodeId: "node-1",
    });
    expect(runtime.gateway.request).not.toHaveBeenCalled();
  });

  it("fails closed when the legacy node route has no Browser Gateway", async () => {
    const runtime = {
      gateway: {
        isAvailable: vi.fn(async () => false),
        request: vi.fn(),
      },
    } as unknown as PluginRuntime;

    await expect(
      callMeetingBrowserProxyOnNode({
        runtime,
        adapter,
        nodeId: "node-1",
        method: "GET",
        path: "/tabs",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("Test meeting Browser Gateway is unavailable");
  });
});

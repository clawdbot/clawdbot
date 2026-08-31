import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startA2aGatewayAccount } from "./gateway.js";
import { setA2aChannelRuntime } from "./runtime.js";
import type { ResolvedA2aChannelAccount } from "./types.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

function createA2aGatewayFixture() {
  const registry = createTestRegistry([]);
  setActivePluginRegistry(registry);
  const runtime = createPluginRuntimeMock();
  setA2aChannelRuntime(runtime);
  const controller = new AbortController();
  const account: ResolvedA2aChannelAccount = {
    accountId: "default",
    enabled: true,
    configured: true,
    config: { peers: { hermes: { token: "test-token" } } },
  };
  const statusPatchSink = vi.fn();
  const ctx = createStartAccountContext({
    account,
    abortSignal: controller.signal,
    statusPatchSink,
  });
  ctx.channelRuntime = runtime.channel;
  return { registry, runtime, controller, account, statusPatchSink, ctx };
}

describe("A2A gateway account lifecycle", () => {
  it("registers exact plugin-owned routes and removes them when the account stops", async () => {
    const fixture = createA2aGatewayFixture();
    const lifecycle = startA2aGatewayAccount(fixture.ctx);

    expect(fixture.registry.httpRoutes).toEqual([
      expect.objectContaining({
        path: "/.well-known/agent-card.json",
        auth: "plugin",
        match: "exact",
        pluginId: "a2a",
      }),
      expect.objectContaining({
        path: "/.well-known/agent.json",
        auth: "plugin",
        match: "exact",
        pluginId: "a2a",
      }),
      expect.objectContaining({
        path: "/a2a/v1",
        auth: "plugin",
        match: "exact",
        pluginId: "a2a",
      }),
    ]);
    expect(fixture.ctx.getStatus()).toEqual(
      expect.objectContaining({ lifecycle: "ready", connected: true }),
    );

    fixture.controller.abort();
    await lifecycle;

    expect(fixture.registry.httpRoutes).toEqual([]);
    expect(fixture.ctx.getStatus()).toEqual(
      expect.objectContaining({ lifecycle: "stopped", running: false, connected: false }),
    );
  });

  it("rolls back already registered routes when a later route belongs to another plugin", async () => {
    const fixture = createA2aGatewayFixture();
    const releaseConflict = registerPluginHttpRoute({
      path: "/.well-known/agent.json",
      auth: "plugin",
      match: "exact",
      pluginId: "other-plugin",
      handler: () => true,
      throwOnFailure: true,
    });

    await expect(startA2aGatewayAccount(fixture.ctx)).rejects.toThrow(/other-plugin/);

    expect(fixture.registry.httpRoutes).toEqual([
      expect.objectContaining({
        path: "/.well-known/agent.json",
        pluginId: "other-plugin",
      }),
    ]);
    expect(fixture.ctx.getStatus()).toEqual(
      expect.objectContaining({ lifecycle: "stopped", running: false }),
    );
    releaseConflict();
  });

  it("fails closed without configured peers instead of exposing discovery routes", async () => {
    const fixture = createA2aGatewayFixture();
    fixture.account.configured = false;

    await expect(startA2aGatewayAccount(fixture.ctx)).rejects.toThrow(/not configured/);

    expect(fixture.registry.httpRoutes).toEqual([]);
  });
});

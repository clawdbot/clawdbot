import { describe, expect, it, vi } from "vitest";
import { createPluginRegistry } from "./registry.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-fixtures.js";

const hookTurn = {
  name: "Inbox watcher",
  agentId: "mail",
  sessionKey: "hook:imap:account:1",
  message: "Summarize the incoming email.",
  externalContentSource: "email",
  deliver: false,
} satisfies Parameters<PluginRuntime["hooks"]["dispatchHookAgentTurn"]>[0];

describe("plugin runtime hook dispatch ownership", () => {
  it("rejects an untrusted plugin before exposing Gateway cron capability", () => {
    const getCron = vi.fn(() => undefined);
    const builder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createPluginRuntime({
        gateway: {
          isAvailable: async () => true,
          getCron,
          request: async <T = unknown>(): Promise<T> => {
            throw new Error("Gateway request should not run in this test");
          },
        },
      }),
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({ id: "untrusted-cron", origin: "workspace" });
    const api = builder.createApi(record, { config: {} });
    builder.registry.plugins.push(record);

    expect(() => api.runtime.gateway.getCron?.()).toThrow(
      'getCron is only available for trusted plugins in this release. Plugin "untrusted-cron" loaded with origin "workspace"',
    );
    expect(getCron).not.toHaveBeenCalled();
  });

  it.each([
    { origin: "bundled" as const, trustedOfficialInstall: undefined },
    { origin: "global" as const, trustedOfficialInstall: true },
  ])("binds $origin hook dispatch to its host-owned plugin identity", async (ownership) => {
    let observedPluginId: string | undefined;
    const dispatchHookAgentTurn = vi.fn(async () => {
      observedPluginId = getPluginRuntimeGatewayRequestScope()?.pluginId;
      return { ok: true as const, runId: "hook-run" };
    });
    const builder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createPluginRuntime({ hooks: { dispatchHookAgentTurn } }),
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({ id: "trusted-mail", ...ownership });
    const api = builder.createApi(record, { config: {} });
    builder.registry.plugins.push(record);

    await expect(api.runtime.hooks.dispatchHookAgentTurn(hookTurn)).resolves.toEqual({
      ok: true,
      runId: "hook-run",
    });
    expect(observedPluginId).toBe("trusted-mail");
    expect(dispatchHookAgentTurn).toHaveBeenCalledWith(hookTurn);
  });

  it("rejects an untrusted hook dispatch before reaching the Gateway owner", async () => {
    const dispatchHookAgentTurn = vi.fn(async () => ({
      ok: true as const,
      runId: "unexpected",
    }));
    const builder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createPluginRuntime({ hooks: { dispatchHookAgentTurn } }),
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({ id: "untrusted-mail", origin: "workspace" });
    const api = builder.createApi(record, { config: {} });
    builder.registry.plugins.push(record);

    await expect(api.runtime.hooks.dispatchHookAgentTurn(hookTurn)).rejects.toThrow(
      'dispatchHookAgentTurn is only available for trusted plugins in this release. Plugin "untrusted-mail" loaded with origin "workspace"',
    );
    expect(dispatchHookAgentTurn).not.toHaveBeenCalled();
  });
});

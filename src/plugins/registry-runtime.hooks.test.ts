import { describe, expect, it, vi } from "vitest";
import { createLazyPluginRuntime } from "./loader-module-runtime.js";
import { createPluginRegistry } from "./registry.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
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

function createHookRuntime(hooks: PluginRuntime["hooks"]): PluginRuntime {
  return createLazyPluginRuntime({
    runtimeOptions: { hooks },
    loadPluginModule: () => {
      throw new Error("Prepared hooks must not load the broad runtime");
    },
  });
}

describe("plugin runtime hook dispatch ownership", () => {
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
      runtime: createHookRuntime({ dispatchHookAgentTurn }),
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
      runtime: createHookRuntime({ dispatchHookAgentTurn }),
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({ id: "untrusted-mail", origin: "workspace" });
    const api = builder.createApi(record, { config: {} });
    builder.registry.plugins.push(record);

    await expect(api.runtime.hooks.dispatchHookAgentTurn(hookTurn)).rejects.toThrow(
      'reason=record-missing; registryPath=null; origin="workspace"',
    );
    expect(dispatchHookAgentTurn).not.toHaveBeenCalled();
  });
});

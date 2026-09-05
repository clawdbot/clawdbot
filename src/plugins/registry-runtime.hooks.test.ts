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

describe("plugin runtime dispatch ownership", () => {
  it.each([
    { surface: "hooks" as const, origin: "bundled" as const, trustedOfficialInstall: undefined },
    { surface: "hooks" as const, origin: "global" as const, trustedOfficialInstall: true },
    { surface: "subagent" as const, origin: "bundled" as const, trustedOfficialInstall: undefined },
  ])(
    "binds $origin $surface dispatch to its exact host-owned plugin instance",
    async (ownership) => {
      let observedScope = getPluginRuntimeGatewayRequestScope();
      const observeScope = async () => {
        await Promise.resolve();
        observedScope = getPluginRuntimeGatewayRequestScope();
      };
      const dispatchHookAgentTurn = vi.fn(async () => {
        await observeScope();
        return { ok: true as const, runId: "hook-run" };
      });
      const complete = vi.fn(async () => {
        await observeScope();
        return { text: "completed" };
      });
      const runtime = createPluginRuntime({ hooks: { dispatchHookAgentTurn } });
      runtime.subagent.complete = complete;
      const completionRequest = { agentId: hookTurn.agentId, message: hookTurn.message };
      const captureCall = (scopedRuntime: PluginRuntime) => {
        const surface = scopedRuntime[ownership.surface];
        return async () =>
          "dispatchHookAgentTurn" in surface
            ? await surface.dispatchHookAgentTurn(hookTurn)
            : await surface.complete(completionRequest);
      };
      const expected =
        ownership.surface === "hooks" ? { ok: true, runId: "hook-run" } : { text: "completed" };
      const dispatched = ownership.surface === "hooks" ? dispatchHookAgentTurn : complete;
      const builder = createPluginRegistry({
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        runtime,
        activateGlobalSideEffects: false,
      });
      const record = createPluginRecord({ id: "trusted-mail", ...ownership });
      const api = builder.createApi(record, { config: {} });
      builder.registry.plugins.push(record);

      await expect(captureCall(api.runtime)()).resolves.toEqual(expected);
      expect(observedScope).toMatchObject({
        pluginId: "trusted-mail",
        pluginSource: record.source,
      });
      expect(observedScope?.pluginRegistry).toBe(builder.registry);
      expect(dispatched).toHaveBeenCalledWith(
        ownership.surface === "hooks" ? hookTurn : completionRequest,
      );

      const retained = captureCall(api.runtime);
      builder.rollbackPluginGlobalSideEffects(record.id, record);
      const replacement = createPluginRecord({
        id: record.id,
        ...ownership,
        source: "/tmp/replacement/index.ts",
      });
      builder.registry.plugins.splice(0, 1, replacement);
      const replacementApi = builder.createApi(replacement, { config: {} });
      await expect(captureCall(replacementApi.runtime)()).resolves.toEqual(expected);
      expect(observedScope?.pluginSource).toBe(replacement.source);
      await expect(retained()).rejects.toThrow("no longer active");
      expect(dispatched).toHaveBeenCalledTimes(2);
    },
  );

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
      'reason=record-missing; registryPath=null; origin="workspace"',
    );
    expect(dispatchHookAgentTurn).not.toHaveBeenCalled();
  });
});

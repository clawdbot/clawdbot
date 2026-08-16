import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withTempHome } from "../plugin-sdk/test-env.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";

function createTestRegistry(runtime: ReturnType<typeof createPluginRuntime>) {
  return createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime,
    activateGlobalSideEffects: false,
  });
}

describe("plugin registry SQLite session ownership", () => {
  it("keeps embedded incognito ID scans in the key's agent store", async () => {
    await withTempHome(async (home) => {
      const sessionKey = "agent:researcher:dashboard:incognito-ownership-check";
      const sessionId = "incognito-session";
      const lockedKey = "agent:researcher:dashboard:incognito-locked-owner";
      const lockedSessionId = "locked-incognito-session";
      try {
        await replaceSessionEntry(
          { agentId: "researcher", sessionKey },
          { sessionId, updatedAt: 1 },
        );
        await replaceSessionEntry(
          { agentId: "researcher", sessionKey: lockedKey },
          {
            sessionId: lockedSessionId,
            updatedAt: 2,
            agentHarnessId: "test-harness",
            modelSelectionLocked: true,
          },
        );

        const runtime = createPluginRuntime();
        const runEmbeddedAgent = vi.fn(async () => ({
          ok: true,
        })) as unknown as PluginRuntime["agent"]["runEmbeddedAgent"];
        Object.defineProperty(runtime.agent, "runEmbeddedAgent", {
          configurable: true,
          value: runEmbeddedAgent,
        });
        const pluginRegistry = createTestRegistry(runtime);
        const ownerRecord = createPluginRecord({
          id: "harness-owner",
          source: "/plugins/harness-owner/index.js",
          origin: "bundled",
          enabled: true,
          configSchema: false,
        });
        const callerRecord = createPluginRecord({
          id: "extractor-plugin",
          source: "/plugins/extractor-plugin/index.js",
          origin: "bundled",
          enabled: true,
          configSchema: false,
        });
        const ownerApi = pluginRegistry.createApi(ownerRecord, { config: {} as OpenClawConfig });
        const callerApi = pluginRegistry.createApi(callerRecord, {
          config: {} as OpenClawConfig,
        });
        ownerApi.registerAgentHarness({
          id: "test-harness",
          label: "Test Harness",
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("unused");
          },
        });
        const runParams = {
          sessionId,
          sessionKey,
          workspaceDir: path.join(home, "workspace"),
          prompt: "continue",
          timeoutMs: 1,
          runId: "run-1",
        } as Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0];

        await expect(callerApi.runtime.agent.runEmbeddedAgent(runParams)).resolves.toEqual({
          ok: true,
        });
        await expect(
          callerApi.runtime.agent.runEmbeddedAgent({ ...runParams, agentId: "main" }),
        ).rejects.toThrow('does not match session key agent "researcher"');
        await expect(
          callerApi.runtime.agent.runEmbeddedAgent({
            ...runParams,
            sessionId: lockedSessionId,
          }),
        ).rejects.toThrow('owned by plugin "harness-owner"');
        expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      } finally {
        closeOpenClawAgentDatabasesForTest();
      }
    });
  });
});

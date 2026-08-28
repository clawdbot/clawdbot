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
  it("does not read runtime config before a logical session requires it", () => {
    const runtime = createPluginRuntime();
    const readConfig = vi.fn(() => {
      throw new Error("runtime config was accessed eagerly");
    });
    Object.defineProperty(runtime, "config", { configurable: true, get: readConfig });

    expect(() => createTestRegistry(runtime)).not.toThrow();
    expect(readConfig).not.toHaveBeenCalled();
  });

  it("resolves unscoped worker keys through the configured default agent", async () => {
    await withTempHome(async () => {
      const config = {
        agents: { list: [{ id: "researcher", default: true }] },
      } as OpenClawConfig;
      const subagent = {
        run: vi.fn(async () => ({ runId: "workboard-run" })),
        waitForRun: vi.fn(async () => ({ status: "ok" as const })),
        getSessionMessages: vi.fn(async () => ({ messages: [] })),
        deleteSession: vi.fn(async () => {}),
      } satisfies PluginRuntime["subagent"];
      const runtime = createPluginRuntime({ subagent });
      runtime.config = { ...runtime.config, current: () => config };
      const pluginRegistry = createTestRegistry(runtime);
      const record = createPluginRecord({
        id: "workboard",
        source: "/plugins/workboard/index.js",
        origin: "bundled",
        enabled: true,
        configSchema: false,
      });
      const api = pluginRegistry.createApi(record, { config });
      const ownerRecord = createPluginRecord({
        id: "harness-owner",
        source: "/plugins/harness-owner/index.js",
        origin: "bundled",
        enabled: true,
        configSchema: false,
      });
      const ownerApi = pluginRegistry.createApi(ownerRecord, { config });
      ownerApi.registerAgentHarness({
        id: "test-harness",
        label: "Test Harness",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("unused");
        },
      });

      try {
        const sessionKey = "subagent:workboard-default-unassigned";
        await expect(api.runtime.subagent.run({ sessionKey, message: "start" })).resolves.toEqual({
          runId: "workboard-run",
        });
        expect(subagent.run).toHaveBeenCalledWith({ sessionKey, message: "start" });

        for (const invalidSessionKey of ["agent::malformed", "global", "unknown"]) {
          await expect(
            api.runtime.subagent.run({ sessionKey: invalidSessionKey, message: "reject" }),
          ).rejects.toThrow("Cannot resolve SQLite session scope without an agent id");
        }

        const lockedSessionKey = "harness:test-harness:owned";
        await replaceSessionEntry(
          { agentId: "researcher", sessionKey: `agent:researcher:${lockedSessionKey}` },
          {
            sessionId: "owned-session",
            updatedAt: 1,
            agentHarnessId: "test-harness",
            modelSelectionLocked: true,
          },
        );
        await expect(
          api.runtime.subagent.run({ sessionKey: lockedSessionKey, message: "continue" }),
        ).rejects.toThrow('owned by plugin "harness-owner"');
        expect(subagent.run).toHaveBeenCalledOnce();
      } finally {
        closeOpenClawAgentDatabasesForTest();
      }
    });
  });

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

// Verifies plugin runtime session ownership and execution admission.
import { describe, expect, it, vi } from "vitest";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";

function createTestRegistry(runtime: PluginRuntime) {
  return createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime,
    activateGlobalSideEffects: false,
  });
}

describe("plugin registry runtime session ownership", () => {
  it("resolves persisted runtime requests at the plugin execution boundary", async () => {
    const sessionKey = "agent:worker:voice";
    const entry: SessionEntry = {
      sessionId: "voice-session",
      updatedAt: 1,
      pluginOwnerId: "voice-call",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      modelProvider: "anthropic",
      model: "previous-model",
    };
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "anthropic/default-model" } },
        entries: { worker: { model: { primary: "openai/worker-model" } } },
      },
    };
    const runtime = createPluginRuntime();
    runtime.config.current = () => cfg;
    runtime.agent.session.getSessionEntry = vi.fn(() => entry);
    runtime.agent.session.listSessionEntries = vi.fn(() => [{ sessionKey, entry }]);
    let executionScope = getPluginRuntimeGatewayRequestScope();
    const runEmbeddedAgent = vi.fn<PluginRuntime["agent"]["runEmbeddedAgent"]>(async () => {
      executionScope = getPluginRuntimeGatewayRequestScope();
      return { meta: { durationMs: 0 } };
    });
    Object.defineProperty(runtime.agent, "runEmbeddedAgent", { value: runEmbeddedAgent });
    const pluginRegistry = createTestRegistry(runtime);
    const createApi = (id: string) =>
      pluginRegistry.createApi(
        createPluginRecord({
          id,
          source: `/plugins/${id}/index.js`,
          origin: "bundled",
          enabled: true,
          configSchema: false,
        }),
        { config: cfg },
      );
    const api = createApi("voice-call");
    const otherApi = createApi("other-plugin");
    const runParams = {
      sessionId: entry.sessionId,
      sessionKey,
      agentId: "worker",
      workspaceDir: "/tmp",
      prompt: "continue",
      timeoutMs: 1,
      runId: "voice-run",
      sessionTarget: {
        sessionId: entry.sessionId,
        sessionKey,
        agentId: "worker",
        storePath: "/tmp/sessions.json",
      },
    } satisfies Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0];
    const cases: Array<{
      name: string;
      storedRuntime?: string;
      request: Partial<Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0]>;
      expected?: string;
    }> = [
      { name: "stored request", storedRuntime: "openclaw", request: {}, expected: "openclaw" },
      { name: "agent default provider", storedRuntime: "codex", request: {}, expected: "codex" },
      {
        name: "request config provider",
        storedRuntime: "codex",
        request: { config: { agents: { defaults: { model: "anthropic/request-model" } } } },
      },
      { name: "incompatible provider", storedRuntime: "codex", request: { provider: "anthropic" } },
      { name: "model-ref provider", storedRuntime: "codex", request: { model: "anthropic/other" } },
      {
        name: "explicit runtime",
        storedRuntime: "codex",
        request: { agentHarnessRuntimeOverride: "openclaw" },
        expected: "openclaw",
      },
      {
        name: "explicit auto",
        storedRuntime: "codex",
        request: { agentHarnessRuntimeOverride: "auto" },
        expected: "auto",
      },
      { name: "detached", storedRuntime: "codex", request: { sessionPersistence: "detached" } },
      { name: "raw model", storedRuntime: "codex", request: { modelRun: true } },
      { name: "observation only", request: {} },
    ];
    for (const scenario of cases) {
      entry.agentRuntimeOverride = scenario.storedRuntime;
      await api.runtime.agent.runEmbeddedAgent({ ...runParams, ...scenario.request });
      const forwarded = runEmbeddedAgent.mock.calls.at(-1)?.[0];
      expect(forwarded?.agentHarnessId, scenario.name).toBeUndefined();
      expect(forwarded?.agentHarnessRuntimeOverride, scenario.name).toBe(scenario.expected);
      expect(executionScope?.pluginId, scenario.name).toBe("voice-call");
    }
    await expect(otherApi.runtime.agent.runEmbeddedAgent(runParams)).rejects.toThrow(
      'owned by plugin "voice-call"',
    );
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(cases.length);
  });

  it("limits locked harness session mutation and execution to the harness owner", async () => {
    const reservedKey = "agent:main:harness:codex:thread-1";
    const ordinaryKey = "agent:main:ordinary";
    const ordinaryAliasKey = "agent:main:ordinary-alias";
    const ordinaryNoIdKey = "agent:main:ordinary-no-id";
    const lockedNoIdKey = "agent:main:locked-no-id";
    const lockedOrdinaryKey = "agent:main:ordinary-locked";
    const legacyPrefixedKey = "agent:main:harness:notes";
    const pluginOwnedKey = "agent:main:plugin-owned";
    const mixedOwnerKey = "agent:main:harness:codex:mixed-owner";
    const reservedEntry = {
      sessionId: "reserved-session",
      sessionFile: formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: "reserved-session",
        storePath: "/tmp/sessions.json",
      }),
      updatedAt: 1,
      agentHarnessId: "codex",
      modelSelectionLocked: true as const,
    };
    const ordinaryEntry = { sessionId: "ordinary-session", updatedAt: 1 };
    const ordinaryAliasEntry = { sessionId: reservedEntry.sessionId, updatedAt: 1 };
    const ordinaryNoIdEntry = { updatedAt: 1 };
    const lockedNoIdEntry = {
      updatedAt: 1,
      agentHarnessId: "codex",
      modelSelectionLocked: true as const,
    };
    const lockedOrdinaryEntry = {
      sessionId: "locked-ordinary-session",
      updatedAt: 1,
      agentHarnessId: "codex",
      modelSelectionLocked: true as const,
    };
    const legacyPrefixedEntry = {
      sessionId: "legacy-prefixed-session",
      updatedAt: 1,
      agentHarnessId: "legacy-runtime",
    };
    const pluginOwnedEntry = {
      sessionId: "plugin-owned-session",
      updatedAt: 1,
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      pluginOwnerId: "other-plugin",
    };
    const entries = {
      [pluginOwnedKey]: pluginOwnedEntry,
      [mixedOwnerKey]: { ...pluginOwnedEntry, sessionId: "mixed-owner-session" },
      [ordinaryAliasKey]: ordinaryAliasEntry,
      [ordinaryNoIdKey]: ordinaryNoIdEntry,
      [lockedNoIdKey]: lockedNoIdEntry,
      [reservedKey]: reservedEntry,
      [ordinaryKey]: ordinaryEntry,
      [lockedOrdinaryKey]: lockedOrdinaryEntry,
      [legacyPrefixedKey]: legacyPrefixedEntry,
    };
    const typedEntries = entries as unknown as Record<string, SessionEntry>;
    const subagent = {
      run: vi.fn(async () => ({ runId: "subagent-run" })),
      waitForRun: vi.fn(async () => ({ status: "ok" as const })),
      getSessionMessages: vi.fn(async () => ({ messages: [] })),
      deleteSession: vi.fn(async () => {}),
    } satisfies PluginRuntime["subagent"];
    const runtime = createPluginRuntime({ subagent });
    const session = runtime.agent.session;
    session.getSessionEntry = vi.fn((params) => typedEntries[params.sessionKey]);
    session.listSessionEntries = vi.fn(() =>
      Object.entries(typedEntries).map(([sessionKey, entry]) => ({ sessionKey, entry })),
    );
    session.patchSessionEntry = vi.fn(async (params) => {
      const entry = typedEntries[params.sessionKey];
      if (!entry) {
        return null;
      }
      const patch = await params.update(structuredClone(entry), {
        existingEntry: structuredClone(entry),
      });
      return patch ? { ...entry, ...patch } : entry;
    });
    session.upsertSessionEntry = vi.fn(async () => {});
    session.updateSessionStoreEntry = vi.fn(
      async (params) => typedEntries[params.sessionKey] ?? null,
    );
    let admissionScope = getPluginRuntimeGatewayRequestScope();
    session.runWithWorkAdmission = vi.fn(async (_params, run) => {
      admissionScope = getPluginRuntimeGatewayRequestScope();
      return await run(new AbortController().signal);
    });
    let embeddedRunScope = getPluginRuntimeGatewayRequestScope();
    const runEmbeddedAgent = vi.fn(
      async (params: Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0]) => {
        if ("preparedRunAdmission" in params || "admittedRunContext" in params) {
          throw new Error("Plugin embedded-agent execution cannot supply host run authority.");
        }
        embeddedRunScope = getPluginRuntimeGatewayRequestScope();
        return { ok: true };
      },
    ) as unknown as PluginRuntime["agent"]["runEmbeddedAgent"];
    Object.defineProperties(runtime.agent, {
      runEmbeddedAgent: { configurable: true, value: runEmbeddedAgent },
    });
    const gatewayRequest = vi.fn(async () => ({ ok: true }));
    runtime.gateway = {
      isAvailable: vi.fn(async () => true),
      request: gatewayRequest as unknown as PluginRuntime["gateway"]["request"],
    };

    const pluginRegistry = createTestRegistry(runtime);
    const ownerRecord = createPluginRecord({
      id: "codex-owner",
      source: "/plugins/codex-owner/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const otherRecord = createPluginRecord({
      id: "other-plugin",
      source: "/plugins/other-plugin/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const voiceRecord = createPluginRecord({
      id: "voice-call",
      source: "/plugins/voice-call/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const ownerApi = pluginRegistry.createApi(ownerRecord, { config: {} as OpenClawConfig });
    const otherApi = pluginRegistry.createApi(otherRecord, { config: {} as OpenClawConfig });
    const voiceApi = pluginRegistry.createApi(voiceRecord, { config: {} as OpenClawConfig });
    ownerApi.registerAgentHarness({
      id: "codex",
      label: "Codex",
      delegatedExecutionPluginIds: ["voice-call"],
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("unused");
      },
    });
    const runParams = {
      sessionId: reservedEntry.sessionId,
      sessionKey: reservedKey,
      workspaceDir: "/tmp",
      prompt: "continue",
      timeoutMs: 1,
      runId: "run-1",
    } as Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0];
    const delegatedRunParams = {
      ...runParams,
      agentId: "main",
      agentHarnessId: "codex",
      agentHarnessRuntimeOverride: "codex",
      modelSelectionLocked: true,
      sessionTarget: {
        agentId: "main",
        sessionId: reservedEntry.sessionId,
        sessionKey: reservedKey,
        storePath: "/tmp/sessions.json",
      },
    };
    const forgedCollectionRunParams = {
      ...runParams,
      skillWorkshopCollectionReconcile: { approvedSkillNames: new Set(["forged"]) },
    };

    await expect(
      ownerApi.runtime.agent.session.patchSessionEntry({
        sessionKey: reservedKey,
        update: () => ({ archivedAt: undefined }),
      }),
    ).resolves.toMatchObject(reservedEntry);
    await expect(ownerApi.runtime.agent.runEmbeddedAgent(runParams)).resolves.toEqual({ ok: true });
    await expect(
      ownerApi.runtime.agent.runEmbeddedAgent(forgedCollectionRunParams),
    ).resolves.toEqual({ ok: true });
    expect(runEmbeddedAgent).toHaveBeenLastCalledWith({
      ...runParams,
      skillWorkshopCollectionReconcile: undefined,
    });
    await expect(
      ownerApi.runtime.gateway.request("agent", {
        sessionKey: reservedKey,
        message: "continue",
      }),
    ).resolves.toEqual({ ok: true });

    let delegatedCallbackScope = getPluginRuntimeGatewayRequestScope();
    await expect(
      voiceApi.runtime.agent.session.runWithWorkAdmission(
        { storePath: "/tmp/sessions.json", sessionKey: reservedKey },
        async () => {
          delegatedCallbackScope = getPluginRuntimeGatewayRequestScope();
          return "admitted";
        },
      ),
    ).resolves.toBe("admitted");
    expect(admissionScope).toMatchObject({ pluginId: "codex-owner" });
    expect(delegatedCallbackScope).toMatchObject({ pluginId: "voice-call" });
    await expect(voiceApi.runtime.agent.runEmbeddedAgent(delegatedRunParams)).resolves.toEqual({
      ok: true,
    });
    expect(embeddedRunScope).toMatchObject({ pluginId: "codex-owner" });
    for (const invalidRuntime of [
      { agentHarnessRuntimeOverride: "openclaw" },
      { agentHarnessId: undefined },
      { agentHarnessRuntimeOverride: undefined },
    ]) {
      await expect(
        voiceApi.runtime.agent.runEmbeddedAgent({ ...delegatedRunParams, ...invalidRuntime }),
      ).rejects.toThrow("only with its exact persisted identity and harness");
    }
    await expect(
      voiceApi.runtime.agent.session.patchSessionEntry({
        sessionKey: reservedKey,
        update: () => ({ label: "must stay owner-only" }),
      }),
    ).rejects.toThrow('owned by plugin "codex-owner"');

    await expect(
      otherApi.runtime.agent.session.patchSessionEntry({
        sessionKey: reservedKey,
        update: () => ({ archivedAt: undefined }),
      }),
    ).rejects.toThrow('owned by plugin "codex-owner"');
    await expect(otherApi.runtime.agent.runEmbeddedAgent(runParams)).rejects.toThrow(
      'owned by plugin "codex-owner"',
    );
    await expect(
      otherApi.runtime.agent.runEmbeddedAgent({
        ...runParams,
        sessionKey: undefined,
      } as never),
    ).rejects.toThrow('owned by plugin "codex-owner"');
    await expect(
      otherApi.runtime.agent.runEmbeddedAgent({
        ...runParams,
        sessionId: undefined,
        sessionKey: undefined,
        sessionFile: formatSqliteSessionFileMarker({
          agentId: "main",
          sessionId: reservedEntry.sessionId,
          storePath: "/tmp/sessions.json",
        }),
      } as never),
    ).rejects.toThrow('owned by plugin "codex-owner"');
    await expect(
      otherApi.runtime.agent.runEmbeddedAgent({
        ...runParams,
        sessionId: undefined,
        sessionKey: undefined,
        sessionFile: ordinaryAliasKey,
      } as never),
    ).rejects.toThrow('owned by plugin "codex-owner"');
    await expect(
      otherApi.runtime.agent.runEmbeddedAgent({
        ...runParams,
        sessionId: undefined,
        sessionKey: undefined,
        sessionFile: ordinaryNoIdKey,
      } as never),
    ).resolves.toEqual({ ok: true });
    await expect(
      otherApi.runtime.agent.runEmbeddedAgent({
        ...runParams,
        sessionId: ordinaryEntry.sessionId,
        sessionKey: ordinaryKey,
        sessionFile: reservedEntry.sessionFile,
      }),
    ).rejects.toThrow('owned by plugin "codex-owner"');
    await expect(
      otherApi.runtime.agent.runEmbeddedAgent({
        ...runParams,
        agentId: "main",
        sessionId: ordinaryEntry.sessionId,
        sessionKey: ordinaryKey,
        sessionFile: reservedEntry.sessionFile,
        sessionTarget: {
          agentId: "main",
          sessionId: ordinaryEntry.sessionId,
          sessionKey: ordinaryKey,
          storePath: "/tmp/unrelated-sessions.json",
        },
      }),
    ).rejects.toThrow("only with its exact session target identity");
    await expect(
      otherApi.runtime.subagent.run({ sessionKey: reservedKey, message: "continue" }),
    ).rejects.toThrow('owned by plugin "codex-owner"');
    await expect(
      otherApi.runtime.subagent.deleteSession({ sessionKey: reservedKey }),
    ).rejects.toThrow('owned by plugin "codex-owner"');
    await expect(
      otherApi.runtime.gateway.request("sessions.patch", {
        key: reservedKey,
        archived: true,
        expectedSessionId: reservedEntry.sessionId,
      }),
    ).rejects.toThrow('owned by plugin "codex-owner"');
    const gatewayRequestCountBeforeBatch = gatewayRequest.mock.calls.length;
    await expect(
      otherApi.runtime.gateway.request("sessions.patchMany", {
        targets: [
          { key: ordinaryKey, expectedSessionId: ordinaryEntry.sessionId },
          { key: reservedKey, expectedSessionId: reservedEntry.sessionId },
        ],
        patch: { archived: true },
      }),
    ).rejects.toThrow('owned by plugin "codex-owner"');
    expect(gatewayRequest).toHaveBeenCalledTimes(gatewayRequestCountBeforeBatch);
    await expect(
      otherApi.runtime.gateway.request("agent", {
        sessionId: reservedEntry.sessionId,
        message: "continue",
      }),
    ).rejects.toThrow('owned by plugin "codex-owner"');
    await expect(
      otherApi.runtime.agent.session.patchSessionEntry({
        sessionKey: lockedOrdinaryKey,
        update: () => ({ archivedAt: undefined }),
      }),
    ).rejects.toThrow('owned by plugin "codex-owner"');
    await expect(
      otherApi.runtime.agent.runEmbeddedAgent({
        ...runParams,
        sessionId: lockedOrdinaryEntry.sessionId,
        sessionKey: lockedOrdinaryKey,
      }),
    ).rejects.toThrow('owned by plugin "codex-owner"');
    await expect(
      otherApi.runtime.gateway.request("agent", {
        sessionKey: lockedOrdinaryKey,
        message: "continue",
      }),
    ).rejects.toThrow('owned by plugin "codex-owner"');

    await expect(
      otherApi.runtime.agent.session.patchSessionEntry({
        sessionKey: pluginOwnedKey,
        update: () => ({ label: "same plugin owner" }),
      }),
    ).resolves.toMatchObject({ ...pluginOwnedEntry, label: "same plugin owner" });
    const pluginOwnedRun = {
      ...runParams,
      sessionId: pluginOwnedEntry.sessionId,
      sessionKey: pluginOwnedKey,
    };
    await expect(otherApi.runtime.agent.runEmbeddedAgent(pluginOwnedRun)).resolves.toEqual({
      ok: true,
    });
    await expect(ownerApi.runtime.agent.runEmbeddedAgent(pluginOwnedRun)).rejects.toThrow(
      'owned by plugin "other-plugin"',
    );
    await expect(
      ownerApi.runtime.gateway.request("agent", {
        sessionKey: pluginOwnedKey,
        message: "continue",
      }),
    ).rejects.toThrow('owned by plugin "other-plugin"');
    for (const api of [ownerApi, otherApi]) {
      await expect(
        api.runtime.agent.session.patchSessionEntry({
          sessionKey: mixedOwnerKey,
          update: () => ({ label: "must not mutate" }),
        }),
      ).rejects.toThrow("mixes plugin and reserved harness ownership");
    }

    await expect(
      otherApi.runtime.agent.session.patchSessionEntry({
        sessionKey: legacyPrefixedKey,
        update: () => ({ label: "still ordinary" }),
      }),
    ).resolves.toMatchObject({ ...legacyPrefixedEntry, label: "still ordinary" });
    await expect(
      otherApi.runtime.agent.session.patchSessionEntry({
        sessionKey: legacyPrefixedKey,
        update: () => ({ agentHarnessId: "codex", modelSelectionLocked: true }),
      }),
    ).rejects.toThrow("does not match its reserved session key");
    await expect(
      otherApi.runtime.agent.session.upsertSessionEntry({
        sessionKey: legacyPrefixedKey,
        entry: { ...legacyPrefixedEntry, label: "still ordinary" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      otherApi.runtime.agent.session.upsertSessionEntry({
        sessionKey: legacyPrefixedKey,
        entry: {
          ...legacyPrefixedEntry,
          agentHarnessId: "codex",
          modelSelectionLocked: true,
        },
      }),
    ).rejects.toThrow("does not match its reserved session key");
    await expect(
      otherApi.runtime.agent.session.runWithWorkAdmission(
        { storePath: "/tmp/sessions.json", sessionKey: legacyPrefixedKey },
        async () => "admitted",
      ),
    ).resolves.toBe("admitted");
    const ownershipChangedRun = vi.fn(async () => "must-not-run");
    vi.mocked(session.getSessionEntry)
      .mockImplementationOnce(() => legacyPrefixedEntry)
      .mockImplementationOnce(() => reservedEntry);
    await expect(
      otherApi.runtime.agent.session.runWithWorkAdmission(
        { storePath: "/tmp/sessions.json", sessionKey: legacyPrefixedKey },
        ownershipChangedRun,
      ),
    ).rejects.toThrow("does not match its reserved session key");
    expect(ownershipChangedRun).not.toHaveBeenCalled();
    await expect(
      otherApi.runtime.agent.session.updateSessionStoreEntry({
        storePath: "/tmp/sessions.json",
        sessionKey: legacyPrefixedKey,
        update: () => ({ label: "still ordinary" }),
      }),
    ).resolves.toEqual(legacyPrefixedEntry);
    await expect(
      otherApi.runtime.agent.runEmbeddedAgent({
        ...runParams,
        sessionId: legacyPrefixedEntry.sessionId,
        sessionKey: legacyPrefixedKey,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      otherApi.runtime.subagent.deleteSession({ sessionKey: legacyPrefixedKey }),
    ).resolves.toBeUndefined();
    await expect(
      otherApi.runtime.gateway.request("sessions.patch", {
        key: legacyPrefixedKey,
        archived: true,
        expectedSessionId: legacyPrefixedEntry.sessionId,
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      otherApi.runtime.agent.runEmbeddedAgent({
        ...runParams,
        sessionId: ordinaryEntry.sessionId,
        sessionKey: ordinaryKey,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      otherApi.runtime.gateway.request("voicecall.start", { to: "+15550001234" }),
    ).resolves.toEqual({ ok: true });
  });
});

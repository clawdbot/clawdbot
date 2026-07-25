// Verifies plugin registry behavior with runtime config inputs.
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";
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

describe("plugin registry runtime config scope", () => {
  it("resolves plugin API paths against the plugin root", () => {
    const pluginRoot = path.join(os.tmpdir(), "openclaw-plugins", "demo");
    const pluginRegistry = createTestRegistry(createPluginRuntime());
    const record = createPluginRecord({
      id: "path-plugin",
      name: "Path Plugin",
      source: path.join(pluginRoot, "index.js"),
      rootDir: pluginRoot,
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });
    const absolute = path.resolve(pluginRoot, "..", "outside.txt");

    expect(api.resolvePath("data/cache.json")).toBe(path.join(pluginRoot, "data", "cache.json"));
    expect(api.resolvePath("./data/cache.json")).toBe(path.join(pluginRoot, "data", "cache.json"));
    expect(api.resolvePath(absolute)).toBe(absolute);
    expect(api.resolvePath("~/openclaw/plugin.txt")).toBe(resolveUserPath("~/openclaw/plugin.txt"));
  });

  it("adds plugin context to lazy runtime resolution failures", () => {
    const runtime = new Proxy({} as PluginRuntime, {
      get() {
        throw new Error("Unable to resolve plugin runtime module; loader=/tmp/openclaw-loader.js");
      },
    });
    const pluginRegistry = createTestRegistry(runtime);
    const record = createPluginRecord({
      id: "diagnostic-plugin",
      name: "Diagnostic Plugin",
      source: "/plugins/diagnostic-plugin/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });

    let thrown: unknown;
    try {
      void api.runtime.version;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("Unable to resolve plugin runtime module");
    expect(message).toContain("pluginRuntimeContext=pluginId:diagnostic-plugin");
    expect(message).toContain("property:version");
    expect(message).toContain("source:/plugins/diagnostic-plugin/index.js");
  });

  it("runs config helpers with the owning plugin scope", async () => {
    let currentScope = getPluginRuntimeGatewayRequestScope();
    let mutateScope = getPluginRuntimeGatewayRequestScope();
    let replaceScope = getPluginRuntimeGatewayRequestScope();
    const config = {} as OpenClawConfig;
    const replaceResult = {
      path: "/tmp/openclaw.json",
      previousHash: null,
      persistedHash: "persisted-hash",
      snapshot: { path: "/tmp/openclaw.json" },
      nextConfig: config,
      afterWrite: { mode: "auto" },
      followUp: { mode: "auto", requiresRestart: false },
    } as unknown as Awaited<ReturnType<PluginRuntime["config"]["replaceConfigFile"]>>;
    const mutateConfigFile: PluginRuntime["config"]["mutateConfigFile"] = async () => {
      mutateScope = getPluginRuntimeGatewayRequestScope();
      return {
        ...replaceResult,
        result: undefined,
        attempts: 1,
      };
    };
    const replaceConfigFile: PluginRuntime["config"]["replaceConfigFile"] = async () => {
      replaceScope = getPluginRuntimeGatewayRequestScope();
      return replaceResult;
    };
    const configRuntime = {
      current: vi.fn(() => {
        currentScope = getPluginRuntimeGatewayRequestScope();
        return config;
      }),
      mutateConfigFile,
      replaceConfigFile,
    } satisfies PluginRuntime["config"];
    const runtime = createPluginRuntime();
    runtime.config = configRuntime;
    const pluginRegistry = createTestRegistry(runtime);
    const record = createPluginRecord({
      id: "legacy-plugin",
      name: "Legacy Plugin",
      source: "/plugins/legacy-plugin/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const api = pluginRegistry.createApi(record, { config });

    expect(api.runtime.config.current()).toBe(config);
    await api.runtime.config.mutateConfigFile({
      afterWrite: { mode: "none", reason: "test" },
      mutate: () => undefined,
    });
    await api.runtime.config.replaceConfigFile({
      nextConfig: config,
      afterWrite: { mode: "none", reason: "test" },
    });

    expect(currentScope).toMatchObject({
      pluginId: "legacy-plugin",
      pluginSource: "/plugins/legacy-plugin/index.js",
    });
    expect(mutateScope).toMatchObject({
      pluginId: "legacy-plugin",
      pluginSource: "/plugins/legacy-plugin/index.js",
    });
    expect(replaceScope).toMatchObject({
      pluginId: "legacy-plugin",
      pluginSource: "/plugins/legacy-plugin/index.js",
    });
  });

  it("runs local service acquisition with the owning plugin scope", async () => {
    let acquireScope = getPluginRuntimeGatewayRequestScope();
    const runtime = createPluginRuntime();
    runtime.llm.acquireLocalService = vi.fn(async () => {
      acquireScope = getPluginRuntimeGatewayRequestScope();
      return undefined;
    });
    const pluginRegistry = createTestRegistry(runtime);
    const record = createPluginRecord({
      id: "memory-provider",
      name: "Memory Provider",
      source: "/plugins/memory-provider/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });

    await api.runtime.llm.acquireLocalService({
      providerId: "gpu-host",
      baseUrl: "http://127.0.0.1:11434",
    });

    expect(acquireScope).toMatchObject({ pluginId: "memory-provider" });
  });

  it("runs node helpers with the owning plugin scope", async () => {
    let listScope = getPluginRuntimeGatewayRequestScope();
    let invokeScope = getPluginRuntimeGatewayRequestScope();
    const runtime = createPluginRuntime();
    runtime.nodes = {
      list: vi.fn(async () => {
        listScope = getPluginRuntimeGatewayRequestScope();
        return { nodes: [] };
      }),
      invoke: vi.fn(async () => {
        invokeScope = getPluginRuntimeGatewayRequestScope();
        return { ok: true };
      }),
    };
    const pluginRegistry = createTestRegistry(runtime);
    const record = createPluginRecord({
      id: "google-meet",
      name: "Google Meet",
      source: "/plugins/google-meet/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });

    await api.runtime.nodes.list({ connected: true });
    await api.runtime.nodes.invoke({
      nodeId: "node-1",
      command: "browser.proxy",
      scopes: ["operator.admin"],
    });

    expect(listScope).toMatchObject({
      pluginId: "google-meet",
      pluginSource: "/plugins/google-meet/index.js",
    });
    expect(invokeScope).toMatchObject({
      pluginId: "google-meet",
      pluginSource: "/plugins/google-meet/index.js",
    });
  });

  it("runs gateway requests with the owning plugin scope", async () => {
    let requestScope = getPluginRuntimeGatewayRequestScope();
    const runtime = createPluginRuntime();
    runtime.gateway = {
      isAvailable: async () => true,
      request: async <T>() => {
        requestScope = getPluginRuntimeGatewayRequestScope();
        return { ok: true } as T;
      },
    };
    const pluginRegistry = createTestRegistry(runtime);
    const record = createPluginRecord({
      id: "google-meet",
      name: "Google Meet",
      source: "/plugins/google-meet/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });

    await api.runtime.gateway.request("voicecall.start", { to: "+15550001234" });

    expect(requestScope).toMatchObject({
      pluginId: "google-meet",
      pluginOrigin: "bundled",
      pluginSource: "/plugins/google-meet/index.js",
    });
  });

  it("limits harness session creation to the registering plugin", async () => {
    const runtime = createPluginRuntime();
    let createScope = getPluginRuntimeGatewayRequestScope();
    const createSessionEntry: PluginRuntime["agent"]["session"]["createSessionEntry"] = vi.fn(
      async (params) => {
        createScope = getPluginRuntimeGatewayRequestScope();
        const entry = {
          sessionId: "session-1",
          updatedAt: 1,
          agentHarnessId: params.initialEntry.agentHarnessId,
        };
        return {
          key: params.key,
          agentId: "main",
          sessionId: entry.sessionId,
          entry,
        };
      },
    );
    runtime.agent.session.createSessionEntry = createSessionEntry;
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
    const ownerApi = pluginRegistry.createApi(ownerRecord, { config: {} as OpenClawConfig });
    const otherApi = pluginRegistry.createApi(otherRecord, { config: {} as OpenClawConfig });
    ownerApi.registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("unused");
      },
    });
    const createParams = {
      cfg: {},
      key: "agent:main:harness:codex:thread-1",
      initialEntry: { agentHarnessId: "codex" },
    };

    await expect(ownerApi.runtime.agent.session.createSessionEntry(createParams)).resolves.toEqual(
      expect.objectContaining({ sessionId: "session-1" }),
    );
    expect(createScope).toMatchObject({
      pluginId: "codex-owner",
      pluginSource: "/plugins/codex-owner/index.js",
    });
    await expect(otherApi.runtime.agent.session.createSessionEntry(createParams)).rejects.toThrow(
      'Agent harness "codex" is owned by plugin "codex-owner", not "other-plugin".',
    );
    await expect(
      otherApi.runtime.agent.session.createSessionEntry({
        cfg: {},
        key: "agent:main:ordinary",
        initialEntry: { agentHarnessId: "codex", modelSelectionLocked: true },
      }),
    ).rejects.toThrow(
      'Agent harness "codex" is owned by plugin "codex-owner", not "other-plugin".',
    );
    await expect(
      ownerApi.runtime.agent.session.createSessionEntry({
        cfg: {},
        key: "agent:main:ordinary",
        initialEntry: { agentHarnessId: "codex", modelSelectionLocked: true },
      }),
    ).resolves.toEqual(expect.objectContaining({ sessionId: "session-1" }));
    expect(createSessionEntry).toHaveBeenCalledTimes(2);
  });

  it("limits CLI session creation to the owning plugin namespace", async () => {
    const runtime = createPluginRuntime();
    const createSessionEntry = vi.fn(async (params) => ({
      key: params.key,
      agentId: "main",
      sessionId: "session-1",
      entry: { sessionId: "session-1", updatedAt: 1 },
    }));
    runtime.agent.session.createSessionEntry = createSessionEntry;
    const pluginRegistry = createTestRegistry(runtime);
    const record = createPluginRecord({
      id: "anthropic",
      source: "/plugins/anthropic/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });
    api.registerCliBackend({ id: "claude-cli", config: { command: "claude" } });
    api.registerAgentHarness({
      id: "anthropic-harness",
      label: "Anthropic",
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("unused");
      },
    });
    const initialEntry = {
      cliBackendId: "claude-cli",
      model: "claude-opus-4-8",
      modelSelectionLocked: true as const,
      cliSessionBinding: { sessionId: "source", forkNextResume: true as const },
    };

    await expect(
      api.runtime.agent.session.createSessionEntry({
        cfg: {},
        key: "plugin:anthropic:catalog-adopt:claude:source",
        initialEntry,
      }),
    ).resolves.toEqual(expect.objectContaining({ sessionId: "session-1" }));
    expect(createSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        initialEntry: expect.objectContaining({ pluginOwnerId: "anthropic" }),
      }),
    );
    await expect(
      api.runtime.agent.session.createSessionEntry({
        cfg: {},
        key: "agent:main:ordinary",
        initialEntry,
      }),
    ).rejects.toThrow('must start with "plugin:anthropic:"');
    await expect(
      api.runtime.agent.session.createSessionEntry({
        cfg: {},
        key: "agent:main:ordinary",
        initialEntry: {
          ...initialEntry,
          agentHarnessId: "anthropic-harness",
        } as never,
      }),
    ).rejects.toThrow("requires exactly one runtime owner");
  });

  it("limits locked harness session mutation and execution to the harness owner", async () => {
    const reservedKey = "agent:main:harness:codex:thread-1";
    const ordinaryKey = "agent:main:ordinary";
    const lockedOrdinaryKey = "agent:main:ordinary-locked";
    const legacyPrefixedKey = "agent:main:harness:notes";
    const reservedEntry = {
      sessionId: "reserved-session",
      sessionFile: "/tmp/reserved.jsonl",
      updatedAt: 1,
      agentHarnessId: "codex",
      modelSelectionLocked: true as const,
    };
    const ordinaryEntry = { sessionId: "ordinary-session", updatedAt: 1 };
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
    const entries = {
      [reservedKey]: reservedEntry,
      [ordinaryKey]: ordinaryEntry,
      [lockedOrdinaryKey]: lockedOrdinaryEntry,
      [legacyPrefixedKey]: legacyPrefixedEntry,
    };
    const subagent = {
      run: vi.fn(async () => ({ runId: "subagent-run" })),
      waitForRun: vi.fn(async () => ({ status: "ok" as const })),
      getSessionMessages: vi.fn(async () => ({ messages: [] })),
      deleteSession: vi.fn(async () => {}),
    } satisfies PluginRuntime["subagent"];
    const runtime = createPluginRuntime({ subagent });
    const session = runtime.agent.session;
    session.getSessionEntry = vi.fn((params) => entries[params.sessionKey as keyof typeof entries]);
    session.listSessionEntries = vi.fn(() =>
      Object.entries(entries).map(([sessionKey, entry]) => ({ sessionKey, entry })),
    );
    session.patchSessionEntry = vi.fn(async (params) => {
      const entry = entries[params.sessionKey as keyof typeof entries];
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
      async (params) => entries[params.sessionKey as keyof typeof entries],
    );
    let admissionScope = getPluginRuntimeGatewayRequestScope();
    session.runWithWorkAdmission = vi.fn(async (_params, run) => {
      admissionScope = getPluginRuntimeGatewayRequestScope();
      return await run(new AbortController().signal);
    });
    let embeddedRunScope = getPluginRuntimeGatewayRequestScope();
    const runEmbeddedAgent = vi.fn(async () => {
      embeddedRunScope = getPluginRuntimeGatewayRequestScope();
      return { ok: true };
    }) as unknown as PluginRuntime["agent"]["runEmbeddedAgent"];
    Object.defineProperties(runtime.agent, {
      runEmbeddedAgent: { configurable: true, value: runEmbeddedAgent },
      runEmbeddedPiAgent: { configurable: true, value: runEmbeddedAgent },
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

    await expect(
      ownerApi.runtime.agent.session.patchSessionEntry({
        sessionKey: reservedKey,
        update: () => ({ archivedAt: undefined }),
      }),
    ).resolves.toMatchObject(reservedEntry);
    await expect(ownerApi.runtime.agent.runEmbeddedAgent(runParams)).resolves.toEqual({ ok: true });
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
    await expect(
      voiceApi.runtime.agent.runEmbeddedAgent({
        ...delegatedRunParams,
        agentHarnessRuntimeOverride: "openclaw",
      }),
    ).rejects.toThrow("only with its exact persisted identity and harness");
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
      }),
    ).rejects.toThrow('owned by plugin "codex-owner"');
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
      }),
    ).rejects.toThrow('owned by plugin "codex-owner"');
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

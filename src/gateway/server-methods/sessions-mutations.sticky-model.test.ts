import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { AgentConfig } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const emptyPluginMetadataSnapshot = vi.hoisted(() => ({
  policyHash: "sticky-model-test-empty-plugin-policy",
  index: {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "sticky-model-test-empty-plugin-policy",
    generatedAtMs: 0,
    installRecords: {},
    plugins: [],
    diagnostics: [],
  },
  registryDiagnostics: [],
  manifestRegistry: { plugins: [], diagnostics: [] },
  plugins: [],
  diagnostics: [],
  byPluginId: new Map(),
  normalizePluginId: (pluginId: string) => pluginId,
  owners: {
    channels: new Map(),
    channelConfigs: new Map(),
    providers: new Map(),
    modelCatalogProviders: new Map(),
    cliBackends: new Map(),
    setupProviders: new Map(),
    commandAliases: new Map(),
    contracts: new Map(),
  },
  metrics: {
    registrySnapshotMs: 0,
    manifestRegistryMs: 0,
    ownerMapsMs: 0,
    totalMs: 0,
    indexPluginCount: 0,
    manifestPluginCount: 0,
  },
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => emptyPluginMetadataSnapshot,
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: () => emptyPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: () => emptyPluginMetadataSnapshot,
}));

vi.mock("../../plugins/provider-thinking.js", () => ({
  resolveEffectiveThinkingProfile: () => undefined,
}));

const effects = vi.hoisted(() => ({
  info: vi.fn(),
  mutateConfigFileWithRetry: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return { ...actual, mutateConfigFileWithRetry: effects.mutateConfigFileWithRetry };
});

vi.mock("../../logging/subsystem.js", async () => {
  const actual = await vi.importActual<typeof import("../../logging/subsystem.js")>(
    "../../logging/subsystem.js",
  );
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) =>
      subsystem === "agents/sticky-model-selection"
        ? { info: effects.info, warn: effects.warn }
        : actual.createSubsystemLogger(subsystem),
  };
});

import { sessionMutationHandlers } from "./sessions-mutations.js";

const defaultAgents: AgentConfig[] = [
  { id: "main", default: true },
  { id: "work", model: "anthropic/claude-sonnet-4-6" },
];

const defaultConfig = {
  agents: {
    defaults: { model: "anthropic/claude-opus-4-6" },
    list: defaultAgents,
  },
} satisfies OpenClawConfig;

let cfg: OpenClawConfig;
let persistedConfig: OpenClawConfig | undefined;
let openClawTestState: OpenClawTestState;

function context(): GatewayRequestContext {
  return {
    getRuntimeConfig: () => cfg,
    loadGatewayModelCatalog: vi.fn(async () => [
      { provider: "anthropic", id: "claude-opus-4-6" },
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      { provider: "openai", id: "gpt-5.6-sol" },
    ]),
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
    chatAbortControllers: new Map(),
  } as unknown as GatewayRequestContext;
}

function client(scopes: string[]): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes,
    },
  };
}

async function patchSession(
  params: Record<string, unknown>,
  scopes = ["operator.admin"],
  requestContext = context(),
) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionMutationHandlers["sessions.patch"]?.({
    params,
    client: client(scopes),
    context: requestContext,
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  } as never);
  expect(responses).toHaveLength(1);
  return responses[0]!;
}

beforeAll(async () => {
  openClawTestState = await createOpenClawTestState({ scenario: "minimal" });
});

beforeEach(() => {
  cfg = structuredClone(defaultConfig);
  persistedConfig = undefined;
  effects.info.mockReset();
  effects.warn.mockReset();
  effects.mutateConfigFileWithRetry
    .mockReset()
    .mockImplementation(
      async (params: { mutate: (draft: OpenClawConfig, context: unknown) => unknown }) => {
        const draft = structuredClone(cfg);
        const result = await params.mutate(draft, {});
        persistedConfig = draft;
        return { nextConfig: draft, result };
      },
    );
});

afterAll(async () => {
  closeOpenClawAgentDatabasesForTest();
  await openClawTestState.cleanup();
});

describe("sessions.patch sticky model persistence", () => {
  it.each([
    { scope: undefined, agentId: "main", target: "defaults" },
    { scope: undefined, agentId: "work", target: "agent" },
    { scope: "session", agentId: "main", target: undefined },
    { scope: "session", agentId: "work", target: undefined },
    { scope: "agent", agentId: "main", target: "agent" },
    { scope: "agent", agentId: "work", target: "agent" },
    { scope: "global", agentId: "main", target: "defaults" },
    { scope: "global", agentId: "work", target: "defaults" },
  ] as const)(
    "uses scope=$scope for $agentId without changing another config layer",
    async ({ scope, agentId, target }) => {
      cfg.agents!.defaults!.modelSelectionScope = scope;
      const sessionKey = `agent:${agentId}:dm:sticky-${scope ?? "unset"}`;
      const model = "openai/gpt-5.6-sol";
      await upsertSessionEntryCore(
        { agentId, sessionKey },
        { sessionId: `session-${agentId}-${scope ?? "unset"}`, updatedAt: 1 },
      );

      const response = await patchSession({ key: sessionKey, model });

      expect(response[0]).toBe(true);
      expect(loadSessionEntry({ agentId, sessionKey })).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
      });
      if (!target) {
        expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
        return;
      }
      await vi.waitFor(() => expect(persistedConfig).toBeDefined());
      expect(persistedConfig?.agents?.defaults?.model).toBe(
        target === "defaults" ? model : defaultConfig.agents.defaults.model,
      );
      const expectedAgents = structuredClone(defaultConfig.agents.list);
      for (const agent of expectedAgents) {
        if (target === "agent" && agent.id === agentId) {
          agent.model = model;
        }
      }
      expect(persistedConfig?.agents?.list).toEqual(expectedAgents);
    },
  );

  it.each([
    { scope: "agent", agentId: "main", model: "anthropic/claude-opus-4-6" },
    { scope: "global", agentId: "work", model: "anthropic/claude-sonnet-4-6" },
  ] as const)(
    "honors configured $scope scope when selecting the current effective model",
    async ({ scope, agentId, model }) => {
      cfg.agents!.defaults!.modelSelectionScope = scope;
      const sessionKey = `agent:${agentId}:dm:scope-current-${scope}`;
      await upsertSessionEntryCore(
        { agentId, sessionKey },
        { sessionId: `session-scope-current-${scope}`, updatedAt: 1 },
      );

      expect((await patchSession({ key: sessionKey, model }))[0]).toBe(true);
      expect(loadSessionEntry({ agentId, sessionKey })?.modelOverride).toBeUndefined();
      await vi.waitFor(() => expect(persistedConfig).toBeDefined());
      expect(persistedConfig?.agents?.defaults?.model).toBe(
        scope === "global" ? model : defaultConfig.agents.defaults.model,
      );
      const expectedAgents = structuredClone(defaultConfig.agents.list);
      for (const agent of expectedAgents) {
        if (scope === "agent" && agent.id === agentId) {
          agent.model = model;
        }
      }
      expect(persistedConfig?.agents?.list).toEqual(expectedAgents);
    },
  );

  it("emits a groups invalidation when a patch first registers a category", async () => {
    const sessionKey = "agent:main:dm:category-groups";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "session-category-groups", updatedAt: 1 },
    );
    const broadcast = vi.fn();
    const subscribedContext = {
      ...context(),
      broadcastToConnIds: broadcast,
      getSessionEventSubscriberConnIds: () => new Set(["conn-groups"]),
    } as unknown as GatewayRequestContext;

    const first = await patchSession(
      { key: sessionKey, category: "Fresh Category" },
      ["operator.admin"],
      subscribedContext,
    );
    expect(first[0]).toBe(true);
    const groupsEvents = broadcast.mock.calls.filter(
      (call) =>
        call[0] === "sessions.changed" && (call[1] as { reason?: string }).reason === "groups",
    );
    expect(groupsEvents).toHaveLength(1);

    // Re-assigning an already-registered category is not a catalog mutation.
    broadcast.mockClear();
    const second = await patchSession(
      { key: sessionKey, category: "Fresh Category" },
      ["operator.admin"],
      subscribedContext,
    );
    expect(second[0]).toBe(true);
    expect(
      broadcast.mock.calls.filter(
        (call) =>
          call[0] === "sessions.changed" && (call[1] as { reason?: string }).reason === "groups",
      ),
    ).toHaveLength(0);
  });

  it.each([undefined, "session", "agent", "global"] as const)(
    "keeps non-admin model changes session-only with scope=%s",
    async (scope) => {
      cfg.agents!.defaults!.modelSelectionScope = scope;
      const sessionKey = `agent:main:dm:non-admin-${scope ?? "unset"}`;
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId: `session-non-admin-${scope ?? "unset"}`, updatedAt: 1 },
      );

      const response = await patchSession({ key: sessionKey, model: "openai/gpt-5.6-sol" }, [
        "operator.write",
      ]);

      expect(response[0]).toBe(true);
      expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
      });
      expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    },
  );

  it("returns session success and warns when the sticky config write fails", async () => {
    const sessionKey = "agent:main:dm:write-failure";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "session-write-failure", updatedAt: 1 },
    );
    effects.mutateConfigFileWithRetry.mockRejectedValueOnce(new Error("config write failed"));

    const response = await patchSession({ key: sessionKey, model: "openai/gpt-5.6-sol" });

    expect(response[0]).toBe(true);
    expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-sol",
    });
    await vi.waitFor(() =>
      expect(effects.warn).toHaveBeenCalledWith(
        "failed sticky model persistence agentId=main model=openai/gpt-5.6-sol reason=config write failed",
      ),
    );
  });

  it.each([
    { name: "omitted", patch: { label: "Sticky" } },
    { name: "cleared", patch: { model: null } },
    { name: "reset to the current default", patch: { model: "anthropic/claude-opus-4-6" } },
  ])("does not persist when model is $name", async ({ name, patch }) => {
    const sessionKey = `agent:main:dm:no-sticky-${name}`;
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: `session-${name}`,
        updatedAt: 1,
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
        modelOverrideSource: "user",
        modelOverrideRouteResolution: "resolved",
      },
    );

    const response = await patchSession({ key: sessionKey, ...patch });

    expect(response[0]).toBe(true);
    expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
  });
});

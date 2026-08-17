import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
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

const cfg = {
  agents: {
    defaults: { model: "anthropic/claude-opus-4-6" },
    list: [
      { id: "main", default: true },
      { id: "work", model: "anthropic/claude-sonnet-4-6" },
    ],
  },
} satisfies OpenClawConfig;

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
  effects.info.mockReset();
  effects.warn.mockReset();
  effects.mutateConfigFileWithRetry
    .mockReset()
    .mockImplementation(
      async (params: { mutate: (draft: OpenClawConfig, context: unknown) => unknown }) => {
        const draft = structuredClone(cfg);
        const result = await params.mutate(draft, {});
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
    { agentId: "main", sessionKey: "agent:main:dm:sticky" },
    { agentId: "work", sessionKey: "agent:work:dm:sticky" },
  ])(
    "persists an accepted model for the resolved $agentId agent",
    async ({ agentId, sessionKey }) => {
      await upsertSessionEntryCore(
        { agentId, sessionKey },
        { sessionId: `session-${agentId}`, updatedAt: 1 },
      );

      const response = await patchSession({ key: sessionKey, model: "openai/gpt-5.6-sol" });

      expect(response[0]).toBe(true);
      await vi.waitFor(() => expect(effects.mutateConfigFileWithRetry).toHaveBeenCalledOnce());
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

  it("keeps a write-scoped model switch session-only without persisting the configured default", async () => {
    const sessionKey = "agent:main:dm:non-admin";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "session-non-admin", updatedAt: 1 },
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
  });

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

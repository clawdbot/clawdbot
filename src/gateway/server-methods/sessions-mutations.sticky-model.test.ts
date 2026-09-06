import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { AgentConfig } from "../../config/types.agents.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import * as userModelAccounts from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const pluginMetadata = vi.hoisted(() => ({
  snapshot: undefined as PluginMetadataSnapshot | undefined,
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => pluginMetadata.snapshot,
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: () => pluginMetadata.snapshot,
  resolvePluginMetadataSnapshot: () => pluginMetadata.snapshot,
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
let accountOwnerId: string;
let otherPersonId: string;
let personalAuthProfileId: string;

const modelCatalog: ModelCatalogEntry[] = [
  { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus" },
  { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
  { provider: "openai", id: "gpt-5.6-sol", name: "GPT" },
];
type TestClient = GatewayClient & { connId: string; invalidated: boolean };
type TestContext = Pick<
  GatewayRequestContext,
  | "getRuntimeConfig"
  | "loadGatewayModelCatalog"
  | "broadcastToConnIds"
  | "getSessionEventSubscriberConnIds"
  | "chatAbortControllers"
  | "getClientConnIds"
>;

function context(clients = new Set<TestClient>()) {
  return {
    getRuntimeConfig: () => cfg,
    loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(
      async () => modelCatalog,
    ),
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set<string>(),
    chatAbortControllers: new Map(),
    getClientConnIds: (filter?: (client: GatewayClient) => boolean) =>
      new Set(
        [...clients]
          .filter((candidate) => !candidate.invalidated && (!filter || filter(candidate)))
          .map((candidate) => candidate.connId),
      ),
  } satisfies TestContext;
}

function client(scopes: string[]): TestClient {
  return {
    connId: "sticky-model-connection",
    invalidated: false,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes,
    },
  };
}

function personClient(profileId: string, scopes = ["operator.write"]): TestClient {
  return {
    ...client(scopes),
    authenticatedUserProfile: {
      profileId,
      displayName: "Test Person",
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

async function patchSession(
  params: Record<string, unknown>,
  scopes = ["operator.admin"],
  requestContext: TestContext = context(),
  requestClient: GatewayClient = client(scopes),
) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionMutationHandlers["sessions.patch"]?.({
    req: { type: "req", id: "sticky-model-patch", method: "sessions.patch", params },
    params,
    client: requestClient,
    context: requestContext as GatewayRequestContext,
    isWebchatConnect: () => true,
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  });
  expect(responses).toHaveLength(1);
  return responses[0]!;
}

beforeAll(async () => {
  openClawTestState = await createOpenClawTestState({ scenario: "minimal" });
  accountOwnerId = ensureProfileForEmail("personal-owner@example.test").id;
  otherPersonId = ensureProfileForEmail("other-person@example.test").id;
  personalAuthProfileId = userModelAccounts.connectUserModelAccount({
    ownerProfileId: accountOwnerId,
    credential: {
      type: "oauth",
      provider: "openai",
      access: "synthetic-personal-access",
      refresh: "synthetic-personal-refresh",
      expires: Date.now() + 60_000,
    },
    assertCurrent: () => {},
  }).authProfileId;
  // Sticky selections still pass real harness admission; this fixture supplies
  // the installed owner required by its OpenAI route without loading runtime code.
  pluginMetadata.snapshot = createPluginMetadataSnapshotFixture({
    plugins: [{ id: "codex", activation: { onAgentHarnesses: ["codex"] } }],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
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
    { scope: undefined, agentId: "main", target: undefined },
    { scope: undefined, agentId: "work", target: undefined },
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
    };

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
    cfg.agents!.defaults!.modelSelectionScope = "global";
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

describe("sessions.patch personal model-account ownership", () => {
  it("lets the connected human select a saved personal account for this session", async () => {
    const sessionKey = "agent:main:dm:personal-selection-owner";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "personal-selection-owner", updatedAt: 1 },
    );
    const caller = personClient(accountOwnerId);
    const requestContext = context(new Set([caller]));

    const response = await patchSession(
      { key: sessionKey, model: `openai/gpt-5.6-sol@${personalAuthProfileId}` },
      caller.connect.scopes,
      requestContext,
      caller,
    );

    expect(response[0]).toBe(true);
    expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-sol",
      authProfileOverride: personalAuthProfileId,
      authProfileOverrideSource: "user",
    });
    expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
  });

  it.each(["foreign admin", "unidentified admin", "agent"] as const)(
    "denies a new personal selection from a %s before catalog or credential access",
    async (kind) => {
      const sessionKey = `agent:main:dm:personal-selection-denied-${kind.replaceAll(" ", "-")}`;
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId: sessionKey, updatedAt: 1, label: "Original" },
      );
      const before = loadSessionEntry({ agentId: "main", sessionKey });
      const caller =
        kind === "foreign admin"
          ? personClient(otherPersonId, ["operator.admin"])
          : kind === "unidentified admin"
            ? client(["operator.admin"])
            : personClient(accountOwnerId, ["operator.admin"]);
      if (kind === "agent") {
        caller.internal = {
          syntheticClient: true,
          agentToolCaller: { agentId: "main", sessionKey },
        };
      }
      const requestContext = context(new Set([caller]));
      const readCredential = vi.spyOn(userModelAccounts, "readUserModelAuthProfile");

      const response = await patchSession(
        {
          key: sessionKey,
          model: `openai/gpt-5.6-sol@${personalAuthProfileId}`,
          label: "Must not commit",
        },
        caller.connect.scopes,
        requestContext,
        caller,
      );

      expect(response[0]).toBe(false);
      expect(response[2]).toMatchObject({ code: "FORBIDDEN" });
      expect(requestContext.loadGatewayModelCatalog).not.toHaveBeenCalled();
      expect(readCredential).not.toHaveBeenCalled();
      expect(loadSessionEntry({ agentId: "main", sessionKey })).toEqual(before);
      expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    },
  );

  it.each(["invalidated", "disconnected", "role revoked"] as const)(
    "rejects a personal selection %s while the model catalog is loading",
    async (loss) => {
      const sessionKey = `agent:main:dm:personal-selection-lost-${loss.replaceAll(" ", "-")}`;
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId: sessionKey, updatedAt: 1, label: "Before catalog" },
      );
      const before = loadSessionEntry({ agentId: "main", sessionKey });
      const writer: GatewayOperatorRoleDefinition = {
        agents: "*",
        scopes: ["operator.write"],
        sessions: { others: "none" },
      };
      cfg.gateway = { roles: { default: "writer", definitions: { writer } } };
      const caller = personClient(accountOwnerId);
      const connections = new Set([caller]);
      const requestContext = context(connections);
      const catalog = createDeferredCore<ModelCatalogEntry[]>();
      requestContext.loadGatewayModelCatalog.mockReturnValueOnce(catalog.promise);
      const readCredential = vi.spyOn(userModelAccounts, "readUserModelAuthProfile");
      const pending = patchSession(
        {
          key: sessionKey,
          model: `openai/gpt-5.6-sol@${personalAuthProfileId}`,
          label: "Must not commit",
        },
        caller.connect.scopes,
        requestContext,
        caller,
      );
      try {
        await vi.waitFor(() =>
          expect(requestContext.loadGatewayModelCatalog).toHaveBeenCalledOnce(),
        );
        if (loss === "invalidated") {
          caller.invalidated = true;
        } else if (loss === "disconnected") {
          connections.delete(caller);
        } else {
          writer.scopes = ["operator.read"];
        }
      } finally {
        catalog.resolve(modelCatalog);
      }
      const response = await pending;

      expect(response[0]).toBe(false);
      expect(response[2]).toMatchObject({ code: "FORBIDDEN" });
      expect(readCredential).not.toHaveBeenCalled();
      expect(loadSessionEntry({ agentId: "main", sessionKey })).toEqual(before);
      expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    },
  );

  it("reports lost personal authority during archive drain as forbidden", async () => {
    const sessionKey = "agent:main:dm:personal-selection-archive-drain";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "personal-selection-archive-drain", updatedAt: 1 },
    );
    const before = loadSessionEntry({ agentId: "main", sessionKey });
    const caller = personClient(accountOwnerId);
    const connections = new Set([caller]);
    const release = vi.fn();
    const terminalSessions: Pick<
      NonNullable<GatewayRequestContext["terminalSessions"]>,
      "beginAgentSessionDrain"
    > = {
      beginAgentSessionDrain: () => {
        connections.delete(caller);
        return { drained: Promise.resolve(), hasWork: () => false, release };
      },
    };
    const requestContext = {
      ...context(connections),
      terminalSessions,
      chatQueuedTurns: new Map(),
      dedupe: new Map(),
    };
    const response = await patchSession(
      {
        key: sessionKey,
        model: `openai/gpt-5.6-sol@${personalAuthProfileId}`,
        archived: true,
        expectedSessionId: before!.sessionId,
      },
      caller.connect.scopes,
      requestContext,
      caller,
    );

    expect(response[0]).toBe(false);
    expect(response[2]).toMatchObject({ code: "FORBIDDEN" });
    expect(loadSessionEntry({ agentId: "main", sessionKey })).toEqual(before);
    expect(release).toHaveBeenCalledOnce();
  });

  it("retains an existing personal pin when an agent patches unrelated session metadata", async () => {
    const sessionKey = "agent:main:dm:personal-selection-inherited";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: "personal-selection-inherited",
        updatedAt: 1,
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
        authProfileOverride: personalAuthProfileId,
        authProfileOverrideSource: "user",
        createdActor: { type: "human", id: accountOwnerId, source: "profile" },
      },
    );
    const caller = client(["operator.write"]);
    caller.internal = { syntheticClient: true, agentToolCaller: { agentId: "main", sessionKey } };

    const response = await patchSession(
      { key: sessionKey, label: "Renamed by the session agent" },
      caller.connect.scopes,
      context(),
      caller,
    );

    expect(response[0]).toBe(true);
    expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
      label: "Renamed by the session agent",
      authProfileOverride: personalAuthProfileId,
      authProfileOverrideSource: "user",
      providerOverride: "openai",
      modelOverride: "gpt-5.6-sol",
    });
    expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
  });

  it("preserves shared-profile selection without requiring a personal identity", async () => {
    const sharedAuthProfileId = "openai:shared-session-control";
    await openClawTestState.writeAuthProfiles({
      version: 1,
      profiles: {
        [sharedAuthProfileId]: {
          type: "token",
          provider: "openai",
          token: "synthetic-shared-token",
        },
      },
    });
    const sessionKey = "agent:main:dm:shared-selection-control";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "shared-selection-control", updatedAt: 1 },
    );

    const response = await patchSession(
      { key: sessionKey, model: `openai/gpt-5.6-sol@${sharedAuthProfileId}` },
      ["operator.write"],
    );

    expect(response[0]).toBe(true);
    expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-sol",
      authProfileOverride: sharedAuthProfileId,
      authProfileOverrideSource: "user",
    });
  });
});

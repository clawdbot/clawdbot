// Msteams tests cover lifecycle session reset behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConversationStore } from "../conversation-store.js";
import {
  createMSTeamsMessageHandlerDeps,
  installMSTeamsTestRuntime,
} from "../monitor-handler.test-helpers.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";

const hoisted = vi.hoisted(() => {
  const listSessionEntries = vi.fn();
  const resetSessionEntryLifecycle = vi.fn();
  const resolveStorePath = vi.fn(() => "/tmp/openclaw-msteams-sessions.json");
  return { listSessionEntries, resetSessionEntryLifecycle, resolveStorePath };
});

vi.mock("openclaw/plugin-sdk/session-store-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
    "openclaw/plugin-sdk/session-store-runtime",
  );
  return {
    ...actual,
    listSessionEntries: hoisted.listSessionEntries,
    resolveStorePath: hoisted.resolveStorePath,
  };
});

let handleMSTeamsDmConversationBoundary: typeof import("./lifecycle-handler.js").handleMSTeamsDmConversationBoundary;
let handleMSTeamsLifecycleRemove: typeof import("./lifecycle-handler.js").handleMSTeamsLifecycleRemove;

type SessionEntry = {
  [key: string]: unknown;
  sessionId?: string;
  updatedAt: number;
  route?: unknown;
  deliveryContext?: unknown;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  origin?: unknown;
};

function setupStore(store: Record<string, SessionEntry>) {
  hoisted.listSessionEntries.mockImplementation(() =>
    Object.entries(store).map(([sessionKey, entry]) => ({ sessionKey, entry })),
  );
  hoisted.resetSessionEntryLifecycle.mockImplementation(
    async (params: {
      expectedSessionId?: string;
      expectedUpdatedAt?: number;
      sessionKey: string;
      update: (
        entry: SessionEntry,
        context: { nextSessionFile: string; nextSessionId: string },
      ) => Partial<SessionEntry> | null;
    }) => {
      const entry = store[params.sessionKey];
      if (!entry) {
        return null;
      }
      if (
        (params.expectedSessionId !== undefined && entry.sessionId !== params.expectedSessionId) ||
        (params.expectedUpdatedAt !== undefined && entry.updatedAt !== params.expectedUpdatedAt)
      ) {
        return null;
      }
      const nextSessionId = `${entry.sessionId ?? "session"}-rotated`;
      const nextSessionFile = `/tmp/openclaw/agents/dale/sessions/${nextSessionId}.jsonl`;
      const next = params.update({ ...entry }, { nextSessionFile, nextSessionId });
      if (!next) {
        return null;
      }
      store[params.sessionKey] = {
        ...next,
        sessionFile: nextSessionFile,
        sessionId: nextSessionId,
      } as SessionEntry;
      return store[params.sessionKey];
    },
  );
}

function createDeps(remove = vi.fn(async () => true)) {
  const deps = createMSTeamsMessageHandlerDeps();
  deps.conversationStore = {
    ...deps.conversationStore,
    list: vi.fn(async () => []),
    remove,
  } as MSTeamsConversationStore;
  return { deps, remove };
}

function createContext(activity: Record<string, unknown>): MSTeamsTurnContext {
  return {
    activity: activity as MSTeamsTurnContext["activity"],
    sendActivity: vi.fn(async () => ({ id: "sent" })),
    sendActivities: vi.fn(async () => []),
    updateActivity: vi.fn(async () => ({ id: "updated" })),
    deleteActivity: vi.fn(async () => undefined),
  };
}

describe("handleMSTeamsLifecycleRemove", () => {
  beforeAll(async () => {
    ({ handleMSTeamsDmConversationBoundary, handleMSTeamsLifecycleRemove } =
      await import("./lifecycle-handler.js"));
  });

  beforeEach(() => {
    installMSTeamsTestRuntime({
      resetSessionEntryLifecycle: hoisted.resetSessionEntryLifecycle,
    });
    hoisted.listSessionEntries.mockReset();
    hoisted.resetSessionEntryLifecycle.mockReset();
    hoisted.resolveStorePath.mockClear();
    hoisted.resolveStorePath.mockReturnValue("/tmp/openclaw-msteams-sessions.json");
  });

  it("rotates a personal app remove session and removes the cached conversation reference", async () => {
    const store = {
      "msteams:direct:user-aad": {
        sessionId: "old-session",
        updatedAt: 1_000,
        route: { channel: "msteams" },
        deliveryContext: { channel: "msteams" },
        lastChannel: "msteams",
        lastTo: "user:user-aad",
        lastAccountId: "default",
        origin: { provider: "msteams" },
        sessionFile: "/tmp/openclaw/agents/dale/sessions/old-session.jsonl",
        sessionStartedAt: 1_000,
        status: "running",
        startedAt: 1_100,
        endedAt: 1_900,
        runtimeMs: 800,
        lastInteractionAt: 1_250,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        totalTokensFresh: true,
        contextTokens: 15,
        compactionCount: 2,
        compactionCheckpoints: [{ checkpointId: "old-checkpoint" }],
        cliSessionIds: { codex: "old-session" },
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "stale reply",
        restartRecoveryDeliveryRunId: "old-run",
        ambientTranscriptWatermarks: { room: { sessionId: "old-session" } },
        lifecycleRevision: "old-revision",
        goal: { status: "active", objective: "old goal" },
        pluginNextTurnInjections: { plugin: [{ text: "stale prompt" }] },
        subagentRecovery: { automaticAttempts: 1 },
        quotaSuspension: { state: "suspended" },
        pendingSkillSuggestion: { skill: "old" },
        skillCaptureSignalHashes: ["old-hash"],
        pluginExtensionSlotKeys: { plugin: { slot: "old" } },
        futureTransientState: { shouldNotSurvive: true },
        model: "gpt-5",
        modelProvider: "openai",
        modelSelectionLocked: true,
        agentHarnessId: "codex",
        reasoningLevel: "high",
        thinkingLevel: "medium",
        verboseLevel: "debug",
        ttsAuto: "off",
        archivedAt: 111,
        pinnedAt: 222,
        lastReadAt: 333,
        markedUnreadAt: 444,
        providerOverride: "openai",
        modelOverride: "gpt-5",
        modelOverrideSource: "user",
        modelOverrideRouteResolution: "resolved",
        modelOverrideFallbackOriginProvider: "anthropic",
        modelOverrideFallbackOriginModel: "claude-opus-4",
        authProfileOverride: "work",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 7,
        groupActivation: "mention",
        sendPolicy: "allow",
        queueMode: "collect",
        queueDebounceMs: 500,
        queueCap: 12,
        queueDrop: "old",
        label: "Dale",
        category: "bots",
        displayName: "Dale Botkin",
        responseUsage: "tokens",
      },
      "msteams:direct:other-user": { sessionId: "other-session", updatedAt: 2_000 },
    };
    setupStore(store);
    const { deps, remove } = createDeps();

    const result = await handleMSTeamsLifecycleRemove(
      createContext({
        type: "installationUpdate",
        action: "remove",
        from: { id: "user-bf", aadObjectId: "user-aad" },
        recipient: { id: "bot-id" },
        conversation: {
          id: "19:personal-chat;messageid=ignored",
          conversationType: "personal",
        },
      }),
      deps,
    );

    expect(result).toEqual({
      handled: true,
      reason: "installation-remove",
      conversationRemoved: true,
      sessionsReset: 1,
    });
    expect(remove).toHaveBeenCalledWith("19:personal-chat");
    expect(store["msteams:direct:user-aad"].updatedAt).toBe(0);
    expect(store["msteams:direct:user-aad"].sessionId).not.toBe("old-session");
    expect(store["msteams:direct:user-aad"].route).toBeUndefined();
    expect(store["msteams:direct:user-aad"].deliveryContext).toBeUndefined();
    expect(store["msteams:direct:user-aad"].lastChannel).toBeUndefined();
    expect(store["msteams:direct:user-aad"].lastTo).toBeUndefined();
    expect(store["msteams:direct:user-aad"].lastAccountId).toBeUndefined();
    expect(store["msteams:direct:user-aad"].origin).toBeUndefined();
    expect(store["msteams:direct:user-aad"].sessionFile).toBe(
      "/tmp/openclaw/agents/dale/sessions/old-session-rotated.jsonl",
    );
    expect(store["msteams:direct:user-aad"].sessionStartedAt).toBeUndefined();
    expect(store["msteams:direct:user-aad"].status).toBeUndefined();
    expect(store["msteams:direct:user-aad"].startedAt).toBeUndefined();
    expect(store["msteams:direct:user-aad"].endedAt).toBeUndefined();
    expect(store["msteams:direct:user-aad"].runtimeMs).toBeUndefined();
    expect(store["msteams:direct:user-aad"].lastInteractionAt).toBeUndefined();
    expect(store["msteams:direct:user-aad"].inputTokens).toBeUndefined();
    expect(store["msteams:direct:user-aad"].outputTokens).toBeUndefined();
    expect(store["msteams:direct:user-aad"].totalTokens).toBeUndefined();
    expect(store["msteams:direct:user-aad"].totalTokensFresh).toBeUndefined();
    expect(store["msteams:direct:user-aad"].contextTokens).toBeUndefined();
    expect(store["msteams:direct:user-aad"].compactionCount).toBeUndefined();
    expect(store["msteams:direct:user-aad"].compactionCheckpoints).toBeUndefined();
    expect(store["msteams:direct:user-aad"].cliSessionIds).toBeUndefined();
    expect(store["msteams:direct:user-aad"].pendingFinalDelivery).toBeUndefined();
    expect(store["msteams:direct:user-aad"].pendingFinalDeliveryText).toBeUndefined();
    expect(store["msteams:direct:user-aad"].restartRecoveryDeliveryRunId).toBeUndefined();
    expect(store["msteams:direct:user-aad"].ambientTranscriptWatermarks).toBeUndefined();
    expect(store["msteams:direct:user-aad"].lifecycleRevision).toBeUndefined();
    expect(store["msteams:direct:user-aad"].goal).toBeUndefined();
    expect(store["msteams:direct:user-aad"].pluginNextTurnInjections).toBeUndefined();
    expect(store["msteams:direct:user-aad"].subagentRecovery).toBeUndefined();
    expect(store["msteams:direct:user-aad"].quotaSuspension).toBeUndefined();
    expect(store["msteams:direct:user-aad"].pendingSkillSuggestion).toBeUndefined();
    expect(store["msteams:direct:user-aad"].skillCaptureSignalHashes).toBeUndefined();
    expect(store["msteams:direct:user-aad"].pluginExtensionSlotKeys).toBeUndefined();
    expect(store["msteams:direct:user-aad"].futureTransientState).toBeUndefined();
    expect(store["msteams:direct:user-aad"].model).toBeUndefined();
    expect(store["msteams:direct:user-aad"].modelProvider).toBeUndefined();
    expect(store["msteams:direct:user-aad"].modelSelectionLocked).toBeUndefined();
    expect(store["msteams:direct:user-aad"].agentHarnessId).toBeUndefined();
    expect(store["msteams:direct:user-aad"].reasoningLevel).toBe("high");
    expect(store["msteams:direct:user-aad"].thinkingLevel).toBe("medium");
    expect(store["msteams:direct:user-aad"].verboseLevel).toBe("debug");
    expect(store["msteams:direct:user-aad"].ttsAuto).toBe("off");
    expect(store["msteams:direct:user-aad"].archivedAt).toBe(111);
    expect(store["msteams:direct:user-aad"].pinnedAt).toBe(222);
    expect(store["msteams:direct:user-aad"].lastReadAt).toBe(333);
    expect(store["msteams:direct:user-aad"].markedUnreadAt).toBe(444);
    expect(store["msteams:direct:user-aad"].providerOverride).toBe("openai");
    expect(store["msteams:direct:user-aad"].modelOverride).toBe("gpt-5");
    expect(store["msteams:direct:user-aad"].modelOverrideSource).toBe("user");
    expect(store["msteams:direct:user-aad"].modelOverrideRouteResolution).toBe("resolved");
    expect(store["msteams:direct:user-aad"].modelOverrideFallbackOriginProvider).toBeUndefined();
    expect(store["msteams:direct:user-aad"].modelOverrideFallbackOriginModel).toBeUndefined();
    expect(store["msteams:direct:user-aad"].authProfileOverride).toBe("work");
    expect(store["msteams:direct:user-aad"].authProfileOverrideSource).toBe("user");
    expect(store["msteams:direct:user-aad"].authProfileOverrideCompactionCount).toBe(7);
    expect(store["msteams:direct:user-aad"].groupActivation).toBe("mention");
    expect(store["msteams:direct:user-aad"].sendPolicy).toBe("allow");
    expect(store["msteams:direct:user-aad"].queueMode).toBe("collect");
    expect(store["msteams:direct:user-aad"].queueDebounceMs).toBe(500);
    expect(store["msteams:direct:user-aad"].queueCap).toBe(12);
    expect(store["msteams:direct:user-aad"].queueDrop).toBe("old");
    expect(store["msteams:direct:user-aad"].label).toBe("Dale");
    expect(store["msteams:direct:user-aad"].category).toBe("bots");
    expect(store["msteams:direct:user-aad"].displayName).toBe("Dale Botkin");
    expect(store["msteams:direct:user-aad"].responseUsage).toBe("tokens");
    expect(store["msteams:direct:other-user"].updatedAt).toBe(2_000);
  });

  it("propagates a lifecycle-owner failure after accepting the removal boundary", async () => {
    setupStore({
      "msteams:direct:user-aad": {
        sessionId: "old-session",
        updatedAt: 1_000,
        route: { channel: "msteams" },
      },
    });
    hoisted.resetSessionEntryLifecycle.mockRejectedValueOnce(
      new Error("timed out draining work before session lifecycle reset"),
    );
    const { deps, remove } = createDeps();

    await expect(
      handleMSTeamsLifecycleRemove(
        createContext({
          type: "installationUpdate",
          action: "remove",
          from: { aadObjectId: "user-aad" },
          recipient: { id: "bot-id" },
          conversation: { id: "19:personal-chat", conversationType: "personal" },
        }),
        deps,
      ),
    ).rejects.toThrow("timed out draining work before session lifecycle reset");
    expect(remove).toHaveBeenCalledWith("19:personal-chat");
    expect(hoisted.resetSessionEntryLifecycle).toHaveBeenCalledOnce();
  });

  it("does not route a personal lifecycle event through a Team binding that matches its tenant", async () => {
    const store = {
      "msteams:direct:user-aad": { sessionId: "personal-session", updatedAt: 1_000 },
      "msteams:direct:team-owner": { sessionId: "team-session", updatedAt: 2_000 },
    };
    setupStore(store);
    const resolveAgentRoute = vi.fn(
      (params: { peer: { id: string; kind: string }; teamId?: string }) =>
        params.teamId === "shared-tenant"
          ? {
              accountId: "default",
              agentId: "team-owner",
              sessionKey: "msteams:direct:team-owner",
            }
          : {
              accountId: "default",
              agentId: "default",
              sessionKey: `msteams:${params.peer.kind}:${params.peer.id}`,
            },
    );
    installMSTeamsTestRuntime({
      resetSessionEntryLifecycle: hoisted.resetSessionEntryLifecycle,
      resolveAgentRoute,
    });
    const { deps } = createDeps();

    const result = await handleMSTeamsLifecycleRemove(
      createContext({
        type: "installationUpdate",
        action: "remove",
        from: { aadObjectId: "user-aad" },
        recipient: { id: "bot-id" },
        conversation: {
          id: "19:personal-chat",
          conversationType: "personal",
          tenantId: "shared-tenant",
        },
      }),
      deps,
    );

    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { id: "user-aad", kind: "direct" },
        teamId: undefined,
      }),
    );
    expect(result.sessionsReset).toBe(1);
    expect(store["msteams:direct:user-aad"].sessionId).not.toBe("personal-session");
    expect(store["msteams:direct:team-owner"]).toEqual({
      sessionId: "team-session",
      updatedAt: 2_000,
    });
  });

  it("rotates a zero-timestamp session that still has Teams provider bindings", async () => {
    const store = {
      "msteams:direct:user-aad": {
        sessionId: "stale-provider-bound-session",
        updatedAt: 0,
        route: { channel: "msteams" },
        deliveryContext: { channel: "msteams", to: "user:user-aad" },
        lastChannel: "msteams",
        lastTo: "user:user-aad",
        lastAccountId: "default",
        origin: { provider: "msteams" },
      },
    };
    setupStore(store);
    const { deps, remove } = createDeps();

    const result = await handleMSTeamsLifecycleRemove(
      createContext({
        type: "installationUpdate",
        action: "remove",
        from: { id: "user-bf", aadObjectId: "user-aad" },
        recipient: { id: "bot-id" },
        conversation: {
          id: "19:personal-chat",
          conversationType: "personal",
        },
      }),
      deps,
    );

    expect(result).toEqual({
      handled: true,
      reason: "installation-remove",
      conversationRemoved: true,
      sessionsReset: 1,
    });
    expect(remove).toHaveBeenCalledWith("19:personal-chat");
    expect(store["msteams:direct:user-aad"].updatedAt).toBe(0);
    expect(store["msteams:direct:user-aad"].sessionId).not.toBe("stale-provider-bound-session");
    expect(store["msteams:direct:user-aad"].route).toBeUndefined();
    expect(store["msteams:direct:user-aad"].deliveryContext).toBeUndefined();
    expect(store["msteams:direct:user-aad"].lastChannel).toBeUndefined();
    expect(store["msteams:direct:user-aad"].lastTo).toBeUndefined();
    expect(store["msteams:direct:user-aad"].lastAccountId).toBeUndefined();
    expect(store["msteams:direct:user-aad"].origin).toBeUndefined();
  });

  it("clears automatic fallback selection and harness ownership during rotation", async () => {
    const store = {
      "msteams:direct:user-aad": {
        sessionId: "locked-fallback-session",
        updatedAt: 1_000,
        modelProvider: "anthropic",
        model: "claude-opus-4",
        modelSelectionLocked: true,
        agentHarnessId: "codex",
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4",
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: "openai",
        modelOverrideFallbackOriginModel: "gpt-5",
        authProfileOverride: "runtime-profile",
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 3,
      },
    };
    setupStore(store);
    const { deps } = createDeps();

    const result = await handleMSTeamsLifecycleRemove(
      createContext({
        type: "installationUpdate",
        action: "remove",
        from: { id: "user-bf", aadObjectId: "user-aad" },
        recipient: { id: "bot-id" },
        conversation: {
          id: "19:personal-chat",
          conversationType: "personal",
        },
      }),
      deps,
    );

    expect(result.sessionsReset).toBe(1);
    expect(store["msteams:direct:user-aad"].sessionId).not.toBe("locked-fallback-session");
    expect(store["msteams:direct:user-aad"].modelProvider).toBeUndefined();
    expect(store["msteams:direct:user-aad"].model).toBeUndefined();
    expect(store["msteams:direct:user-aad"].modelSelectionLocked).toBeUndefined();
    expect(store["msteams:direct:user-aad"].agentHarnessId).toBeUndefined();
    expect(store["msteams:direct:user-aad"].providerOverride).toBeUndefined();
    expect(store["msteams:direct:user-aad"].modelOverride).toBeUndefined();
    expect(store["msteams:direct:user-aad"].modelOverrideSource).toBeUndefined();
    expect(store["msteams:direct:user-aad"].modelOverrideFallbackOriginProvider).toBeUndefined();
    expect(store["msteams:direct:user-aad"].modelOverrideFallbackOriginModel).toBeUndefined();
    expect(store["msteams:direct:user-aad"].authProfileOverride).toBeUndefined();
    expect(store["msteams:direct:user-aad"].authProfileOverrideSource).toBeUndefined();
    expect(store["msteams:direct:user-aad"].authProfileOverrideCompactionCount).toBeUndefined();
  });

  it("preserves legacy explicit model selection when no fallback provenance exists", async () => {
    const store: Record<string, SessionEntry> = {
      "msteams:direct:user-aad": {
        sessionId: "legacy-user-selection-session",
        updatedAt: 1_000,
        providerOverride: "openai",
        modelOverride: "gpt-5",
      },
    };
    setupStore(store);
    const { deps } = createDeps();

    const result = await handleMSTeamsLifecycleRemove(
      createContext({
        type: "installationUpdate",
        action: "remove",
        from: { id: "user-bf", aadObjectId: "user-aad" },
        recipient: { id: "bot-id" },
        conversation: {
          id: "19:personal-chat",
          conversationType: "personal",
        },
      }),
      deps,
    );

    expect(result.sessionsReset).toBe(1);
    const resetEntry = store["msteams:direct:user-aad"]!;
    expect(resetEntry.sessionId).not.toBe("legacy-user-selection-session");
    expect(resetEntry.providerOverride).toBe("openai");
    expect(resetEntry.modelOverride).toBe("gpt-5");
    expect(resetEntry.modelOverrideSource).toBe("user");
  });

  it("does not recount a clean zero-timestamp session that has no Teams provider bindings", async () => {
    const store = {
      "msteams:direct:user-aad": {
        sessionId: "already-reset-session",
        updatedAt: 0,
      },
    };
    setupStore(store);
    const { deps, remove } = createDeps();

    const result = await handleMSTeamsLifecycleRemove(
      createContext({
        type: "installationUpdate",
        action: "remove",
        from: { id: "user-bf", aadObjectId: "user-aad" },
        recipient: { id: "bot-id" },
        conversation: {
          id: "19:personal-chat",
          conversationType: "personal",
        },
      }),
      deps,
    );

    expect(result).toEqual({
      handled: true,
      reason: "installation-remove",
      conversationRemoved: true,
      sessionsReset: 0,
    });
    expect(remove).toHaveBeenCalledWith("19:personal-chat");
    expect(store["msteams:direct:user-aad"]).toEqual({
      sessionId: "already-reset-session",
      updatedAt: 0,
    });
  });

  it("treats remove-upgrade as a removal boundary", async () => {
    const store = {
      "msteams:direct:user-aad": { sessionId: "old-session", updatedAt: 1_000 },
    };
    setupStore(store);
    const { deps } = createDeps();

    const result = await handleMSTeamsLifecycleRemove(
      createContext({
        type: "installationUpdate",
        action: "remove-upgrade",
        from: { id: "user-bf", aadObjectId: "user-aad" },
        recipient: { id: "bot-id" },
        conversation: {
          id: "19:personal-chat",
          conversationType: "personal",
        },
      }),
      deps,
    );

    expect(result.sessionsReset).toBe(1);
    expect(store["msteams:direct:user-aad"].updatedAt).toBe(0);
    expect(store["msteams:direct:user-aad"].sessionId).not.toBe("old-session");
  });

  it("ignores first-install add events when no existing session is active", async () => {
    const store: Record<string, SessionEntry> = {};
    setupStore(store);
    const { deps, remove } = createDeps();

    const result = await handleMSTeamsLifecycleRemove(
      createContext({
        type: "installationUpdate",
        action: "add",
        from: { id: "user-bf", aadObjectId: "user-aad" },
        recipient: { id: "bot-id" },
        conversation: {
          id: "19:personal-chat",
          conversationType: "personal",
        },
      }),
      deps,
    );

    expect(result).toEqual({
      handled: false,
      reason: "installation-add-existing",
      conversationRemoved: false,
      sessionsReset: 0,
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it("rotates a personal app add event when an existing session is active", async () => {
    const store = {
      "msteams:direct:user-aad": { sessionId: "old-session", updatedAt: 1_000 },
    };
    setupStore(store);
    const { deps, remove } = createDeps();

    const result = await handleMSTeamsLifecycleRemove(
      createContext({
        type: "installationUpdate",
        action: "add",
        from: { id: "user-bf", aadObjectId: "user-aad" },
        recipient: { id: "bot-id" },
        conversation: {
          id: "19:personal-chat",
          conversationType: "personal",
        },
      }),
      deps,
    );

    expect(result).toEqual({
      handled: true,
      reason: "installation-add-existing",
      conversationRemoved: false,
      sessionsReset: 1,
    });
    expect(remove).not.toHaveBeenCalled();
    expect(store["msteams:direct:user-aad"].updatedAt).toBe(0);
    expect(store["msteams:direct:user-aad"].sessionId).not.toBe("old-session");
  });

  it("does not treat channel installation add events as reinstall boundaries", async () => {
    const store = {
      "msteams:channel:19:team-channel@thread.tacv2": {
        sessionId: "base",
        updatedAt: 1_000,
      },
    };
    setupStore(store);
    const { deps, remove } = createDeps();

    const result = await handleMSTeamsLifecycleRemove(
      createContext({
        type: "installationUpdate",
        action: "add",
        from: { id: "user-bf", aadObjectId: "user-aad" },
        recipient: { id: "bot-id" },
        conversation: {
          id: "19:team-channel@thread.tacv2",
          conversationType: "channel",
        },
      }),
      deps,
    );

    expect(result).toEqual({
      handled: false,
      reason: "installation-add-existing",
      conversationRemoved: false,
      sessionsReset: 0,
    });
    expect(remove).not.toHaveBeenCalled();
    expect(hoisted.listSessionEntries).not.toHaveBeenCalled();
    expect(store["msteams:channel:19:team-channel@thread.tacv2"].updatedAt).toBe(1_000);
  });

  it("does not treat channel removal events as personal-session boundaries", async () => {
    const channelId = "19:team-channel@thread.tacv2";
    const baseKey = `msteams:channel:${channelId}`;
    const threadKey = `${baseKey}:thread:root-message`;
    const unrelatedKey = "msteams:channel:19:other-channel@thread.tacv2";
    const store = {
      [baseKey]: { sessionId: "base", updatedAt: 1_000 },
      [threadKey]: { sessionId: "thread", updatedAt: 2_000 },
      [unrelatedKey]: { sessionId: "other", updatedAt: 3_000 },
    };
    setupStore(store);
    const { deps, remove } = createDeps();

    const result = await handleMSTeamsLifecycleRemove(
      createContext({
        type: "conversationUpdate",
        from: { id: "teams-service" },
        recipient: { id: "bot-id" },
        membersRemoved: [{ id: "bot-id" }],
        conversation: {
          id: channelId,
          conversationType: "channel",
        },
        channelData: {
          team: { id: "team-id" },
          eventType: "teamMemberRemoved",
        },
      }),
      deps,
    );

    expect(result).toEqual({
      handled: true,
      reason: "bot-members-removed",
      conversationRemoved: true,
      sessionsReset: 0,
    });
    expect(remove).toHaveBeenCalledWith(channelId);
    expect(store[baseKey].updatedAt).toBe(1_000);
    expect(store[baseKey].sessionId).toBe("base");
    expect(store[threadKey].updatedAt).toBe(2_000);
    expect(store[threadKey].sessionId).toBe("thread");
    expect(store[unrelatedKey].updatedAt).toBe(3_000);
  });

  it("ignores membersRemoved events that do not remove the bot", async () => {
    const store = {
      "msteams:channel:19:team-channel@thread.tacv2": {
        sessionId: "base",
        updatedAt: 1_000,
      },
    };
    setupStore(store);
    const { deps, remove } = createDeps();

    const result = await handleMSTeamsLifecycleRemove(
      createContext({
        type: "conversationUpdate",
        recipient: { id: "bot-id" },
        membersRemoved: [{ id: "user-id" }],
        conversation: {
          id: "19:team-channel@thread.tacv2",
          conversationType: "channel",
        },
      }),
      deps,
    );

    expect(result.handled).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    expect(hoisted.listSessionEntries).not.toHaveBeenCalled();
    expect(store["msteams:channel:19:team-channel@thread.tacv2"].updatedAt).toBe(1_000);
  });

  it("does not reset a matching session that changed after the list snapshot", async () => {
    const store = {
      "msteams:direct:user-aad": {
        sessionId: "fresh-session",
        updatedAt: 2_000,
      },
    };
    setupStore(store);
    hoisted.listSessionEntries.mockReturnValue([
      {
        sessionKey: "msteams:direct:user-aad",
        entry: {
          sessionId: "old-session",
          updatedAt: 1_000,
        },
      },
    ]);
    const { deps } = createDeps();

    const result = await handleMSTeamsLifecycleRemove(
      createContext({
        type: "installationUpdate",
        action: "remove",
        from: { id: "user-bf", aadObjectId: "user-aad" },
        recipient: { id: "bot-id" },
        conversation: {
          id: "19:personal-chat",
          conversationType: "personal",
        },
      }),
      deps,
    );

    expect(result.sessionsReset).toBe(0);
    expect(store["msteams:direct:user-aad"].updatedAt).toBe(2_000);
    expect(store["msteams:direct:user-aad"].sessionId).toBe("fresh-session");
  });

  it("rotates a personal DM session when the stored conversation id changes", async () => {
    const store = {
      "msteams:direct:user-aad": {
        sessionId: "old-session",
        updatedAt: 1_000,
        route: { channel: "msteams" },
        deliveryContext: { channel: "msteams" },
        lastChannel: "msteams",
        lastTo: "user:user-aad",
        lastAccountId: "default",
        origin: { provider: "msteams" },
      },
    };
    setupStore(store);
    const { deps, remove } = createDeps();
    vi.mocked(deps.conversationStore.list).mockResolvedValue([
      {
        conversationId: "a:old-personal-chat",
        reference: {
          lastSeenAt: "2026-07-05T12:00:00.000Z",
          user: { id: "29:user", aadObjectId: "user-aad" },
          agent: { id: "bot-id", name: "Bot" },
          bot: { id: "bot-id", name: "Bot" },
          conversation: {
            id: "a:old-personal-chat",
            conversationType: "personal",
          },
        },
      },
    ]);

    const result = await handleMSTeamsDmConversationBoundary({
      deps,
      conversationId: "a:new-personal-chat",
      senderId: "user-aad",
      botId: "bot-id",
      routeSessionKey: "msteams:direct:user-aad",
      agentId: "default",
    });

    expect(result).toEqual({
      handled: true,
      previousConversationRemoved: true,
      sessionsReset: 1,
    });
    expect(remove).toHaveBeenCalledWith("a:old-personal-chat");
    expect(store["msteams:direct:user-aad"].updatedAt).toBe(0);
    expect(store["msteams:direct:user-aad"].sessionId).not.toBe("old-session");
    expect(store["msteams:direct:user-aad"].route).toBeUndefined();
    expect(store["msteams:direct:user-aad"].deliveryContext).toBeUndefined();
    expect(store["msteams:direct:user-aad"].lastChannel).toBeUndefined();
    expect(store["msteams:direct:user-aad"].origin).toBeUndefined();
  });

  it("does not rotate a personal DM session when the stored conversation id matches", async () => {
    const store = {
      "msteams:direct:user-aad": { sessionId: "old-session", updatedAt: 1_000 },
    };
    setupStore(store);
    const { deps, remove } = createDeps();
    vi.mocked(deps.conversationStore.list).mockResolvedValue([
      {
        conversationId: "a:personal-chat",
        reference: {
          lastSeenAt: "2026-07-05T12:00:00.000Z",
          user: { id: "29:user", aadObjectId: "user-aad" },
          agent: { id: "bot-id", name: "Bot" },
          conversation: {
            id: "a:personal-chat",
            conversationType: "personal",
          },
        },
      },
    ]);

    const result = await handleMSTeamsDmConversationBoundary({
      deps,
      conversationId: "a:personal-chat",
      senderId: "user-aad",
      botId: "bot-id",
      routeSessionKey: "msteams:direct:user-aad",
      agentId: "default",
    });

    expect(result).toEqual({
      handled: false,
      previousConversationRemoved: false,
      sessionsReset: 0,
    });
    expect(remove).not.toHaveBeenCalled();
    expect(hoisted.listSessionEntries).not.toHaveBeenCalled();
    expect(store["msteams:direct:user-aad"].updatedAt).toBe(1_000);
  });

  it("does not rotate a personal DM session for a different stored bot", async () => {
    const store = {
      "msteams:direct:user-aad": { sessionId: "old-session", updatedAt: 1_000 },
    };
    setupStore(store);
    const { deps, remove } = createDeps();
    vi.mocked(deps.conversationStore.list).mockResolvedValue([
      {
        conversationId: "a:old-personal-chat",
        reference: {
          lastSeenAt: "2026-07-05T12:00:00.000Z",
          user: { id: "29:user", aadObjectId: "user-aad" },
          agent: { id: "other-bot-id", name: "Other Bot" },
          conversation: {
            id: "a:old-personal-chat",
            conversationType: "personal",
          },
        },
      },
    ]);

    const result = await handleMSTeamsDmConversationBoundary({
      deps,
      conversationId: "a:new-personal-chat",
      senderId: "user-aad",
      botId: "bot-id",
      routeSessionKey: "msteams:direct:user-aad",
      agentId: "default",
    });

    expect(result).toEqual({
      handled: false,
      previousConversationRemoved: false,
      sessionsReset: 0,
    });
    expect(remove).not.toHaveBeenCalled();
    expect(hoisted.listSessionEntries).not.toHaveBeenCalled();
    expect(store["msteams:direct:user-aad"].updatedAt).toBe(1_000);
  });
});

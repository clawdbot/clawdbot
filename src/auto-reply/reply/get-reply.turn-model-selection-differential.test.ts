import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRef } from "../../agents/model-ref-shared.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPathInside } from "../../infra/path-guards.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import {
  TURN_MODEL_CHANNEL_REF,
  TURN_MODEL_DEFAULT_REF,
  TURN_MODEL_DIFFERENTIAL_FIXTURES,
  TURN_MODEL_LIVE_CHANNEL_REF,
  TURN_MODEL_OVERRIDE_REF,
  TURN_MODEL_PERSISTED_CHANNEL_REF,
  TURN_MODEL_PERSISTED_PEER_REF,
  TURN_MODEL_SESSION_REF,
  createTurnModelEntry,
  turnModelRefLabel,
  turnModelVerdict,
  type TurnModelDifferentialFixture,
  type TurnModelSelectionPath,
  type TurnModelSelectionVerdict,
} from "../../test-utils/turn-model-selection-differential.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.test-support.js";
import {
  buildGetReplyCtx,
  createGetReplyContinueDirectivesResult,
  createGetReplySessionState,
  registerGetReplyBaselineBypass,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import "./get-reply.test-runtime-mocks.js";

const mocks = vi.hoisted(() => ({
  handleInlineActions: vi.fn(),
  initSessionState: vi.fn(),
  resolveReplyDirectives: vi.fn(),
}));

registerGetReplyBaselineBypass();
registerGetReplyRuntimeOverrides(mocks);

let state: OpenClawTestState;

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
let resolveAgentWorkspaceDirMock: typeof import("../../agents/agent-scope.js").resolveAgentWorkspaceDir;
let resolveDefaultModelMock: typeof import("./directive-handling.defaults.js").resolveDefaultModel;
let resolveChannelModelOverrideMock: typeof import("../../channels/model-overrides.js").resolveChannelModelOverride;
let runPreparedReplyMock: typeof import("./get-reply-run.js").runPreparedReply;

function createConfig(params: {
  storePath: string;
  workspaceDir: string;
  modelByChannel?: Record<string, Record<string, string>>;
}): OpenClawConfig {
  return markCompleteReplyConfig({
    session: { store: params.storePath },
    agents: {
      defaults: {
        model: { primary: turnModelRefLabel(TURN_MODEL_DEFAULT_REF) },
        modelPolicy: { allow: ["*/*"] },
        workspace: params.workspaceDir,
      },
    },
    channels: params.modelByChannel ? { modelByChannel: params.modelByChannel } : undefined,
  } as OpenClawConfig);
}

async function seedFixtureStore(
  storePath: string,
  sessionKey: string,
  fixture: Pick<TurnModelDifferentialFixture, "child" | "parent">,
): Promise<Record<string, SessionEntry>> {
  const sqliteTarget = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
  expect(isPathInside(state.root, sqliteTarget.path)).toBe(true);
  const store: Record<string, SessionEntry> = { [sessionKey]: fixture.child };
  replaceSessionEntrySync({ storePath, sessionKey }, fixture.child);
  if (fixture.parent) {
    store[fixture.parent.key] = fixture.parent.entry;
    replaceSessionEntrySync({ storePath, sessionKey: fixture.parent.key }, fixture.parent.entry);
  }
  return store;
}

async function observeReplySelection(params: {
  fixture: TurnModelDifferentialFixture;
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry>;
}): Promise<TurnModelSelectionVerdict> {
  const { fixture, cfg, sessionKey, sessionStore } = params;
  mocks.initSessionState.mockResolvedValue(
    createGetReplySessionState({
      sessionCtx: fixture.ctx,
      sessionEntry: fixture.child,
      sessionStore,
      sessionKey,
      sessionId: fixture.child.sessionId,
      storePath: cfg.session?.store,
      groupResolution:
        fixture.child.chatType === "group"
          ? { channel: undefined, id: fixture.child.groupId, type: "group" }
          : undefined,
      isGroup: fixture.child.chatType === "group",
      triggerBodyNormalized: "hello",
      bodyStripped: "hello",
    }),
  );
  vi.mocked(runPreparedReplyMock).mockClear();
  // Use the same module as getReply so a shared resolver override cannot escape this fixture.
  expect(isPathInside(state.root, resolveAgentWorkspaceDirMock(cfg, "main"))).toBe(true);
  // Routing fixtures own their prepared generation just like admitted turns;
  // provider execution is stubbed, so missing hooks must not cold-activate plugins.
  await withPluginRuntimeGenerationScope(
    {
      config: cfg,
      metadataSnapshot: createPluginMetadataSnapshot({
        config: cfg,
        workspaceDir: state.workspaceDir,
        manifestRegistry: makeRegistry([]),
      }),
      pluginRegistry: createSessionConversationTestRegistry(),
    },
    () =>
      getReplyFromConfig(
        buildGetReplyCtx({ SessionKey: sessionKey, ...fixture.ctx }),
        fixture.heartbeat
          ? {
              isHeartbeat: true,
              heartbeatModelOverride: turnModelRefLabel(TURN_MODEL_OVERRIDE_REF),
            }
          : undefined,
        cfg,
      ),
  );
  const selected = vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0];
  if (!selected) {
    throw new Error(`reply path did not prepare a run for ${fixture.name}`);
  }
  return turnModelVerdict(
    { provider: selected.provider, model: selected.model },
    fixture.locked ? "locked" : undefined,
  );
}

beforeAll(async () => {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
  ({ resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock } =
    await import("../../agents/agent-scope.js"));
  ({ resolveDefaultModel: resolveDefaultModelMock } =
    await import("./directive-handling.defaults.js"));
  ({ resolveChannelModelOverride: resolveChannelModelOverrideMock } =
    await import("../../channels/model-overrides.js"));
  ({ runPreparedReply: runPreparedReplyMock } = await import("./get-reply-run.js"));
});

beforeEach(async () => {
  state = await createOpenClawTestState({
    label: "turn-model-reply",
    env: { OPENCLAW_TEST_FAST: "1" },
  });
  const actualChannelModel = await vi.importActual<
    typeof import("../../channels/model-overrides.js")
  >("../../channels/model-overrides.js");
  const actualModelSelection = await vi.importActual<
    typeof import("../../agents/model-selection.js")
  >("../../agents/model-selection.js");
  vi.mocked(resolveChannelModelOverrideMock).mockImplementation(
    actualChannelModel.resolveChannelModelOverride,
  );
  vi.mocked(resolveDefaultModelMock).mockReturnValue({
    defaultProvider: TURN_MODEL_DEFAULT_REF.provider,
    defaultModel: TURN_MODEL_DEFAULT_REF.model,
    aliasIndex: actualModelSelection.buildModelAliasIndex({
      cfg: {},
      defaultProvider: TURN_MODEL_DEFAULT_REF.provider,
    }),
  });
  mocks.resolveReplyDirectives.mockImplementation(async (input: unknown) => {
    const params = input as {
      provider: string;
      model: string;
      sessionKey: string;
      triggerBodyNormalized: string;
    };
    return createGetReplyContinueDirectivesResult({
      body: params.triggerBodyNormalized,
      abortKey: params.sessionKey,
      from: "sender",
      to: "target",
      senderId: "sender",
      commandSource: "text",
      senderIsOwner: true,
      resetHookTriggered: false,
      provider: params.provider,
      model: params.model,
    });
  });
  mocks.handleInlineActions.mockImplementation(async (input: unknown) => {
    const params = input as { directives?: unknown; cleanedBody?: string };
    return {
      kind: "continue",
      directives: params.directives ?? {},
      cleanedBody: params.cleanedBody ?? "hello",
      abortedLastRun: false,
    };
  });
  vi.mocked(runPreparedReplyMock).mockResolvedValue({ text: "ok" });
});

afterEach(async () => {
  await state.cleanup();
});

describe("getReplyFromConfig channel model input boundary", () => {
  const matrix: Array<{
    name: string;
    childOverride?: ModelRef;
    directUserId?: string;
    groupId?: string;
    groupChannel?: string;
    omitPersistedChannel?: boolean;
    omitChannelConfig?: boolean;
    expected: ModelRef;
  }> = [
    {
      name: "child stored override",
      childOverride: TURN_MODEL_SESSION_REF,
      expected: TURN_MODEL_SESSION_REF,
    },
    {
      name: "persisted direct peer",
      directUserId: "persisted-peer",
      expected: TURN_MODEL_PERSISTED_PEER_REF,
    },
    {
      name: "persisted delivery channel exact conversation",
      expected: TURN_MODEL_PERSISTED_CHANNEL_REF,
    },
    {
      name: "live channel exact conversation",
      omitPersistedChannel: true,
      expected: TURN_MODEL_LIVE_CHANNEL_REF,
    },
    {
      name: "parent conversation key",
      groupId: "unmatched",
      groupChannel: "parent-room",
      expected: TURN_MODEL_CHANNEL_REF,
    },
    {
      name: "wildcard",
      groupId: "unmatched",
      expected: TURN_MODEL_CHANNEL_REF,
    },
    {
      name: "default",
      groupId: "unmatched",
      omitChannelConfig: true,
      expected: TURN_MODEL_DEFAULT_REF,
    },
  ];

  it.each(matrix)("selects $name", async (testCase) => {
    const storePath = path.join(state.sessionsDir("main"), "sessions.json");
    const sessionKey = "agent:main:telegram:group:room";
    const child = createTurnModelEntry({
      channel: testCase.omitPersistedChannel ? undefined : "discord",
      chatType: testCase.directUserId ? "direct" : "group",
      groupId: testCase.directUserId ? undefined : (testCase.groupId ?? "room"),
      groupChannel: testCase.groupChannel,
      directUserId: testCase.directUserId,
      override: testCase.childOverride,
    });
    const fixture: TurnModelDifferentialFixture = {
      name: testCase.name,
      ctx: {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        ChatType: testCase.directUserId ? "direct" : "group",
        SenderId: "live-peer",
      },
      child,
      modelByChannel: testCase.omitChannelConfig
        ? undefined
        : {
            discord: {
              room: turnModelRefLabel(TURN_MODEL_PERSISTED_CHANNEL_REF),
              "persisted-peer": turnModelRefLabel(TURN_MODEL_PERSISTED_PEER_REF),
              "parent-room": turnModelRefLabel(TURN_MODEL_CHANNEL_REF),
              "*": turnModelRefLabel(TURN_MODEL_CHANNEL_REF),
            },
            telegram: {
              room: turnModelRefLabel(TURN_MODEL_LIVE_CHANNEL_REF),
              "*": turnModelRefLabel(TURN_MODEL_CHANNEL_REF),
            },
          },
      expected: {} as Record<TurnModelSelectionPath, TurnModelSelectionVerdict>,
    };
    const sessionStore = await seedFixtureStore(storePath, sessionKey, fixture);
    const cfg = createConfig({
      storePath,
      workspaceDir: state.workspaceDir,
      modelByChannel: fixture.modelByChannel,
    });
    await expect(
      observeReplySelection({ fixture, cfg, sessionKey, sessionStore }),
    ).resolves.toEqual(turnModelVerdict(testCase.expected));
  });
});

describe("turn model selection reply-path differential", () => {
  it.each(TURN_MODEL_DIFFERENTIAL_FIXTURES)("pins observed $name behavior", async (fixture) => {
    const storePath = path.join(state.sessionsDir("main"), "sessions.json");
    const sessionKey = "agent:main:telegram:group:selection";
    const sessionStore = await seedFixtureStore(storePath, sessionKey, fixture);
    const cfg = createConfig({
      storePath,
      workspaceDir: state.workspaceDir,
      modelByChannel: fixture.modelByChannel,
    });

    await expect(
      observeReplySelection({ fixture, cfg, sessionKey, sessionStore }),
    ).resolves.toEqual(fixture.expected.reply);
  });
});

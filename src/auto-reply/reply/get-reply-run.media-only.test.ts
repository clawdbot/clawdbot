// Tests media-only get-reply runs and sandboxed media attachment handling.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER } from "../../agents/main-session-recovery/main-session-recovery-admission.js";
import type { SessionEntry } from "../../config/sessions.js";
import { withSystemEventOwner } from "../../infra/system-event-ownership.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { MESSAGE_TOOL_ONLY_DELIVERY_HINT } from "../../plugin-sdk/message-tool-delivery-hints.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { hasControlCommand } from "../command-detection.js";
import { runReplyAgent } from "./agent-runner.runtime.js";
import { resolveReplyDirectiveRouting } from "./get-reply-directives-routing.js";
import { prepareReplyRunContext } from "./get-reply-run-context.js";
import {
  loadAgentRunnerRuntime,
  loadEmbeddedAgentRuntime,
  loadSessionUpdatesRuntime,
} from "./get-reply-run-helpers.js";
import { runPreparedReply } from "./get-reply-run.js";
import { buildDirectChatContext, buildGroupChatContext, buildGroupIntro } from "./groups.js";
import { finalizeInboundContext, finalizeInboundContextForSdk } from "./inbound-context.js";
import {
  buildInboundUserContextPrefix,
  resolveInboundUserContextPromptJoiner,
} from "./inbound-meta.js";
import {
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  createReplyOperation,
  getActiveReplyRunCount,
} from "./reply-run-registry.js";
import { testing as replyRunTesting } from "./reply-run-registry.test-support.js";
import { routeReply } from "./route-reply.runtime.js";
import { drainFormattedSystemEvents } from "./session-system-events.js";
import {
  createSourceReplyDeliveryRuntime,
  readSourceReplyDeliveryRuntime,
  type SourceReplyDeliveryRuntimeOptions,
} from "./source-reply-delivery-runtime.js";
import { buildChannelSourceTurnId } from "./source-turn-id.js";
import { withReplySystemEventSessionKey } from "./system-event-session-key.js";
import { resolveTypingMode } from "./typing-mode.js";

vi.mock("../../agents/auth-profiles/session-override.js", () => ({
  resolveSessionAuthSelection: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../agents/embedded-agent.runtime.js", () => ({
  abortEmbeddedAgentRun: vi.fn().mockReturnValue(false),
  isEmbeddedAgentRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedAgentRunStreaming: vi.fn().mockReturnValue(false),
  preemptAndDrainEmbeddedHeartbeatRun: vi.fn().mockResolvedValue("not-heartbeat"),
  resolveActiveEmbeddedRunSessionId: vi.fn().mockReturnValue(undefined),
  resolveActiveEmbeddedRunSessionIdBySessionFile: vi.fn().mockReturnValue(undefined),
  resolveEmbeddedSessionLane: vi.fn().mockReturnValue("session:session-key"),
  waitForEmbeddedAgentRunEnd: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../agents/harness/hook-helpers.js", () => ({
  runAgentHarnessBeforeMessageWriteHook: vi.fn((params: { message: unknown }) => params.message),
}));

// Harness selection and built-in execution are owned by their focused suites. These tests keep
// the real visible-reply policy resolver while supplying its default OpenClaw harness leaf.
const preparedReplyMockState = vi.hoisted(() => ({
  unexpectedCalls: [] as string[],
}));
const envMockState = vi.hoisted(() => ({ fastTestRuntime: true }));

vi.mock("../../infra/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/env.js")>()),
  isFastTestRuntimeEnv: () => envMockState.fastTestRuntime,
}));

vi.mock("../../agents/main-session-recovery/main-session-recovery-owner-release.js", () => ({
  scheduleMainSessionRecoveryPendingTarget: vi.fn(),
}));

vi.mock("../../agents/main-session-recovery/main-session-recovery-state.js", () => ({
  isMainRestartRecoveryCandidate: vi.fn().mockReturnValue(false),
}));

vi.mock("../../agents/main-session-recovery/main-session-recovery-store.js", () => ({
  claimMainSessionRecoveryOwner: vi.fn(),
  releaseMainSessionRecoveryOwner: vi.fn(),
}));

// Provider profile discovery is owned by thinking.test.ts. Keep the real thinking-policy
// projection here while preventing an unrelated active-plugin and public-artifact graph load.
vi.mock("../../plugins/provider-thinking.js", () => ({
  resolveEffectiveThinkingProfile: () => undefined,
}));

vi.mock("../../agents/agent-tools.policy.js", () => ({
  resolveEffectiveToolPolicy: (params: {
    config: { tools?: { allow?: string[]; deny?: string[] } };
  }) => ({
    globalPolicy: params.config.tools
      ? { allow: params.config.tools.allow, deny: params.config.tools.deny }
      : undefined,
    globalProviderPolicy: undefined,
    agentPolicy: undefined,
    agentProviderPolicy: undefined,
    profile: undefined,
    providerProfile: undefined,
    profileAlsoAllow: undefined,
    providerProfileAlsoAllow: undefined,
  }),
  resolveGroupToolPolicy: () => undefined,
  resolveInheritedToolPolicyForSession: () => undefined,
  resolveSubagentToolPolicyForSession: () => undefined,
}));

vi.mock("../../agents/subagents/spawn/subagent-capabilities.js", () => ({
  isSubagentEnvelopeSession: vi.fn().mockReturnValue(false),
  resolveSubagentCapabilityStore: vi.fn().mockReturnValue(undefined),
}));

const selectAgentHarnessMock = vi.hoisted(() =>
  vi.fn(
    (params: {
      provider: string;
      modelId?: string;
      agentHarnessId?: string;
      agentHarnessRuntimeOverride?: string;
    }) => {
      const isSourceProviderCandidate = params.modelId === undefined;
      const isDefaultModelCandidate =
        params.provider === "anthropic" && params.modelId === "claude-opus-4-1";
      if (
        (!isSourceProviderCandidate && !isDefaultModelCandidate) ||
        params.agentHarnessId ||
        params.agentHarnessRuntimeOverride
      ) {
        preparedReplyMockState.unexpectedCalls.push("selectAgentHarness");
      }
      return { id: "openclaw", deliveryDefaults: {} };
    },
  ),
);
vi.mock("../../agents/harness/selection.js", () => ({
  selectAgentHarness: selectAgentHarnessMock,
}));

vi.mock("../../agents/model-selection.js", () => ({
  buildModelAliasIndex: vi.fn(
    (params: { cfg: { agents?: { defaults?: { models?: unknown } } } }) => {
      if (params.cfg.agents?.defaults?.models) {
        preparedReplyMockState.unexpectedCalls.push("buildModelAliasIndex");
      }
      return { byAlias: new Map(), byKey: new Map() };
    },
  ),
  resolveDefaultModelForAgent: vi.fn(
    (params: { cfg: { agents?: { defaults?: { model?: unknown } } } }) => {
      if (params.cfg.agents?.defaults?.model) {
        preparedReplyMockState.unexpectedCalls.push("resolveDefaultModelForAgent");
      }
      return { provider: "anthropic", model: "claude-opus-4-1" };
    },
  ),
  resolveModelRefFromString: vi.fn(() => {
    preparedReplyMockState.unexpectedCalls.push("resolveModelRefFromString");
    return undefined;
  }),
}));

const resolveSessionRuntimeOverrideForProviderMock = vi.hoisted(() =>
  vi.fn(
    (params: {
      entry?: {
        agentHarnessId?: string;
        agentRuntimeOverride?: string;
        modelSelectionLocked?: boolean;
      };
    }) => {
      if (
        params.entry?.agentHarnessId ||
        params.entry?.agentRuntimeOverride ||
        params.entry?.modelSelectionLocked
      ) {
        preparedReplyMockState.unexpectedCalls.push("resolveSessionRuntimeOverrideForProvider");
      }
      return undefined;
    },
  ),
);
vi.mock("../../agents/session-runtime-compat.js", () => ({
  resolveSessionRuntimeOverrideForProvider: resolveSessionRuntimeOverrideForProviderMock,
}));

// Provider policy projection belongs to its adapter and provider-local suites. These tests
// exercise prepared reply orchestration and supply their own model/thinking facts.
vi.mock("../../plugins/provider-policy-surface.js", () => ({
  resolveDirectBundledProviderPolicySurface: () => null,
  resolveTrustedExternalProviderPolicySurface: () => null,
}));

vi.mock("../../config/sessions/group.js", () => ({
  resolveGroupSessionKey: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionFilePathCore: vi.fn().mockReturnValue("/tmp/session.jsonl"),
  resolveSessionFilePathOptions: vi.fn().mockReturnValue({}),
}));

const loadSessionEntryMock = vi.hoisted(() => vi.fn());
const updateAmbientTranscriptWatermarkMock = vi.hoisted(() => vi.fn().mockResolvedValue(null));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  listSessionEntriesCore: vi.fn().mockReturnValue([]),
  loadSessionEntry: loadSessionEntryMock,
  patchSessionEntryCore: vi.fn(),
  persistSessionTranscriptTurn: vi.fn(),
}));

vi.mock("../../config/sessions/ambient-transcript-watermark.js", () => ({
  updateAmbientTranscriptWatermark: updateAmbientTranscriptWatermarkMock,
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../process/command-queue.js", () => ({
  clearCommandLane: vi.fn().mockReturnValue(0),
  getQueueSize: vi.fn().mockReturnValue(0),
}));

vi.mock(import("../../routing/session-key.js"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../routing/session-key.js")>();
  return {
    ...actual,
    normalizeMainKey: () => "main",
    normalizeAgentId: vi.fn((id: string | undefined | null) => id ?? "default"),
  };
});

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: vi.fn().mockReturnValue(false),
}));

vi.mock("../command-detection.js", () => ({
  hasControlCommand: vi.fn().mockReturnValue(false),
}));

vi.mock("./agent-runner.runtime.js", () => ({
  runReplyAgent: vi.fn().mockResolvedValue({ text: "ok" }),
}));

vi.mock("./body.js", () => ({
  applySessionHints: vi.fn().mockImplementation(async ({ baseBody }) => baseBody),
}));

const resolveCurrentTurnImagesMock = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock("./current-turn-images.js", () => ({
  resolveCurrentTurnImages: resolveCurrentTurnImagesMock,
}));

vi.mock("./get-reply-fast-path.js", () => ({
  shouldUseReplyFastTestRuntime: vi.fn().mockReturnValue(false),
}));

vi.mock("./groups.js", () => ({
  buildDirectChatContext: vi.fn().mockReturnValue(""),
  buildGroupIntro: vi.fn().mockReturnValue(""),
  buildGroupChatContext: vi.fn().mockReturnValue(""),
}));

vi.mock("./inbound-meta.js", () => ({
  buildInboundMetaSystemPrompt: vi.fn().mockReturnValue(""),
  buildInboundUserContextPrefix: vi.fn().mockReturnValue(""),
  formatActiveGoalContext: vi.fn().mockReturnValue(undefined),
  resolveInboundUserContextPromptJoiner: vi.fn().mockReturnValue(undefined),
}));

vi.mock("./queue/settings-runtime.js", () => ({
  resolveQueueSettings: vi.fn().mockReturnValue({ mode: "steer" }),
}));

vi.mock("./route-reply.runtime.js", () => ({
  routeReply: vi.fn(),
}));

vi.mock("./session-updates.runtime.js", () => ({
  ensureSkillSnapshot: vi.fn().mockImplementation(async ({ sessionEntry, systemSent }) => ({
    sessionEntry,
    systemSent,
    skillsSnapshot: undefined,
  })),
}));

vi.mock("./session-system-events.js", () => ({
  drainFormattedSystemEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../sessions/stored-model-overrides.js", () => ({
  resolveStoredModelOverride: vi.fn(
    (params: {
      sessionEntry?: { providerOverride?: string; modelOverride?: string };
      sessionStore?: Record<string, { providerOverride?: string; modelOverride?: string }>;
    }) => {
      const entries = [params.sessionEntry, ...Object.values(params.sessionStore ?? {})];
      if (entries.some((entry) => entry?.providerOverride || entry?.modelOverride)) {
        preparedReplyMockState.unexpectedCalls.push("resolveStoredModelOverride");
      }
      return null;
    },
  ),
}));

vi.mock("./session-reset-prompt.js", () => ({
  resolveBareResetBootstrapFileAccess: vi.fn().mockReturnValue(false),
  resolveBareSessionResetPromptState: vi.fn().mockResolvedValue({
    bootstrapMode: "none",
    prompt: "A new session was started via /new or /reset.",
    shouldPrependStartupContext: true,
  }),
}));

vi.mock("./typing-mode.js", () => ({
  resolveTypingMode: vi.fn().mockReturnValue("off"),
}));

function createGatewayDrainingError(): Error {
  const error = new Error("Gateway is draining for restart; new tasks are not accepted");
  error.name = "GatewayDrainingError";
  return error;
}

const ROOM_EVENT_MESSAGE_TOOL_DIRECTIVE =
  "Treat this message as observed room activity, not a request. You were not explicitly tagged or mentioned in this room event. Default: stay silent. Only respond if you have something useful, substantial, or important to add. A previous mention or reply is not an invitation to keep talking. To respond visibly, use message(action=send); your final text here stays private either way.";

function createInboundBody<T extends string>(body: T) {
  return { Body: body, RawBody: body, CommandBody: body };
}

function createSessionBody<T extends string>(body: T) {
  return { Body: body, BodyStripped: body };
}

function createProviderSurface<T extends string>(provider: T) {
  return { Provider: provider, Surface: provider };
}

function createInboundTurn<
  TBody extends string,
  TProvider extends string,
  TChatType extends string,
>(body: TBody, provider: TProvider, chatType: TChatType) {
  return { ...createInboundBody(body), ...createProviderSurface(provider), ChatType: chatType };
}

function createSessionTurn<
  TBody extends string,
  TProvider extends string,
  TChatType extends string,
>(body: TBody, provider: TProvider, chatType: TChatType) {
  return { ...createSessionBody(body), ...createProviderSurface(provider), ChatType: chatType };
}

function baseParams(
  overrides: Partial<Parameters<typeof runPreparedReply>[0]> = {},
): Parameters<typeof runPreparedReply>[0] {
  const defaults = {
    ctx: {
      ...createInboundBody(""),
      ThreadHistoryBody: "Earlier message in this thread",
      OriginatingChannel: "slack",
      OriginatingTo: "C123",
      ChatType: "group",
    },
    sessionCtx: {
      ...createSessionBody(""),
      ThreadHistoryBody: "Earlier message in this thread",
      media: [{ path: "/tmp/input.png" }],
      Provider: "slack",
      ChatType: "group",
      OriginatingChannel: "slack",
      OriginatingTo: "C123",
    },
    cfg: { session: {}, channels: {}, agents: { defaults: {} } },
    agentId: "default",
    agentDir: "/tmp/agent",
    agentCfg: {},
    sessionCfg: {},
    commandAuthorized: true,
    command: {
      surface: "slack",
      channel: "slack",
      isAuthorizedSender: true,
      abortKey: "session-key",
      ownerList: [],
      senderIsOwner: false,
      rawBodyNormalized: "",
      commandBodyNormalized: "",
    } as never,
    commandSource: "",
    allowTextCommands: true,
    directives: {
      hasThinkDirective: false,
      thinkLevel: undefined,
    } as never,
    defaultActivation: "always",
    resolvedThinkLevel: "high",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    elevatedEnabled: false,
    elevatedAllowed: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    modelState: {
      resolveDefaultThinkingLevel: async () => "medium",
      resolveThinkingCatalog: async () => [],
    } as never,
    provider: "anthropic",
    model: "claude-opus-4-1",
    typing: {
      onReplyStart: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn(),
    } as never,
    defaultModel: "claude-opus-4-1",
    timeoutMs: 30_000,
    isNewSession: true,
    resetTriggered: false,
    systemSent: true,
    sessionKey: "session-key",
    workspaceDir: "/tmp/workspace",
    abortedLastRun: false,
  };
  const ctx = overrides.ctx ?? defaults.ctx;
  const sessionCtx = overrides.sessionCtx ?? defaults.sessionCtx;
  const resolveTestCanonicalText = (value: Record<string, unknown>) => {
    const { commandText, agentText, rawText } = finalizeInboundContextForSdk({ ...value });
    return { commandText, agentText, rawText };
  };
  const sessionText = resolveTestCanonicalText(sessionCtx);
  return {
    ...defaults,
    ...overrides,
    ctx: { ...ctx, ...resolveTestCanonicalText(ctx) },
    sessionCtx: {
      ...sessionCtx,
      ...sessionText,
      agentText:
        typeof sessionCtx.BodyStripped === "string"
          ? sessionCtx.BodyStripped
          : sessionText.agentText,
    },
  } as Parameters<typeof runPreparedReply>[0];
}

function runPrepared(overrides: Partial<Parameters<typeof runPreparedReply>[0]> = {}) {
  return runPreparedReply(baseParams(overrides));
}

function ownerParams(): Parameters<typeof runPreparedReply>[0] {
  const params = baseParams();
  params.command = {
    ...(params.command as Record<string, unknown>),
    senderIsOwner: true,
  } as never;
  return params;
}

type MockCallSource = {
  mock: {
    calls: ReadonlyArray<ReadonlyArray<unknown>>;
  };
};

function requireMockCallArg(mock: MockCallSource, label: string, index = 0): unknown {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`${label} call ${index} missing`);
  }
  return call[0];
}

function requireRunReplyAgentCall(index = 0) {
  const call = vi.mocked(runReplyAgent).mock.calls[index]?.[0];
  if (!call) {
    throw new Error(`runReplyAgent call ${index} missing`);
  }
  return call;
}

function requireLastRunReplyAgentCall() {
  const calls = vi.mocked(runReplyAgent).mock.calls;
  const call = calls[calls.length - 1]?.[0];
  if (!call) {
    throw new Error("last runReplyAgent call missing");
  }
  return call;
}

describe("runPreparedReply media-only handling", () => {
  beforeAll(async () => {
    // Preload the runtime seams directly so test setup does not need a synthetic
    // reply turn with registry and session side effects.
    await Promise.all([
      loadEmbeddedAgentRuntime(),
      loadAgentRunnerRuntime(),
      loadSessionUpdatesRuntime(),
    ]);
  });

  it("loads configured and canonical workspace skills for managed-worktree sessions", async () => {
    const params = baseParams({
      workspaceDir: "/tmp/agent-workspace",
      sessionEntry: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        spawnedCwd: "/tmp/session-worktree",
        worktree: {
          id: "worktree-1",
          branch: "openclaw/worktree-1",
          repoRoot: "/tmp/project",
          canonicalWorkspaceDir: "/tmp/project/packages/app",
        },
      },
    });
    const context = await prepareReplyRunContext(params);
    expect(context).toMatchObject({
      kind: "ready",
      workspaceDir: "/tmp/session-worktree",
      skillsWorkspaceDir: "/tmp/agent-workspace",
    });

    envMockState.fastTestRuntime = false;
    try {
      await runPreparedReply(params);
      const { ensureSkillSnapshot } = await loadSessionUpdatesRuntime();
      expect(ensureSkillSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceDir: "/tmp/agent-workspace",
          executionSkillsDir: "/tmp/project/packages/app/skills",
        }),
      );
    } finally {
      envMockState.fastTestRuntime = true;
    }
    expect(requireRunReplyAgentCall().followupRun.run.workspaceDir).toBe("/tmp/session-worktree");
  });

  it.each([
    {
      name: "unset",
      defaultCwd: undefined,
      agentCwd: undefined,
      spawnedCwd: undefined,
      expected: undefined,
    },
    {
      name: "defaults",
      defaultCwd: "/tmp/default-repo",
      agentCwd: undefined,
      spawnedCwd: undefined,
      expected: "/tmp/default-repo",
    },
    {
      name: "agent override",
      defaultCwd: "/tmp/default-repo",
      agentCwd: "/tmp/agent-repo",
      spawnedCwd: undefined,
      expected: "/tmp/agent-repo",
    },
    {
      name: "spawned override",
      defaultCwd: "/tmp/default-repo",
      agentCwd: "/tmp/agent-repo",
      spawnedCwd: "/tmp/session-repo",
      expected: "/tmp/session-repo",
    },
  ])(
    "keeps workspace separate from $name run cwd",
    async ({ defaultCwd, agentCwd, spawnedCwd, expected }) => {
      await runPreparedReply(
        baseParams({
          cfg: {
            agents: { defaults: { cwd: defaultCwd }, entries: { default: { cwd: agentCwd } } },
          },
          workspaceDir: "/tmp/agent-workspace",
          sessionEntry: {
            sessionId: "session-1",
            updatedAt: Date.now(),
            spawnedCwd,
            spawnedBy: spawnedCwd ? "agent:default:main" : undefined,
          },
        }),
      );
      expect(requireRunReplyAgentCall().followupRun.run).toMatchObject({
        cwd: expected,
        workspaceDir: "/tmp/agent-workspace",
      });
    },
  );

  beforeEach(async () => {
    preparedReplyMockState.unexpectedCalls.length = 0;
    loadSessionEntryMock.mockReset();
    updateAmbientTranscriptWatermarkMock.mockClear();
    vi.clearAllMocks();
    vi.mocked(buildDirectChatContext).mockReturnValue("");
    vi.mocked(buildGroupIntro).mockReturnValue("");
    vi.mocked(buildGroupChatContext).mockReturnValue("");
    vi.mocked(buildInboundUserContextPrefix).mockReset().mockReturnValue("");
    vi.mocked(resolveInboundUserContextPromptJoiner).mockReturnValue(undefined);
    vi.mocked(hasControlCommand).mockReturnValue(false);
    resolveCurrentTurnImagesMock.mockReset().mockResolvedValue({});
    replyRunTesting.resetReplyRunRegistry();
  });

  afterEach(async () => {
    vi.useRealTimers();
    resetSystemEventsForTest();
    expect(preparedReplyMockState.unexpectedCalls).toEqual([]);
  });

  it("passes approved elevated defaults to the runner", async () => {
    await runPrepared({
      resolvedElevatedLevel: "on",
      elevatedEnabled: true,
      elevatedAllowed: true,
    });

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.run.bashElevated).toEqual({
      enabled: true,
      allowed: true,
      defaultLevel: "on",
      fullAccessAvailable: true,
    });
  });

  it.each([
    {
      label: "agent raw overrides default explain",
      defaults: "explain",
      entry: "raw",
      expected: "raw",
    },
    {
      label: "agent explain overrides default raw",
      defaults: "raw",
      entry: "explain",
      expected: "explain",
    },
    { label: "agent without a default", defaults: undefined, entry: "raw", expected: "raw" },
    { label: "default without an override", defaults: "raw", entry: undefined, expected: "raw" },
    { label: "unset detail", defaults: undefined, entry: undefined, expected: undefined },
  ] as const)(
    "passes $label tool progress detail into reply execution",
    async ({ defaults, entry, expected }) => {
      const agentCfg = { toolProgressDetail: defaults };
      await runPrepared({
        agentId: "worker",
        agentCfg,
        cfg: { agents: { defaults: agentCfg, entries: { worker: { toolProgressDetail: entry } } } },
      });

      expect(requireRunReplyAgentCall().toolProgressDetail).toBe(expected);
    },
  );

  it("includes current exec overrides in the queued runner prompt", async () => {
    await runPrepared({
      execOverrides: {
        host: "gateway",
        security: "full",
        ask: "always",
        node: "worker-1",
      },
      resolvedElevatedLevel: "off",
    });

    const prompt = requireRunReplyAgentCall().followupRun.run.extraSystemPromptStatic;
    expect(prompt).toContain(
      "Current session exec defaults: host=gateway security=full ask=always node=worker-1.",
    );
    expect(prompt).toContain("Current elevated level: off.");
    expect(prompt).toContain("Do not assume a prior denial still applies");
  });

  it("preserves parent session provenance in queued runs", async () => {
    const spawnedBy = "agent:main:telegram:group:parent";

    await runPrepared({
      sessionEntry: {
        sessionId: "child-session",
        updatedAt: Date.now(),
        spawnedBy,
      } as SessionEntry,
    });

    expect(requireRunReplyAgentCall().followupRun.run.spawnedBy).toBe(spawnedBy);
  });

  it("propagates non-visible assistant silence for group runs", async () => {
    await runPrepared();

    let call = requireLastRunReplyAgentCall();
    expect(call?.followupRun.run.allowEmptyAssistantReplyAsSilent).toBe(true);
    expect(call?.followupRun.run.terminalReplyExpectation).toBe("required");

    await runPrepared({
      defaultActivation: "mention",
    });

    call = requireLastRunReplyAgentCall();
    expect(call?.followupRun.run.allowEmptyAssistantReplyAsSilent).toBe(true);
    expect(call?.followupRun.run.terminalReplyExpectation).toBe("required");
  });

  it.each([
    {
      name: "mention",
      ctx: { WasMentioned: true },
    },
    {
      name: "native command",
      ctx: {
        CommandTurn: {
          kind: "native" as const,
          source: "native" as const,
          authorized: true,
          commandName: "status",
          body: "/status",
        },
      },
    },
  ])("keeps empty-assistant silence disabled for a directed group $name", async ({ ctx }) => {
    await runPrepared({
      ctx: {
        ...baseParams().ctx,
        ...ctx,
      },
    });

    const call = requireLastRunReplyAgentCall();
    expect(call?.followupRun.run.allowEmptyAssistantReplyAsSilent).toBe(false);
    expect(call?.followupRun.run.terminalReplyExpectation).toBe("required");
  });

  it("keeps empty-assistant silence optional for ambient room events", async () => {
    const defaults = baseParams();
    await runPrepared({
      ctx: {
        ...defaults.ctx,
        InboundEventKind: "room_event",
        WasMentioned: true,
      },
      sessionCtx: {
        ...defaults.sessionCtx,
        InboundEventKind: "room_event",
        WasMentioned: true,
      },
      cfg: {
        agents: {
          defaults: {
            silentReply: { group: "disallow" },
          },
        },
      },
    });

    const call = requireLastRunReplyAgentCall();
    expect(call.followupRun.run).toMatchObject({
      allowEmptyAssistantReplyAsSilent: true,
      terminalReplyExpectation: "optional",
    });
  });

  it("hydrates runtime thinking metadata before trusting static provider support", async () => {
    const resolveThinkingCatalog = vi.fn(async () => [
      {
        provider: "openai",
        id: "chat-latest",
        reasoning: false,
      },
    ]);

    await runPrepared({
      provider: "openai",
      model: "chat-latest",
      resolvedThinkLevel: "high",
      modelState: {
        resolveDefaultThinkingLevel: async () => "high",
        resolveThinkingCatalog,
        allowedModelCatalog: [
          {
            provider: "openai",
            id: "chat-latest",
            name: "Chat Latest",
          },
        ],
      } as never,
    });

    expect(resolveThinkingCatalog).toHaveBeenCalledOnce();
    const call = requireRunReplyAgentCall();
    expect(call.followupRun.run.thinkLevel).toBe("off");
    expect(call.followupRun.run.thinkingCatalog).toEqual([
      {
        provider: "openai",
        id: "chat-latest",
        reasoning: false,
      },
    ]);
  });

  it("reports unsupported explicit one-turn thinking overrides", async () => {
    const result = await runPrepared({
      provider: "openai",
      model: "chat-latest",
      resolvedThinkLevel: "xhigh",
      opts: { thinkingLevelOverride: "xhigh" },
      modelState: {
        resolveDefaultThinkingLevel: async () => "high",
        resolveThinkingCatalog: async () => [
          {
            provider: "openai",
            id: "chat-latest",
            reasoning: false,
          },
        ],
        allowedModelCatalog: [
          {
            provider: "openai",
            id: "chat-latest",
            name: "Chat Latest",
          },
        ],
      } as never,
    });

    expect(Array.isArray(result) ? undefined : result?.text).toContain(
      'Thinking level "xhigh" is not supported',
    );
    expect(runReplyAgent).not.toHaveBeenCalled();
  });

  it("does not persist turn-local thinking fallback over a stored session override", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session-thinking",
      sessionFile: "/tmp/session-thinking.jsonl",
      thinkingLevel: "high",
      updatedAt: 1,
    };
    const sessionStore: Record<string, SessionEntry> = {
      "session-key": sessionEntry,
    };

    await runPrepared({
      provider: "openai",
      model: "chat-latest",
      resolvedThinkLevel: "high",
      sessionEntry,
      sessionStore,
      storePath: "/tmp/openclaw-sessions.json",
      modelState: {
        resolveDefaultThinkingLevel: async () => "high",
        resolveThinkingCatalog: async () => [
          {
            provider: "openai",
            id: "chat-latest",
            reasoning: false,
          },
        ],
        allowedModelCatalog: [
          {
            provider: "openai",
            id: "chat-latest",
            name: "Chat Latest",
          },
        ],
      } as never,
    });

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.run.thinkLevel).toBe("off");
    expect(sessionEntry.thinkingLevel).toBe("high");
    expect(sessionStore["session-key"]?.thinkingLevel).toBe("high");
  });

  it("keeps empty-assistant silence disabled for direct runs by default", async () => {
    await runPrepared({
      ctx: {
        ...createInboundBody(""),
        ThreadHistoryBody: "Earlier direct message",
        OriginatingChannel: "slack",
        OriginatingTo: "D123",
        ChatType: "direct",
      },
      sessionCtx: {
        ...createSessionBody(""),
        ThreadHistoryBody: "Earlier direct message",
        media: [{ path: "/tmp/input.png" }],
        Provider: "slack",
        ChatType: "direct",
        OriginatingChannel: "slack",
        OriginatingTo: "D123",
      },
    });

    const call = requireLastRunReplyAgentCall();
    expect(call?.followupRun.run.allowEmptyAssistantReplyAsSilent).toBe(false);
  });

  it("passes message-tool-only delivery into direct chat prompt context", async () => {
    await runPrepared({
      opts: { sourceReplyDeliveryMode: "message_tool_only" },
      ctx: {
        ...createInboundBody("yo"),
        ThreadHistoryBody: "Earlier direct message",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram-direct-test-id",
        ChatType: "direct",
      },
      sessionCtx: {
        ...createSessionBody("yo"),
        ThreadHistoryBody: "Earlier direct message",
        media: [{ path: "/tmp/input.png" }],
        Provider: "telegram",
        ChatType: "direct",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram-direct-test-id",
      },
    });

    expect(buildDirectChatContext).toHaveBeenCalledTimes(2);
    const directContextParams = requireMockCallArg(
      vi.mocked(buildDirectChatContext),
      "direct chat context",
      1,
    ) as {
      sessionCtx?: { Provider?: string; ChatType?: string };
      sourceReplyDeliveryMode?: string;
    };
    expect(directContextParams?.sessionCtx?.Provider).toBe("telegram");
    expect(directContextParams?.sessionCtx?.ChatType).toBe("direct");
    expect(directContextParams?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(buildInboundUserContextPrefix).toHaveBeenCalledWith(
      {
        ...createSessionBody("yo"),
        ThreadHistoryBody: "Earlier direct message",
        media: [{ path: "/tmp/input.png" }],
        Provider: "telegram",
        ChatType: "direct",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram-direct-test-id",
        InboundHistory: undefined,
        ThreadStarterBody: undefined,
        commandText: "yo",
        agentText: "yo",
        rawText: "yo",
      },
      expect.anything(),
      undefined,
    );
  });

  it("projects prepared embedded prompt variants without changing CLI session guidance", async () => {
    vi.mocked(buildDirectChatContext).mockImplementation(
      ({ sourceReplyDeliveryMode }) => `direct:${sourceReplyDeliveryMode ?? "automatic"}`,
    );
    await runPrepared({
      opts: {
        sourceReplyDeliveryMode: "message_tool_only",
        sourceReplyDeliveryModeOrigin: "runtime_default",
      } as NonNullable<Parameters<typeof runPreparedReply>[0]["opts"]> &
        SourceReplyDeliveryRuntimeOptions,
      ctx: { ...createInboundTurn("hello", "discord", "direct") },
      sessionCtx: { ...createSessionTurn("hello", "discord", "direct") },
    });

    const call = requireLastRunReplyAgentCall();
    const followupRun = call.followupRun;
    const run = followupRun.run;
    const sourceReplyDeliveryRuntime = readSourceReplyDeliveryRuntime(run);
    expect(run.extraSystemPrompt).toBe("direct:message_tool_only");
    expect(run.extraSystemPromptStatic).toBe("direct:message_tool_only");
    run.extraSystemPrompt += "\n\npost-compaction refresh";
    sourceReplyDeliveryRuntime?.applyMode(run, "automatic");
    expect(run.extraSystemPrompt).toBe("direct:message_tool_only\n\npost-compaction refresh");
    sourceReplyDeliveryRuntime?.applyPreparedMode(run, "automatic");
    expect(run.extraSystemPrompt).toBe("direct:automatic\n\npost-compaction refresh");
    expect(run.extraSystemPromptStatic).toBe("direct:message_tool_only");
    sourceReplyDeliveryRuntime?.applyPreparedMode(run, "message_tool_only");
    expect(run.extraSystemPrompt).toBe("direct:message_tool_only\n\npost-compaction refresh");
    expect(run.cliSessionBindingFacts).toEqual({
      extraSystemPromptStatic: "direct:message_tool_only",
      sourceReplyDeliveryMode: "message_tool_only",
    });
  });

  it("replaces only the bound delivery prompt component", () => {
    const repeatedPrefix = "same guidance\n\nindependent context\n\n";
    const run = { extraSystemPrompt: `${repeatedPrefix}same guidance\n\nlater context` };
    const runtime = createSourceReplyDeliveryRuntime({
      origin: "runtime_default",
      initialMode: "message_tool_only",
      projections: [run],
      promptComponentByMode: {
        automatic: "automatic guidance",
        message_tool_only: "same guidance",
      },
      promptComponentOffset: repeatedPrefix.length,
    });

    runtime.applyPreparedMode(run, "automatic");
    expect(run.extraSystemPrompt).toBe(`${repeatedPrefix}automatic guidance\n\nlater context`);

    const absent = { extraSystemPrompt: "independent context only" };
    createSourceReplyDeliveryRuntime({
      origin: "runtime_default",
      initialMode: "message_tool_only",
      projections: [absent],
      promptComponentByMode: {
        automatic: "automatic guidance",
        message_tool_only: "missing guidance",
      },
      promptComponentOffset: undefined,
    }).applyPreparedMode(absent, "automatic");
    expect(absent.extraSystemPrompt).toBe("independent context only");

    const empty = { extraSystemPrompt: "independent context only" };
    createSourceReplyDeliveryRuntime({
      origin: "runtime_default",
      initialMode: "message_tool_only",
      projections: [empty],
      promptComponentByMode: { automatic: "", message_tool_only: "" },
      promptComponentOffset: undefined,
    }).applyPreparedMode(empty, "automatic");
    expect(empty.extraSystemPrompt).toBe("independent context only");
  });

  it("keeps addressed message-tool delivery hints out of persisted transcript rows", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      "Current message:\nchat_id=-100123\ninbound_event_kind: user_request",
    );

    await runPrepared({
      opts: { sourceReplyDeliveryMode: "message_tool_only" },
      ctx: {
        Body: "@bot please answer here",
        RawBody: "@bot please answer here",
        CommandBody: "please answer here",
        OriginatingChannel: "telegram",
        OriginatingTo: "-100123",
        ChatType: "group",
      },
      sessionCtx: {
        Body: "@bot please answer here",
        BodyStripped: "please answer here",
        Provider: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "-100123",
        ChatType: "group",
        InboundEventKind: "user_request",
      },
    });

    const call = requireLastRunReplyAgentCall();
    expect(call.commandBody).toBe("please answer here");
    expect(call.transcriptCommandBody).toBe("please answer here");
    expect(call.followupRun.prompt).toBe("please answer here");
    expect(call.followupRun.transcriptPrompt).toBe("please answer here");
    expect(call.followupRun.currentInboundContext?.text).toBe(
      [
        "Current message:\nchat_id=-100123\ninbound_event_kind: user_request",
        MESSAGE_TOOL_ONLY_DELIVERY_HINT,
      ].join("\n\n"),
    );
    const persistedUserMessage = call.followupRun.userTurnTranscriptRecorder?.message;
    if (!persistedUserMessage) {
      throw new Error("persisted user turn message missing");
    }
    expect(persistedUserMessage).toMatchObject({
      role: "user",
      content: "please answer here",
    });
    expect(persistedUserMessage.content).not.toContain(MESSAGE_TOOL_ONLY_DELIVERY_HINT);
  });

  it.each(["direct", "dm"] as const)(
    "does not propagate empty-assistant silence for %s runs",
    async (chatType) => {
      await runPrepared({
        ctx: {
          ...createInboundBody(""),
          ThreadHistoryBody: "Earlier direct message",
          OriginatingChannel: "slack",
          OriginatingTo: "D123",
          ChatType: chatType,
        },
        sessionCtx: {
          ...createSessionBody(""),
          ThreadHistoryBody: "Earlier direct message",
          media: [{ path: "/tmp/input.png" }],
          Provider: "slack",
          ChatType: chatType,
          OriginatingChannel: "slack",
          OriginatingTo: "D123",
        },
        cfg: {
          session: {},
          channels: {},
          agents: {},
        },
      });

      const call = requireLastRunReplyAgentCall();
      expect(call?.followupRun.run.allowEmptyAssistantReplyAsSilent).toBe(false);
    },
  );

  it("does not borrow target-session silence for native commands sent from direct chats", async () => {
    await runPrepared({
      agentId: "main",
      sessionKey: "agent:main:telegram:group:target",
      ctx: {
        ...createInboundBody(""),
        ThreadHistoryBody: "Earlier direct message",
        OriginatingChannel: "telegram",
        OriginatingTo: "D123",
        ChatType: "direct",
        CommandSource: "native",
        SessionKey: "agent:main:telegram:direct:source",
        CommandTargetSessionKey: "agent:main:telegram:group:target",
      },
      sessionCtx: {
        ...createSessionBody(""),
        ThreadHistoryBody: "Earlier direct message",
        media: [{ path: "/tmp/input.png" }],
        Provider: "telegram",
        ChatType: "direct",
        OriginatingChannel: "telegram",
        OriginatingTo: "D123",
        CommandSource: "native",
        SessionKey: "agent:main:telegram:direct:source",
        CommandTargetSessionKey: "agent:main:telegram:group:target",
      },
    });

    const call = requireLastRunReplyAgentCall();
    expect(call?.followupRun.run.allowEmptyAssistantReplyAsSilent).toBe(false);
  });

  it("allows media-only prompts and preserves thread context in queued followups", async () => {
    const result = await runPrepared();
    expect(result).toEqual({ text: "ok" });

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.prompt).toContain("[Thread history - for context]");
    expect(call.followupRun.prompt).toContain("Earlier message in this thread");
    expect(call.followupRun.prompt).toContain("[User sent media without caption]");
  });

  it("carries source delivery provenance into the queue-owned run", async () => {
    await runPrepared({
      opts: {
        sourceReplyDeliveryMode: "message_tool_only",
        sourceReplyDeliveryModeOrigin: "runtime_default",
      } as NonNullable<Parameters<typeof runPreparedReply>[0]["opts"]> &
        SourceReplyDeliveryRuntimeOptions,
    });

    const call = requireRunReplyAgentCall();
    const followupRun = call.followupRun;
    const run = followupRun.run;
    expect(run.sourceReplyDeliveryMode).toBe("message_tool_only");
    const sourceReplyDeliveryRuntime = readSourceReplyDeliveryRuntime(run);
    expect(sourceReplyDeliveryRuntime?.origin).toBe("runtime_default");
    expect(sourceReplyDeliveryRuntime?.currentMode).toBe("message_tool_only");
  });

  it("persists pure media turns without the model-facing placeholder", async () => {
    const params = baseParams();
    params.ctx.ThreadHistoryBody = undefined;
    params.ctx.media = [{ path: "/tmp/input.png" }];
    params.sessionCtx.ThreadHistoryBody = undefined;

    await runPreparedReply(params);

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.prompt).toContain("[User sent media without caption]");
    expect(call.followupRun.userTurnTranscriptRecorder?.message).toMatchObject({
      role: "user",
      content: "",
      __openclaw: { media: [expect.objectContaining({ path: "/tmp/input.png" })] },
    });
  });

  it.each([
    "discord",
    "telegram",
    "slack",
    "whatsapp",
    "signal",
    "imessage",
    "matrix",
    "msteams",
    "webchat",
  ] as const)("enables default same-turn steering for active %s runs", async (channel) => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({
      mode: "steer",
      debounceMs: 500,
      cap: 20,
      dropPolicy: "summarize",
    });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
      .mockReturnValueOnce("active-session")
      .mockReturnValueOnce("active-session");
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValueOnce(true);
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunStreaming).mockReturnValueOnce(true);

    const params = baseParams({
      agentId: "main",
      sessionKey: `agent:main:${channel}:direct:steer-smoke`,
    });
    params.ctx = {
      ...params.ctx,
      Provider: channel,
      OriginatingChannel: channel,
      OriginatingTo: `${channel}-target`,
      ChatType: "direct",
    } as never;
    params.sessionCtx = {
      ...params.sessionCtx,
      Provider: channel,
      OriginatingChannel: channel,
      OriginatingTo: `${channel}-target`,
      ChatType: "direct",
    } as never;
    params.command = {
      ...(params.command as Record<string, unknown>),
      surface: channel,
      channel,
    } as never;

    await runPreparedReply(params);

    expect(queueSettings.resolveQueueSettings).toHaveBeenCalledWith(
      expect.objectContaining({ channel }),
    );
    const call = vi.mocked(runReplyAgent).mock.calls.at(-1)?.[0];
    expect(call).toMatchObject({
      shouldSteer: true,
      shouldFollowup: true,
      isActive: true,
      resolvedQueue: expect.objectContaining({ mode: "steer" }),
    });
    expect(call?.followupRun.run.messageProvider).toBe(channel);
    expect(call?.followupRun.originatingChannel).toBe(channel);
  });

  it("prefers a one-turn queue override over the stored session mode", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    vi.mocked(queueSettings.resolveQueueSettings).mockImplementationOnce((params) => ({
      mode: params.inlineMode ?? params.sessionEntry?.queueMode ?? "steer",
    }));
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
      .mockReturnValueOnce("active-session")
      .mockReturnValueOnce("active-session");
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValueOnce(true);
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunStreaming).mockReturnValueOnce(true);

    await runPrepared({
      sessionEntry: {
        sessionId: "active-session",
        updatedAt: Date.now(),
        queueMode: "followup",
      },
      opts: { queueModeOverride: "steer" },
    });

    expect(queueSettings.resolveQueueSettings).toHaveBeenCalledWith(
      expect.objectContaining({ inlineMode: "steer" }),
    );
    expect(requireLastRunReplyAgentCall()).toMatchObject({
      shouldSteer: true,
      resolvedQueue: { mode: "steer" },
    });
  });

  it("keeps thread history context on follow-up turns", async () => {
    const result = await runPrepared({
      isNewSession: false,
    });
    expect(result).toEqual({ text: "ok" });

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.prompt).toContain("[Thread history - for context]");
    expect(call.followupRun.prompt).toContain("Earlier message in this thread");
  });

  it("falls back to thread starter context on follow-up turns when history is absent", async () => {
    const result = await runPrepared({
      isNewSession: false,
      ctx: {
        ...createInboundBody(""),
        ThreadStarterBody: "starter message",
        ThreadHistoryBody: undefined,
        OriginatingChannel: "slack",
        OriginatingTo: "C123",
        ChatType: "group",
      },
      sessionCtx: {
        ...createSessionBody(""),
        ThreadStarterBody: "starter message",
        ThreadHistoryBody: undefined,
        media: [{ path: "/tmp/input.png" }],
        Provider: "slack",
        ChatType: "group",
        OriginatingChannel: "slack",
        OriginatingTo: "C123",
      },
    });
    expect(result).toEqual({ text: "ok" });

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.prompt).toContain("[Thread starter - for context]");
    expect(call.followupRun.prompt).toContain("starter message");
  });

  it("prefers thread history over thread starter on follow-up turns", async () => {
    const result = await runPrepared({
      isNewSession: false,
      ctx: {
        ...createInboundBody(""),
        ThreadStarterBody: "starter message",
        ThreadHistoryBody: "Earlier message in this thread",
        OriginatingChannel: "slack",
        OriginatingTo: "C123",
        ChatType: "group",
      },
      sessionCtx: {
        ...createSessionBody(""),
        ThreadStarterBody: "starter message",
        ThreadHistoryBody: "Earlier message in this thread",
        media: [{ path: "/tmp/input.png" }],
        Provider: "slack",
        ChatType: "group",
        OriginatingChannel: "slack",
        OriginatingTo: "C123",
      },
    });
    expect(result).toEqual({ text: "ok" });

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.prompt).toContain("[Thread history - for context]");
    expect(call.followupRun.prompt).not.toContain("[Thread starter - for context]");
  });

  it("does not duplicate thread starter text with a plain-text prelude", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      ["Thread starter:", "```json", '{"body":"starter message"}', "```"].join("\n"),
    );

    const result = await runPrepared({
      ctx: {
        ...createInboundBody(""),
        ThreadStarterBody: "starter message",
        OriginatingChannel: "slack",
        OriginatingTo: "C123",
        ChatType: "group",
      },
      sessionCtx: {
        ...createSessionBody(""),
        ThreadStarterBody: "starter message",
        media: [{ path: "/tmp/input.png" }],
        Provider: "slack",
        ChatType: "group",
        OriginatingChannel: "slack",
        OriginatingTo: "C123",
      },
    });
    expect(result).toEqual({ text: "ok" });

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.currentInboundContext?.text).toContain("Thread starter:");
    expect(call.followupRun.prompt).not.toContain("[Thread starter - for context]");
  });

  it("returns the empty-body reply when there is no text and no media", async () => {
    const result = await runPrepared({
      ctx: {
        ...createInboundBody(""),
      },
      sessionCtx: {
        ...createSessionBody(""),
        Provider: "slack",
      },
    });

    expect(result).toEqual({
      text: "I didn't receive any text in your message. Please resend or add a caption.",
    });
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
  });

  it.each(["/model openai/gpt-5.5", "/reset examples"])(
    "keeps disabled text slash syntax in the model prompt: %s",
    async (body) => {
      vi.mocked(hasControlCommand).mockReturnValue(true);
      const onDeliberateSilentTerminalReply = vi.fn();
      const result = await runPreparedReply(
        baseParams({
          ctx: {
            ...createInboundTurn(body, "discord", "direct"),
            CommandSource: "text",
            CommandAuthorized: false,
            CommandTurn: {
              kind: "text-slash",
              source: "text",
              authorized: false,
              commandName: body.startsWith("/model") ? "model" : "reset",
              body,
            },
          },
          sessionCtx: {
            ...createSessionTurn(body, "discord", "direct"),
          },
          commandAuthorized: false,
          command: {
            surface: "discord",
            channel: "discord",
            isAuthorizedSender: false,
            abortKey: "session-key",
            ownerList: [],
            senderIsOwner: false,
            rawBodyNormalized: body,
            commandBodyNormalized: body,
          } as never,
          allowTextCommands: false,
          isNewSession: false,
          opts: { onDeliberateSilentTerminalReply },
        }),
      );

      expect(result).toEqual({ text: "ok" });
      expect(requireRunReplyAgentCall().followupRun.prompt).toBe(body);
      expect(onDeliberateSilentTerminalReply).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "ordinary code", directive: "", authorized: true, enabled: true },
    { name: "authorized directive", directive: "/think high\r\n", authorized: true, enabled: true },
    {
      name: "unauthorized directive",
      directive: "/think high\r\n",
      authorized: false,
      enabled: true,
    },
    {
      name: "disabled text commands",
      directive: "/think high\r\n",
      authorized: true,
      enabled: false,
    },
  ])(
    "preserves prompt bytes through routing and preparation: $name",
    async ({ directive, authorized, enabled }) => {
      const code =
        "Run  this:\r\n```python\r\n    if True:\r\n        print('a  b')\r\n\t\t# tabs  stay\r\n```";
      const body = `${directive}${code}`;
      const params = baseParams({
        ctx: createInboundTurn(body, "slack", "direct"),
        sessionCtx: createSessionTurn(body, "slack", "direct"),
        isNewSession: false,
        commandAuthorized: authorized,
        allowTextCommands: enabled,
      });
      params.command = { ...params.command, isAuthorizedSender: authorized };
      const routed = resolveReplyDirectiveRouting({
        commandText: body,
        agentText: body,
        modelAliases: [],
        canInterpretTextDirectives: authorized && enabled,
        isAuthorizedSender: authorized,
        isGroup: false,
        wasMentioned: false,
        ctx: finalizeInboundContext(params.ctx),
        cfg: params.cfg,
        agentId: params.agentId,
        resetTriggered: false,
      });
      params.directives = routed.directives;
      params.sessionCtx.agentText = routed.cleanedBody;
      await runPreparedReply(params);

      const expected = authorized && enabled ? code : body;
      const call = requireRunReplyAgentCall();
      expect(call.commandBody).toBe(expected);
      expect(call.followupRun.prompt).toBe(expected);
    },
  );

  it.each([
    "/model openai/gpt-5.5",
    "/think high",
    "Keep  /thinking:high as text",
    "/new",
    "/reset",
  ])(
    "keeps explicitly suppressed command-shaped Gateway text in the model prompt: %s",
    async (body) => {
      const onDeliberateSilentTerminalReply = vi.fn();
      vi.mocked(hasControlCommand).mockReturnValue(true);

      const result = await runPreparedReply(
        baseParams({
          ctx: {
            ...createInboundTurn(body, "webchat", "direct"),
            CommandAuthorized: false,
            CommandInterpretationSuppressed: true,
            CommandTurn: {
              kind: "normal",
              source: "message",
              authorized: false,
              body,
            },
          },
          sessionCtx: {
            ...createSessionTurn(body, "webchat", "direct"),
          },
          commandAuthorized: false,
          command: {
            surface: "webchat",
            channel: "webchat",
            isAuthorizedSender: false,
            abortKey: "session-key",
            ownerList: [],
            senderIsOwner: false,
            rawBodyNormalized: body,
            commandBodyNormalized: body,
          } as never,
          isNewSession: body === "/new" || body === "/reset",
          opts: { onDeliberateSilentTerminalReply },
        }),
      );

      expect(result).toEqual({ text: "ok" });
      expect(requireRunReplyAgentCall().followupRun.prompt).toBe(body);
      expect(onDeliberateSilentTerminalReply).not.toHaveBeenCalled();
    },
  );

  it("silently drops an explicit unauthorized whole-message text slash command", async () => {
    const body = "/model openai/gpt-5.5";
    const onDeliberateSilentTerminalReply = vi.fn();
    vi.mocked(hasControlCommand).mockReturnValue(true);
    const params = baseParams({
      ctx: {
        ...createInboundTurn(body, "discord", "direct"),
        CommandSource: "text",
        CommandAuthorized: false,
        CommandTurn: {
          kind: "text-slash",
          source: "text",
          authorized: false,
          commandName: "model",
          body,
        },
      },
      sessionCtx: {
        ...createSessionTurn(body, "discord", "direct"),
      },
      commandAuthorized: false,
      command: {
        surface: "discord",
        channel: "discord",
        isAuthorizedSender: false,
        abortKey: "session-key",
        ownerList: [],
        senderIsOwner: false,
        rawBodyNormalized: body,
        commandBodyNormalized: body,
      } as never,
      isNewSession: false,
      opts: { onDeliberateSilentTerminalReply },
    });

    await expect(runPreparedReply(params)).resolves.toBeUndefined();
    expect(runReplyAgent).not.toHaveBeenCalled();
    expect(onDeliberateSilentTerminalReply).toHaveBeenCalledOnce();
    expect(params.typing.cleanup).toHaveBeenCalledOnce();
  });

  it("silently drops a legacy unauthorized registered command without turn provenance", async () => {
    const body = "/model openai/gpt-5.5";
    const onDeliberateSilentTerminalReply = vi.fn();
    vi.mocked(hasControlCommand).mockReturnValue(true);
    const params = baseParams({
      ctx: {
        ...createInboundTurn(body, "slack", "direct"),
        CommandAuthorized: false,
      },
      sessionCtx: {
        ...createSessionTurn(body, "slack", "direct"),
      },
      commandAuthorized: false,
      command: {
        surface: "slack",
        channel: "slack",
        isAuthorizedSender: false,
        abortKey: "session-key",
        ownerList: [],
        senderIsOwner: false,
        rawBodyNormalized: body,
        commandBodyNormalized: body,
      } as never,
      isNewSession: false,
      opts: { onDeliberateSilentTerminalReply },
    });

    await expect(runPreparedReply(params)).resolves.toBeUndefined();
    expect(runReplyAgent).not.toHaveBeenCalled();
    expect(onDeliberateSilentTerminalReply).toHaveBeenCalledOnce();
    expect(params.typing.cleanup).toHaveBeenCalledOnce();
  });

  it("silently drops an unauthorized native command even when text commands are disabled", async () => {
    const body = "/model openai/gpt-5.5";
    const onDeliberateSilentTerminalReply = vi.fn();
    vi.mocked(hasControlCommand).mockReturnValue(true);
    const params = baseParams({
      ctx: {
        ...createInboundTurn(body, "discord", "direct"),
        CommandSource: "native",
        CommandAuthorized: false,
        CommandTurn: {
          kind: "native",
          source: "native",
          authorized: false,
          commandName: "model",
          body,
        },
      },
      sessionCtx: {
        ...createSessionTurn(body, "discord", "direct"),
      },
      commandAuthorized: false,
      command: {
        surface: "discord",
        channel: "discord",
        isAuthorizedSender: false,
        abortKey: "session-key",
        ownerList: [],
        senderIsOwner: false,
        rawBodyNormalized: body,
        commandBodyNormalized: body,
      } as never,
      allowTextCommands: false,
      isNewSession: false,
      opts: { onDeliberateSilentTerminalReply },
    });

    await expect(runPreparedReply(params)).resolves.toBeUndefined();
    expect(runReplyAgent).not.toHaveBeenCalled();
    expect(onDeliberateSilentTerminalReply).toHaveBeenCalledOnce();
    expect(params.typing.cleanup).toHaveBeenCalledOnce();
  });

  it("still skips metadata-only turns when inbound context adds chat_id", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      [
        "Conversation info:",
        "```json",
        JSON.stringify({ chat_id: "paperclip:issue:abc" }, null, 2),
        "```",
      ].join("\n"),
    );

    const result = await runPrepared({
      ctx: {
        ...createInboundBody(""),
      },
      sessionCtx: {
        ...createSessionBody(""),
        Provider: "paperclip",
        OriginatingChannel: "paperclip",
        OriginatingTo: "paperclip:issue:abc",
        ChatType: "direct",
      },
    });

    expect(result).toEqual({
      text: "I didn't receive any text in your message. Please resend or add a caption.",
    });
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
  });

  it("allows pending inbound history to trigger a bare mention turn", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      [
        "Chat history since last reply:",
        "```json",
        JSON.stringify(
          [{ sender: "Alice", timestamp_ms: 1_700_000_000_000, body: "what changed?" }],
          null,
          2,
        ),
        "```",
      ].join("\n"),
    );

    const result = await runPrepared({
      ctx: {
        ...createInboundBody(""),
        ChatType: "group",
        WasMentioned: true,
      },
      sessionCtx: {
        ...createSessionBody(""),
        Provider: "feishu",
        OriginatingChannel: "feishu",
        OriginatingTo: "chat-1",
        ChatType: "group",
        WasMentioned: true,
        InboundHistory: [{ sender: "Alice", timestamp: 1_700_000_000_000, body: "what changed?" }],
      },
    });

    expect(result).toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
    const call = requireRunReplyAgentCall();
    expect(call?.followupRun.prompt).toBe("");
    expect(call?.followupRun.currentInboundContext?.text).toContain(
      "Chat history since last reply",
    );
    expect(call?.followupRun.currentInboundContext?.text).toContain("what changed?");
    expect(call?.followupRun.prompt).not.toContain("[User sent media without caption]");
  });

  it("does not treat blank pending inbound history as user input", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      [
        "Chat history since last reply:",
        "```json",
        JSON.stringify([{ sender: "Alice", timestamp_ms: 1_700_000_000_000, body: "" }], null, 2),
        "```",
      ].join("\n"),
    );

    const result = await runPrepared({
      ctx: {
        ...createInboundBody(""),
        ChatType: "group",
        WasMentioned: true,
      },
      sessionCtx: {
        ...createSessionBody(""),
        Provider: "feishu",
        OriginatingChannel: "feishu",
        OriginatingTo: "chat-1",
        ChatType: "group",
        WasMentioned: true,
        InboundHistory: [{ sender: "Alice", timestamp: 1_700_000_000_000, body: "\u0000  " }],
      },
    });

    expect(result).toEqual({
      text: "I didn't receive any text in your message. Please resend or add a caption.",
    });
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
  });

  it("allows webchat pure-image turns when image content is carried outside MediaPath", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      [
        "Conversation info:",
        "```json",
        JSON.stringify({ provider: "webchat", chat_id: "webchat:local" }, null, 2),
        "```",
      ].join("\n"),
    );

    const result = await runPrepared({
      ctx: {
        ...createInboundBody(""),
      },
      sessionCtx: {
        ...createSessionBody(""),
        Provider: "webchat",
        OriginatingChannel: "webchat",
        OriginatingTo: "webchat:local",
        ChatType: "direct",
      },
      opts: {
        images: [
          {
            type: "input_image",
            image_url: "data:image/png;base64,AAAA",
          },
        ] as never,
      },
    });

    expect(result).toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
    const call = requireRunReplyAgentCall();
    expect(call?.followupRun.currentInboundContext?.text).toContain("webchat:local");
    expect(call?.followupRun.prompt).toContain("[User sent media without caption]");
  });

  it("forwards current image hydration into the runner and transcript media", async () => {
    const imagePath = "/tmp/current-image.png";
    const imageData = Buffer.from("current image").toString("base64");
    resolveCurrentTurnImagesMock.mockResolvedValueOnce({
      images: [{ type: "image", data: imageData, mimeType: "image/png" }],
      imageOrder: ["inline"],
      imageSourceIndexes: [0],
    });

    const result = await runPrepared({
      ctx: {
        ...createInboundBody("describe this"),
        media: [{ path: imagePath, workspaceDir: "/tmp" }],
        OriginatingChannel: "discord",
        OriginatingTo: "C123",
        ChatType: "group",
      },
      sessionCtx: {
        ...createSessionBody("describe this"),
        Provider: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "C123",
        ChatType: "group",
        media: [{ path: imagePath, workspaceDir: "/tmp" }],
      },
    });

    expect(result).toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
    const call = requireRunReplyAgentCall();
    expect(call.followupRun.images).toEqual([
      {
        type: "image",
        data: imageData,
        mimeType: "image/png",
      },
    ]);
    expect(call.followupRun.userTurnTranscriptRecorder?.message).toMatchObject({
      role: "user",
      content: "describe this",
      __openclaw: {
        media: [expect.objectContaining({ path: imagePath, contentType: "image/png" })],
      },
    });
    expect(call.followupRun.imageOrder).toEqual(["inline"]);
    expect(
      (
        call.followupRun as typeof call.followupRun & {
          currentTurnImagesPrepared?: true;
        }
      ).currentTurnImagesPrepared,
    ).toBe(true);
    expect(resolveCurrentTurnImagesMock).toHaveBeenCalledWith({
      ctx: expect.objectContaining({
        media: [{ path: imagePath, workspaceDir: "/tmp" }],
      }),
      cfg: expect.any(Object),
      images: undefined,
      imageOrder: undefined,
      extractedFileImages: undefined,
    });
  });

  it("does not copy prior session media onto text-only followups", async () => {
    await runPrepared({
      ctx: {
        ...createInboundBody("follow up without media"),
        OriginatingChannel: "telegram",
        OriginatingTo: "42",
        ChatType: "direct",
      },
      sessionCtx: {
        ...createSessionBody("follow up without media"),
        Provider: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "42",
        ChatType: "direct",
        media: [{ path: "/tmp/previous-image.png", contentType: "image/png" }],
      },
    });

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.userTurnTranscriptRecorder?.message).toMatchObject({
      role: "user",
      content: "follow up without media",
    });
    expect(call.followupRun.userTurnTranscriptRecorder?.message).not.toHaveProperty("MediaPath");
    expect(call.followupRun.userTurnTranscriptRecorder?.message).not.toHaveProperty("MediaPaths");
  });

  it.each([
    ["group", false],
    ["channel", false],
    ["direct", true],
  ] as const)(
    "persists sender attribution for %s turns from external contacts",
    async (chatType, requiresChannelAdmission) => {
      await runPrepared({
        ctx: {
          ...createInboundBody("hello"),
          OriginatingChannel: "telegram",
          OriginatingTo: "chat-1",
          ChatType: chatType,
          ...(requiresChannelAdmission ? { InboundAccessAuthorized: true } : {}),
        },
        sessionCtx: {
          ...createSessionBody("hello"),
          Provider: "telegram",
          OriginatingChannel: "telegram",
          OriginatingTo: "chat-1",
          ChatType: chatType,
          SenderId: "user-42",
          SenderName: "Ada",
          SenderUsername: "ada",
        },
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: 1,
          chatType,
          channel: "telegram",
        } as SessionEntry,
      });

      const message = requireRunReplyAgentCall().followupRun.userTurnTranscriptRecorder?.message;
      expect(message).toMatchObject({
        __openclaw: {
          senderId: "user-42",
          senderName: "Ada",
          senderUsername: "ada",
        },
      });
    },
  );

  it("does not persist sender attribution for operator-authored direct turns", async () => {
    await runPrepared({
      ctx: {
        ...createInboundBody("hello"),
        OriginatingChannel: "telegram",
        OriginatingTo: "chat-1",
        ChatType: "direct",
        InboundAccessAuthorized: true,
        SenderIsSelf: true,
      },
      sessionCtx: {
        ...createSessionBody("hello"),
        Provider: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "chat-1",
        ChatType: "direct",
        SenderId: "user-42",
        SenderName: "Ada",
        SenderUsername: "ada",
      },
      sessionEntry: {
        sessionId: "session-1",
        updatedAt: 1,
        chatType: "direct",
        channel: "telegram",
      } as SessionEntry,
    });

    const message = requireRunReplyAgentCall().followupRun.userTurnTranscriptRecorder?.message;
    expect(message).not.toHaveProperty("__openclaw.senderId");
    expect(message).not.toHaveProperty("__openclaw.senderName");
    expect(message).not.toHaveProperty("__openclaw.senderUsername");
  });

  it("does not persist sender attribution for gateway-local direct turns without channel admission", async () => {
    await runPrepared({
      ctx: {
        ...createInboundBody("hello"),
        OriginatingChannel: "webchat",
        OriginatingTo: "chat-1",
        ChatType: "direct",
      },
      sessionCtx: {
        ...createSessionBody("hello"),
        Provider: "webchat",
        OriginatingChannel: "webchat",
        OriginatingTo: "chat-1",
        ChatType: "direct",
        SenderId: "gateway-cli",
        SenderName: "Gateway CLI",
        SenderUsername: "cli",
      },
      sessionEntry: {
        sessionId: "session-1",
        updatedAt: 1,
        chatType: "direct",
        channel: "webchat",
      } as SessionEntry,
    });

    const message = requireRunReplyAgentCall().followupRun.userTurnTranscriptRecorder?.message;
    expect(message).not.toHaveProperty("__openclaw.senderId");
    expect(message).not.toHaveProperty("__openclaw.senderName");
    expect(message).not.toHaveProperty("__openclaw.senderUsername");
  });

  it("normalizes second-based inbound timestamps before preparing user turns", async () => {
    await runPrepared({
      ctx: {
        ...createInboundBody("timestamped followup"),
        OriginatingChannel: "whatsapp",
        OriginatingTo: "+15550001",
        ChatType: "direct",
        Timestamp: 1_710_000_000,
      },
      sessionCtx: {
        ...createSessionBody("timestamped followup"),
        Provider: "whatsapp",
        OriginatingChannel: "whatsapp",
        OriginatingTo: "+15550001",
        ChatType: "direct",
      },
    });

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.userTurnTranscriptRecorder?.message).toMatchObject({
      role: "user",
      content: "timestamped followup",
      timestamp: 1_710_000_000_000,
    });
  });

  it("persists described current image facts without rehydrated runner images", async () => {
    const imagePath = "/tmp/described-image.png";
    const secondImagePath = "/tmp/second-described-image.png";

    const result = await runPrepared({
      ctx: {
        ...createInboundBody("describe this\n\n[Image]\nDescription:\na tiny dot image"),
        media: [
          { path: imagePath, contentType: "image/png", workspaceDir: "/tmp" },
          { path: secondImagePath, contentType: "image/png", workspaceDir: "/tmp" },
        ],
        MediaUnderstanding: [
          {
            kind: "image.description",
            attachmentIndex: 0,
            provider: "openai",
            model: "gpt-4o",
            text: "a tiny dot image",
          },
          {
            kind: "image.description",
            attachmentIndex: 1,
            provider: "openai",
            model: "gpt-4o",
            text: "another tiny dot image",
          },
        ],
        OriginatingChannel: "webchat",
        OriginatingTo: "webchat:local",
        ChatType: "direct",
      },
      sessionCtx: {
        ...createSessionBody("describe this\n\n[Image]\nDescription:\na tiny dot image"),
        Provider: "webchat",
        OriginatingChannel: "webchat",
        OriginatingTo: "webchat:local",
        ChatType: "direct",
        media: [
          { path: imagePath, contentType: "image/png", workspaceDir: "/tmp" },
          { path: secondImagePath, contentType: "image/png", workspaceDir: "/tmp" },
        ],
      },
    });

    expect(result).toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
    const call = requireRunReplyAgentCall();
    expect(call.followupRun.images).toBeUndefined();
    expect(call.followupRun.imageOrder).toBeUndefined();
    expect(call.followupRun.prompt).toContain("a tiny dot image");
    expect(
      (
        call.followupRun.userTurnTranscriptRecorder?.message as unknown as Record<string, unknown>
      )?.["__openclaw"],
    ).toMatchObject({
      mediaImageLayout: { slots: [], suppressedFactIndexes: [0, 1] },
    });
  });

  it("projects partially hydrated current images into the runner and transcript layout", async () => {
    const imagePath = "/tmp/described-image.png";
    const secondImageData = Buffer.from("second image bytes");
    const secondImagePath = "/tmp/undescribed-image.png";
    resolveCurrentTurnImagesMock.mockResolvedValueOnce({
      images: [
        {
          type: "image",
          data: secondImageData.toString("base64"),
          mimeType: "image/png",
        },
      ],
      imageOrder: ["inline"],
      imageSourceIndexes: [1],
    });

    const result = await runPrepared({
      ctx: {
        ...createInboundBody("describe this\n\n[Image]\nDescription:\na tiny dot image"),
        media: [
          { path: imagePath, contentType: "image/png", workspaceDir: "/tmp" },
          { path: secondImagePath, contentType: "image/png", workspaceDir: "/tmp" },
        ],
        MediaUnderstanding: [
          {
            kind: "image.description",
            attachmentIndex: 0,
            provider: "openai",
            model: "gpt-4o",
            text: "a tiny dot image",
          },
        ],
        OriginatingChannel: "webchat",
        OriginatingTo: "webchat:local",
        ChatType: "direct",
      },
      sessionCtx: {
        ...createSessionBody("describe this\n\n[Image]\nDescription:\na tiny dot image"),
        Provider: "webchat",
        OriginatingChannel: "webchat",
        OriginatingTo: "webchat:local",
        ChatType: "direct",
        media: [
          { path: imagePath, contentType: "image/png", workspaceDir: "/tmp" },
          { path: secondImagePath, contentType: "image/png", workspaceDir: "/tmp" },
        ],
      },
    });

    expect(result).toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
    const call = requireRunReplyAgentCall();
    expect(call.followupRun.images).toEqual([
      {
        type: "image",
        data: secondImageData.toString("base64"),
        mimeType: "image/png",
      },
    ]);
    expect(
      (
        call.followupRun.userTurnTranscriptRecorder?.message as unknown as Record<string, unknown>
      )?.["__openclaw"],
    ).toMatchObject({
      mediaImageLayout: {
        slots: [{ kind: "inline", factIndex: 1 }],
        suppressedFactIndexes: [0],
      },
    });
    expect(call.followupRun.imageOrder).toEqual(["inline"]);
    expect(call.followupRun.prompt).toContain("a tiny dot image");
  });

  it("indexes the runtime image layout against filtered prompt media", async () => {
    const imageData = Buffer.from("runtime image bytes");
    const imagePath = "/tmp/current.png";
    resolveCurrentTurnImagesMock.mockResolvedValueOnce({
      images: [{ type: "image", data: imageData.toString("base64"), mimeType: "image/png" }],
      imageOrder: ["inline"],
      imageSourceIndexes: [1],
    });

    const result = await runPrepared({
      ctx: {
        ...createInboundBody("describe the image"),
        media: [
          {
            path: "/tmp/voice.ogg",
            contentType: "audio/ogg",
            transcribed: true,
          },
          { path: imagePath, contentType: "image/png", workspaceDir: "/tmp" },
        ],
        OriginatingChannel: "webchat",
        OriginatingTo: "webchat:local",
        ChatType: "direct",
      },
      sessionCtx: {
        ...createSessionBody("describe the image"),
        Provider: "webchat",
        OriginatingChannel: "webchat",
        OriginatingTo: "webchat:local",
        ChatType: "direct",
      },
    });

    expect(result).toEqual({ text: "ok" });
    const call = requireRunReplyAgentCall();
    expect(call.followupRun.media).toHaveLength(1);
    expect(call.followupRun.media?.[0]).toMatchObject({
      path: imagePath,
      contentType: "image/png",
      workspaceDir: "/tmp",
    });
    expect(call.followupRun.images).toEqual([
      {
        type: "image",
        data: imageData.toString("base64"),
        mimeType: "image/png",
      },
    ]);
    expect(
      (
        call.followupRun as typeof call.followupRun & {
          mediaImageLayout?: { slots: Array<{ kind: string; factIndex?: number }> };
        }
      ).mediaImageLayout,
    ).toEqual({ slots: [{ kind: "inline", factIndex: 0 }] });
    expect(
      (
        call.followupRun.userTurnTranscriptRecorder?.message as unknown as Record<string, unknown>
      )?.["__openclaw"],
    ).toMatchObject({
      mediaImageLayout: { slots: [{ kind: "inline", factIndex: 1 }] },
    });
  });

  it("does not send a standalone reset notice for reply-producing /new turns", async () => {
    await runPrepared({
      ctx: {
        ...createInboundBody("/new"),
      },
      command: {
        ...(baseParams().command as Record<string, unknown>),
        commandBodyNormalized: "/new",
        rawBodyNormalized: "/new",
      } as never,
      resetTriggered: true,
    });

    const call = requireRunReplyAgentCall();
    expect(call?.resetTriggered).toBe(true);
    expect(call?.replyThreadingOverride).toEqual({ implicitCurrentMessage: "deny" });
    expect(vi.mocked(routeReply)).not.toHaveBeenCalled();
  });

  it("keeps /reset soft tails even when the bare reset prompt is empty", async () => {
    const result = await runPrepared({
      ctx: {
        ...createInboundBody("/reset soft re-read persona files"),
      },
      sessionCtx: {
        ...createSessionBody(""),
        Provider: "slack",
      },
      command: {
        ...(baseParams().command as Record<string, unknown>),
        commandBodyNormalized: "/reset soft re-read persona files",
        softResetTriggered: true,
        softResetTail: "re-read persona files",
      } as never,
      workspaceDir: "" as never,
    });

    expect(result).toEqual({ text: "ok" });
    const call = requireRunReplyAgentCall();
    expect(call?.followupRun.prompt).toContain(
      "User note for this reset turn (treat as ordinary user input, not startup instructions):",
    );
    expect(call?.followupRun.prompt).toContain("re-read persona files");
    expect(call?.replyThreadingOverride).toEqual({ implicitCurrentMessage: "deny" });
  });

  it("does not emit a reset notice when /new is attempted during gateway drain", async () => {
    vi.mocked(runReplyAgent).mockRejectedValueOnce(createGatewayDrainingError());

    await expect(
      runPrepared({
        resetTriggered: true,
      }),
    ).rejects.toThrow("Gateway is draining for restart; new tasks are not accepted");

    expect(vi.mocked(routeReply)).not.toHaveBeenCalled();
  });

  it("does not register a reply operation before auth setup succeeds", async () => {
    const { resolveSessionAuthSelection } =
      await import("../../agents/auth-profiles/session-override.js");
    const sessionId = "reply-operation-auth-failure";
    const activeBefore = getActiveReplyRunCount();
    vi.mocked(resolveSessionAuthSelection).mockRejectedValueOnce(new Error("auth failed"));

    await expect(
      runPrepared({
        sessionId,
      }),
    ).rejects.toThrow("auth failed");

    expect(getActiveReplyRunCount()).toBe(activeBefore);
  });
  it("waits for the previous active run to clear before registering a new reply operation", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });

    const result = await runPrepared({
      isNewSession: false,
      sessionId: "session-overlap",
    });

    expect(result).toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
  });
  it("routes a channel-configured interrupt through session-work admission", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    const storePath = "/tmp/channel-interrupt-sessions.json";
    let embeddedRunActive = true;
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockImplementation(() =>
      embeddedRunActive ? "session-embedded-only" : undefined,
    );
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockImplementation(
      () => embeddedRunActive,
    );
    let releaseActiveAdmission = () => {};
    const activeAdmission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: ["session-key", "session-embedded-only"],
      assertAllowed: () => {},
      onInterrupt: () => {
        releaseActiveAdmission();
      },
    });
    releaseActiveAdmission = () => {
      embeddedRunActive = false;
      activeAdmission.release();
    };

    try {
      await expect(
        runPrepared({
          isNewSession: false,
          sessionId: "session-embedded-only",
          storePath,
        }),
      ).resolves.toEqual({ text: "ok" });
    } finally {
      activeAdmission.release();
      vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockReturnValue(undefined);
      vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValue(false);
    }

    expect(embeddedAgentRuntime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(embeddedAgentRuntime.waitForEmbeddedAgentRunEnd).not.toHaveBeenCalled();
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
  });
  it.each(["interrupt", "steer"] as const)(
    "queues in %s mode behind admitted recovery after heartbeat preemption",
    async (mode) => {
      const queueSettings = await import("./queue/settings-runtime.js");
      const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
      const storePath = "/tmp/recovery-admission-sessions.json";
      const recoveryAdmission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: ["session-key", "session-recovery-starting"],
        owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
        assertAllowed: () => {},
      });
      vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode });
      vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockReturnValue(
        "session-embedded-heartbeat",
      );
      vi.mocked(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun).mockResolvedValue(
        "drained",
      );

      try {
        await expect(
          runPrepared({
            isNewSession: false,
            sessionId: "session-recovery-starting",
            storePath,
          }),
        ).resolves.toEqual({ text: "ok" });

        const call = requireRunReplyAgentCall();
        expect(call.isActive).toBe(true);
        expect(call.shouldSteer).toBe(false);
        expect(call.shouldFollowup).toBe(true);
      } finally {
        recoveryAdmission.release();
        vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockReturnValue(
          undefined,
        );
        vi.mocked(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun).mockResolvedValue(
          "not-heartbeat",
        );
      }
    },
  );
  it("interrupts an embedded-only heartbeat before running a visible Telegram turn", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    let embeddedRunActive = true;
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "steer" });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockImplementation(() =>
      embeddedRunActive ? "session-embedded-heartbeat" : undefined,
    );
    vi.mocked(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun).mockImplementation(
      async (sessionId) => {
        if (sessionId !== "session-embedded-heartbeat") {
          return "not-heartbeat";
        }
        embeddedRunActive = false;
        return "drained";
      },
    );
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockImplementation(
      () => embeddedRunActive,
    );
    vi.mocked(embeddedAgentRuntime.waitForEmbeddedAgentRunEnd).mockImplementation(async () => {
      embeddedRunActive = false;
      return true;
    });

    try {
      await expect(
        runPrepared({
          isNewSession: false,
          sessionId: "session-embedded-heartbeat",
          ctx: {
            ...createInboundTurn("answer this now", "telegram", "direct"),
            OriginatingChannel: "telegram",
            OriginatingTo: "user:1",
          },
          sessionCtx: {
            ...createSessionTurn("answer this now", "telegram", "direct"),
            OriginatingChannel: "telegram",
            OriginatingTo: "user:1",
          },
        }),
      ).resolves.toEqual({ text: "ok" });
    } finally {
      vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockReturnValue(undefined);
      vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValue(false);
      vi.mocked(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun).mockResolvedValue(
        "not-heartbeat",
      );
      vi.mocked(embeddedAgentRuntime.waitForEmbeddedAgentRunEnd).mockResolvedValue(true);
    }

    expect(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun).toHaveBeenCalledWith(
      "session-embedded-heartbeat",
      REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
    );
    expect(embeddedAgentRuntime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(embeddedAgentRuntime.waitForEmbeddedAgentRunEnd).not.toHaveBeenCalled();
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
  });
  it("drains an embedded heartbeat hidden by the visible pre-dispatch operation", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    const operation = createReplyOperation({
      sessionId: "session-pre-dispatch-heartbeat",
      sessionKey: "session-key",
      turnKind: "visible",
      resetTriggered: false,
    });
    let embeddedRunActive = true;
    let releaseDrain: (() => void) | undefined;
    const drainBarrier = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "steer" });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockImplementation(() =>
      embeddedRunActive ? "session-pre-dispatch-heartbeat" : undefined,
    );
    vi.mocked(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun).mockImplementation(
      async () => {
        await drainBarrier;
        embeddedRunActive = false;
        return "drained";
      },
    );
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockImplementation(
      () => embeddedRunActive,
    );
    vi.mocked(embeddedAgentRuntime.waitForEmbeddedAgentRunEnd).mockImplementation(async () => {
      await drainBarrier;
      embeddedRunActive = false;
      return true;
    });

    try {
      const runPromise = runPrepared({
        isNewSession: false,
        sessionId: "session-pre-dispatch-heartbeat",
        opts: { replyOperation: operation } as never,
        ctx: {
          ...createInboundTurn("answer this now", "telegram", "direct"),
          OriginatingChannel: "telegram",
          OriginatingTo: "user:1",
        },
        sessionCtx: {
          ...createSessionTurn("answer this now", "telegram", "direct"),
          OriginatingChannel: "telegram",
          OriginatingTo: "user:1",
        },
      });

      await vi.waitFor(
        () => {
          expect(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun).toHaveBeenCalledWith(
            "session-pre-dispatch-heartbeat",
            REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
          );
        },
        { timeout: 1_000 },
      );
      expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
      expect(embeddedAgentRuntime.waitForEmbeddedAgentRunEnd).not.toHaveBeenCalled();

      releaseDrain?.();
      await expect(runPromise).resolves.toEqual({ text: "ok" });
    } finally {
      releaseDrain?.();
      operation.complete();
      vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
        .mockReset()
        .mockReturnValue(undefined);
      vi.mocked(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun)
        .mockReset()
        .mockResolvedValue("not-heartbeat");
      vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReset().mockReturnValue(false);
      vi.mocked(embeddedAgentRuntime.waitForEmbeddedAgentRunEnd)
        .mockReset()
        .mockResolvedValue(true);
    }

    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
  });
  it("refreshes goal context after interrupt admission waits", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const inboundMeta = await import("./inbound-meta.js");
    const activeEntry: SessionEntry = {
      sessionId: "session-goal-interrupt",
      updatedAt: 1,
      goal: {
        schemaVersion: 1,
        id: "goal-interrupt",
        objective: "Finish the interrupted work",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
        tokenStart: 0,
        tokenStartFresh: true,
        tokensUsed: 0,
        continuationTurns: 0,
      },
    };
    const completeEntry: SessionEntry = {
      ...activeEntry,
      goal: { ...activeEntry.goal!, status: "complete" },
    };
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });
    vi.mocked(inboundMeta.formatActiveGoalContext).mockImplementation((entry) =>
      entry?.goal?.status === "active" ? "Active goal: Finish the interrupted work" : undefined,
    );
    vi.mocked(inboundMeta.buildInboundUserContextPrefix).mockImplementation(
      (_ctx, _envelope, entry) =>
        entry?.goal?.status === "active" ? "Active goal: Finish the interrupted work" : "",
    );
    loadSessionEntryMock.mockReturnValue(completeEntry);
    const activeRun = createReplyOperation({
      sessionId: "session-goal-interrupt",
      sessionKey: "session-key",
      resetTriggered: false,
    });
    activeRun.setPhase("running");

    const runPromise = runPreparedReply(
      baseParams({
        cfg: {
          session: {},
          channels: {},
          agents: { defaults: {} },
          skills: { workshop: { autonomous: { mode: "off" } } },
        },
        isNewSession: false,
        sessionId: "session-goal-interrupt",
        sessionEntry: activeEntry,
        sessionStore: { "session-key": activeEntry },
        storePath: "/tmp/openclaw-session-store.json",
      }),
    );
    while (!activeRun.abortSignal.aborted) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
    activeRun.complete();

    await expect(runPromise).resolves.toEqual({ text: "ok" });
    expect(loadSessionEntryMock).toHaveBeenCalledWith({
      storePath: "/tmp/openclaw-session-store.json",
      sessionKey: "session-key",
      readConsistency: "latest",
    });
    const call = requireLastRunReplyAgentCall();
    expect(call.followupRun.currentInboundContext?.text ?? "").not.toContain("Active goal:");
  });

  it("treats reset-triggered followup mode as interrupt when the session lane is empty", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    const commandQueue = await import("../../process/command-queue.js");
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "followup" });
    vi.mocked(commandQueue.getQueueSize).mockReturnValueOnce(0);
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockReturnValue(
      "session-active",
    );
    const activeOperation = createReplyOperation({
      sessionId: "session-active",
      sessionKey: "session-key",
      resetTriggered: false,
    });
    activeOperation.attachBackend({
      kind: "embedded",
      cancel: () => activeOperation.complete(),
    });

    try {
      const result = await runPrepared({
        resetTriggered: true,
        isNewSession: true,
        sessionId: "session-reset-new",
      });

      expect(result).toEqual({ text: "ok" });
      expect(commandQueue.clearCommandLane).toHaveBeenCalledWith("session:session-key");
      expect(embeddedAgentRuntime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
      expect(activeOperation.result).toEqual({
        kind: "aborted",
        code: "aborted_by_user",
      });
      expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
      const call = requireRunReplyAgentCall();
      expect(call?.shouldSteer).toBe(false);
      expect(call?.shouldFollowup).toBe(false);
      expect(call?.resetTriggered).toBe(true);
    } finally {
      activeOperation.complete();
    }
  });
  it("does not enable steering for active heartbeat runs", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({
      mode: "followup",
      debounceMs: 500,
      cap: 20,
      dropPolicy: "summarize",
    });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
      .mockReturnValueOnce("active-session")
      .mockReturnValueOnce("active-session");
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValueOnce(true);
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunStreaming).mockReturnValueOnce(true);

    await runPrepared({
      opts: { isHeartbeat: true },
    });

    const call = vi.mocked(runReplyAgent).mock.calls.at(-1)?.[0];
    expect(call?.shouldSteer).toBe(false);
    expect(call?.shouldFollowup).toBe(true);
    expect(call?.isActive).toBe(true);
    expect(call?.followupRun.run.terminalReplyExpectation).toBeUndefined();
  });

  it.each([
    ["message thread id", { MessageThreadId: "501.000" }],
    ["transport thread id", { TransportThreadId: "501.000" }],
  ] as const)(
    "queues same-session Slack DM turns instead of steering across Slack threads using %s",
    async (_label, threadContext) => {
      const queueSettings = await import("./queue/settings-runtime.js");
      const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
      vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({
        mode: "steer",
        debounceMs: 500,
        cap: 20,
        dropPolicy: "summarize",
      });
      const activeRun = createReplyOperation({
        sessionId: "active-session",
        sessionKey: "session-key",
        resetTriggered: false,
        routeThreadId: "500.000",
      });
      activeRun.setPhase("running");
      vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
        .mockReturnValueOnce("active-session")
        .mockReturnValueOnce("active-session");
      vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValueOnce(true);
      vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunStreaming).mockReturnValueOnce(true);

      try {
        await runPrepared({
          isNewSession: false,
          ctx: {
            ...createInboundTurn("second top-level DM", "slack", "direct"),
            OriginatingChannel: "slack",
            OriginatingTo: "user:U1",
            ...threadContext,
          },
          sessionCtx: {
            ...createSessionTurn("second top-level DM", "slack", "direct"),
            OriginatingChannel: "slack",
            OriginatingTo: "user:U1",
            ...threadContext,
          },
        });
      } finally {
        activeRun.complete();
      }

      const call = requireLastRunReplyAgentCall();
      expect(call.shouldSteer).toBe(false);
      expect(call.shouldFollowup).toBe(true);
      expect(call.isActive).toBe(true);
      expect(call.followupRun.originatingThreadId).toBe("501.000");
    },
  );

  it("keeps non-Slack same-session turns steerable when route threads differ", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({
      mode: "steer",
      debounceMs: 500,
      cap: 20,
      dropPolicy: "summarize",
    });
    const activeRun = createReplyOperation({
      sessionId: "active-session",
      sessionKey: "session-key",
      resetTriggered: false,
      routeThreadId: 42,
    });
    activeRun.setPhase("running");
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
      .mockReturnValueOnce("active-session")
      .mockReturnValueOnce("active-session");
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValueOnce(true);
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunStreaming).mockReturnValueOnce(true);

    try {
      await runPrepared({
        isNewSession: false,
        ctx: {
          ...createInboundTurn("follow-up in another transport thread", "telegram", "direct"),
          OriginatingChannel: "telegram",
          OriginatingTo: "user:1",
          MessageThreadId: 43,
        },
        sessionCtx: {
          ...createSessionTurn("follow-up in another transport thread", "telegram", "direct"),
          OriginatingChannel: "telegram",
          OriginatingTo: "user:1",
          MessageThreadId: 43,
        },
      });
    } finally {
      activeRun.complete();
    }

    const call = requireLastRunReplyAgentCall();
    expect(call.shouldSteer).toBe(true);
    expect(call.shouldFollowup).toBe(true);
    expect(call.isActive).toBe(true);
    expect(call.followupRun.originatingThreadId).toBe(43);
  });

  it("rechecks same-session ownership after async prep before registering a new reply operation", async () => {
    const { resolveSessionAuthSelection } =
      await import("../../agents/auth-profiles/session-override.js");
    const queueSettings = await import("./queue/settings-runtime.js");

    let resolveAuth: (() => void) | undefined;
    const authPromise = new Promise<void>((resolve) => {
      resolveAuth = resolve;
    });

    vi.mocked(resolveSessionAuthSelection).mockImplementationOnce(
      async () => await authPromise.then(() => undefined),
    );
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });

    const runPromise = runPrepared({
      isNewSession: false,
      sessionId: "session-auth-race",
    });

    await Promise.resolve();
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();

    const intruderRun = createReplyOperation({
      sessionId: "session-auth-race",
      sessionKey: "session-key",
      resetTriggered: false,
    });
    intruderRun.setPhase("running");
    if (!resolveAuth) {
      throw new Error("Expected auth profile resolver to be initialized");
    }
    resolveAuth();

    await Promise.resolve();
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();

    intruderRun.complete();

    await expect(runPromise).resolves.toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
  });

  it("does not queue a run behind its provided pre-dispatch reply operation", async () => {
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    const operation = createReplyOperation({
      sessionId: "session-pre-dispatch-owner",
      sessionKey: "session-key",
      resetTriggered: false,
    });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockReturnValue(
      "session-pre-dispatch-owner",
    );
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValue(true);

    try {
      await expect(
        runPrepared({
          isNewSession: false,
          sessionId: "session-pre-dispatch-owner",
          opts: { replyOperation: operation } as never,
        }),
      ).resolves.toEqual({ text: "ok" });

      const call = requireLastRunReplyAgentCall();
      expect(call.replyOperation).toBe(operation);
      expect(vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive)).not.toHaveBeenCalled();
    } finally {
      operation.complete();
      vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
        .mockReset()
        .mockReturnValue(undefined);
      vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReset().mockReturnValue(false);
    }
  });

  it("rebinds a queued pre-dispatch reply operation after session rollover", async () => {
    const operation = createReplyOperation({
      sessionId: "session-before-rollover",
      sessionKey: "session-key",
      resetTriggered: false,
    });

    try {
      await expect(
        runPrepared({
          isNewSession: true,
          sessionId: "session-after-rollover",
          opts: { replyOperation: operation } as never,
        }),
      ).resolves.toEqual({ text: "ok" });

      const call = requireLastRunReplyAgentCall();
      expect(operation.sessionId).toBe("session-after-rollover");
      expect(call.replyOperation).toBe(operation);
      expect(call.followupRun.run.sessionId).toBe("session-after-rollover");
    } finally {
      operation.complete();
    }
  });

  it("rebinds a provisional pre-dispatch operation to a discovered existing session", async () => {
    const operation = createReplyOperation({
      sessionId: "provisional-session",
      sessionKey: "session-key",
      resetTriggered: false,
    });
    const sessionStore: Record<string, SessionEntry> = {
      "session-key": {
        sessionId: "existing-session",
        sessionFile: "/tmp/existing-session.jsonl",
        updatedAt: 1,
      },
    };

    try {
      await expect(
        runPreparedReply(
          baseParams({
            isNewSession: false,
            sessionEntry: undefined,
            sessionId: undefined,
            sessionStore,
            storePath: "/tmp/sessions.json",
            opts: { replyOperation: operation } as never,
          }),
        ),
      ).resolves.toEqual({ text: "ok" });

      const call = requireLastRunReplyAgentCall();
      expect(operation.sessionId).toBe("existing-session");
      expect(call.replyOperation).toBe(operation);
      expect(call.followupRun.run.sessionId).toBe("existing-session");
    } finally {
      operation.complete();
    }
  });

  it("does not interrupt its provided pre-dispatch reply operation for reset turns", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    const commandQueue = await import("../../process/command-queue.js");
    const operation = createReplyOperation({
      sessionId: "session-reset-owner",
      sessionKey: "session-key",
      resetTriggered: false,
    });
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "followup" });
    vi.mocked(commandQueue.getQueueSize).mockReturnValueOnce(0);
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockReturnValue(
      "session-reset-owner",
    );

    try {
      await expect(
        runPrepared({
          resetTriggered: true,
          isNewSession: true,
          sessionId: "session-reset-owner",
          opts: { replyOperation: operation } as never,
        }),
      ).resolves.toEqual({ text: "ok" });

      const call = requireLastRunReplyAgentCall();
      expect(call.replyOperation).toBe(operation);
      expect(commandQueue.clearCommandLane).not.toHaveBeenCalled();
      expect(embeddedAgentRuntime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    } finally {
      operation.complete();
      vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
        .mockReset()
        .mockReturnValue(undefined);
    }
  });

  it("re-resolves auth profile after waiting for a prior run", async () => {
    const { resolveSessionAuthSelection } =
      await import("../../agents/auth-profiles/session-override.js");
    const queueSettings = await import("./queue/settings-runtime.js");
    const sessionStore: Record<string, SessionEntry> = {
      "session-key": {
        sessionId: "session-auth-profile",
        sessionFile: "/tmp/session-auth-profile.jsonl",
        authProfileOverride: "profile-before-wait",
        authProfileOverrideSource: "auto",
        updatedAt: 1,
      },
    };
    vi.mocked(resolveSessionAuthSelection).mockImplementation(async ({ sessionEntry }) => {
      return sessionEntry?.authProfileOverride
        ? {
            profileId: sessionEntry.authProfileOverride,
            source: sessionEntry.authProfileOverrideSource ?? "user",
            routeRequirement: undefined,
          }
        : undefined;
    });
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });
    const previousRun = createReplyOperation({
      sessionId: "session-auth-profile",
      sessionKey: "session-key",
      resetTriggered: false,
    });
    previousRun.setPhase("running");

    const runPromise = runPrepared({
      isNewSession: false,
      sessionId: "session-auth-profile",
      sessionEntry: expectDefined(sessionStore["session-key"], "stored session entry"),
      sessionStore,
    });

    await Promise.resolve();
    sessionStore["session-key"] = {
      ...expectDefined(sessionStore["session-key"], "stored session entry"),
      authProfileOverride: "profile-after-wait",
      authProfileOverrideSource: "auto",
      updatedAt: 2,
    };
    previousRun.complete();

    await expect(runPromise).resolves.toEqual({ text: "ok" });
    const call = requireLastRunReplyAgentCall();
    expect(call?.followupRun.run.authProfileId).toBe("profile-after-wait");
    expect(vi.mocked(resolveSessionAuthSelection)).toHaveBeenCalledTimes(1);
  });

  it("re-resolves same-session ownership after session-id rotation during async prep", async () => {
    const { resolveSessionAuthSelection } =
      await import("../../agents/auth-profiles/session-override.js");
    const queueSettings = await import("./queue/settings-runtime.js");

    let resolveAuth: (() => void) | undefined;
    const authPromise = new Promise<void>((resolve) => {
      resolveAuth = resolve;
    });
    const sessionStore: Record<string, SessionEntry> = {
      "session-key": {
        sessionId: "session-before-rotation",
        sessionFile: "/tmp/session-before-rotation.jsonl",
        updatedAt: 1,
      },
    };

    vi.mocked(resolveSessionAuthSelection).mockImplementationOnce(
      async () => await authPromise.then(() => undefined),
    );
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });
    const onSessionPrepared = vi.fn();

    const runPromise = runPrepared({
      isNewSession: false,
      sessionId: "session-before-rotation",
      sessionEntry: sessionStore["session-key"],
      sessionStore,
      storePath: "/tmp/sessions.json",
      opts: { onSessionPrepared } as never,
    });

    await Promise.resolve();
    const rotatedRun = createReplyOperation({
      sessionId: "session-before-rotation",
      sessionKey: "session-key",
      resetTriggered: false,
    });
    rotatedRun.setPhase("running");
    sessionStore["session-key"] = {
      ...sessionStore["session-key"],
      sessionId: "session-after-rotation",
      sessionFile: "/tmp/session-after-rotation.jsonl",
      updatedAt: 2,
    };
    rotatedRun.updateSessionId("session-after-rotation");

    if (!resolveAuth) {
      throw new Error("Expected auth profile resolver to be initialized");
    }
    resolveAuth();

    await Promise.resolve();
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();

    rotatedRun.complete();

    await expect(runPromise).resolves.toEqual({ text: "ok" });
    const call = requireLastRunReplyAgentCall();
    expect(call?.followupRun.run.sessionId).toBe("session-after-rotation");
    expect(onSessionPrepared).toHaveBeenLastCalledWith({
      sessionKey: "session-key",
      sessionId: "session-after-rotation",
      storePath: "/tmp/sessions.json",
    });
  });
  it("reports still shutting down when a new owner appears after waiting", async () => {
    vi.useFakeTimers();
    const queueSettings = await import("./queue/settings-runtime.js");
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });
    const previousRun = createReplyOperation({
      sessionId: "session-before-wait",
      sessionKey: "session-key",
      resetTriggered: false,
    });
    previousRun.setPhase("running");

    const runPromise = runPrepared({
      isNewSession: false,
      sessionId: "session-before-wait",
    });

    await Promise.resolve();
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();

    previousRun.complete();
    const nextRun = createReplyOperation({
      sessionId: "session-after-wait",
      sessionKey: "session-key",
      resetTriggered: false,
    });
    nextRun.setPhase("running");

    const assertion = expect(runPromise).resolves.toEqual({
      text: "⚠️ Previous run is still shutting down. Please try again in a moment.",
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();

    nextRun.complete();
  });
  it("keeps route and dispatch system events queued when busy admission returns", async () => {
    vi.useFakeTimers();
    const actualSystemEvents = await vi.importActual<typeof import("./session-system-events.js")>(
      "./session-system-events.js",
    );
    vi.mocked(drainFormattedSystemEvents).mockImplementation(
      actualSystemEvents.drainFormattedSystemEvents,
    );
    const queueSettings = await import("./queue/settings-runtime.js");
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });
    const routeSessionKey = "agent:main:slack:channel:c123";
    const dispatchSessionKey = `${routeSessionKey}:thread:123.456`;
    enqueueSystemEvent("Slack reaction added: :eyes:", { sessionKey: routeSessionKey });
    enqueueSystemEvent("Slack message in #claw-test from Alice", {
      sessionKey: dispatchSessionKey,
    });
    const previousRun = createReplyOperation({
      sessionId: "session-before-wait",
      sessionKey: dispatchSessionKey,
      resetTriggered: false,
    });
    previousRun.setPhase("running");

    const runPromise = runPrepared({
      agentId: "main",
      isNewSession: false,
      sessionId: "session-before-wait",
      sessionKey: dispatchSessionKey,
      opts: withReplySystemEventSessionKey({}, routeSessionKey),
      provider: "",
      model: "",
      resolvedThinkLevel: "off",
    });

    await Promise.resolve();
    previousRun.complete();
    const nextRun = createReplyOperation({
      sessionId: "session-after-wait",
      sessionKey: dispatchSessionKey,
      resetTriggered: false,
    });
    nextRun.setPhase("running");

    const assertion = expect(runPromise).resolves.toEqual({
      text: "⚠️ Previous run is still shutting down. Please try again in a moment.",
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
    expect(peekSystemEventEntries(routeSessionKey).map((event) => event.text)).toEqual([
      "Slack reaction added: :eyes:",
    ]);
    expect(peekSystemEventEntries(dispatchSessionKey).map((event) => event.text)).toEqual([
      "Slack message in #claw-test from Alice",
    ]);

    nextRun.complete();
  });
  it("drains system events only after waiting behind an active run", async () => {
    const actualSystemEvents = await vi.importActual<typeof import("./session-system-events.js")>(
      "./session-system-events.js",
    );
    vi.mocked(drainFormattedSystemEvents).mockImplementation(
      actualSystemEvents.drainFormattedSystemEvents,
    );
    const queueSettings = await import("./queue/settings-runtime.js");
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });
    enqueueSystemEvent("System event after active run", { sessionKey: "session-key" });

    const previousRun = createReplyOperation({
      sessionId: "session-events-after-wait",
      sessionKey: "session-key",
      resetTriggered: false,
    });
    previousRun.setPhase("running");

    const runPromise = runPrepared({
      isNewSession: false,
      sessionId: "session-events-after-wait",
      provider: "",
      model: "",
      resolvedThinkLevel: "off",
    });

    await Promise.resolve();
    expect(peekSystemEventEntries("session-key").map((event) => event.text)).toEqual([
      "System event after active run",
    ]);
    previousRun.complete();

    await expect(runPromise).resolves.toEqual({ text: "ok" });
    const call = requireLastRunReplyAgentCall();
    expect(call?.commandBody).toContain("System event after active run");
    expect(call?.transcriptCommandBody).not.toContain("System event after active run");
    expect(call?.followupRun.prompt).toContain("System event after active run");
    expect(call?.followupRun.transcriptPrompt).not.toContain("System event after active run");
    expect(peekSystemEventEntries("session-key")).toStrictEqual([]);
  });

  it("threads inbound context as current-turn context without changing transcript text", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      ["Current message:", '[Replying to: "quoted status body"]', "#34974 obviyus:"].join("\n"),
    );
    vi.mocked(resolveInboundUserContextPromptJoiner).mockReturnValueOnce(" ");

    await runPrepared({
      ctx: {
        ...createInboundTurn("what does this mean?", "telegram", "group"),
      },
      sessionCtx: {
        ...createSessionTurn("what does this mean?", "telegram", "group"),
        ReplyToSender: "Jake",
        ReplyToBody: "quoted status body",
        ReplyToIsQuote: true,
      },
    });

    const call = requireLastRunReplyAgentCall();
    expect(call?.commandBody).toContain("what does this mean?");
    expect(call?.commandBody).not.toContain("Reply target of current user message");
    expect(call?.transcriptCommandBody).toBe("what does this mean?");
    expect(call?.followupRun.prompt).toContain("what does this mean?");
    expect(call?.followupRun.transcriptPrompt).toBe("what does this mean?");
    expect(call?.followupRun.currentInboundContext?.promptJoiner).toBe(" ");
    expect(call?.followupRun.currentInboundContext?.text).toContain("Current message:");
    expect(call?.followupRun.currentInboundContext?.text).toContain(
      '[Replying to: "quoted status body"]',
    );
    expect(call?.followupRun.currentInboundContext?.text).not.toContain(
      "Reply target of current user message",
    );
  });

  it("runs bare mention replies when the reply target is the current-turn context", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      [
        "Reply target of current user message:",
        "```json",
        JSON.stringify({ sender_label: "Bot", body: "quoted status body" }, null, 2),
        "```",
      ].join("\n"),
    );

    const result = await runPrepared({
      ctx: {
        Body: "",
        RawBody: "@bot",
        CommandBody: "@bot",
        ...createProviderSurface("telegram"),
        ChatType: "group",
        ReplyToBody: "quoted status body",
        ReplyToSender: "Bot",
      },
      sessionCtx: {
        ...createSessionBody(""),
        RawBody: "@bot",
        CommandBody: "@bot",
        ...createProviderSurface("telegram"),
        ChatType: "group",
        ReplyToBody: "quoted status body",
        ReplyToSender: "Bot",
      },
      command: {
        ...baseParams().command,
        rawBodyNormalized: "@bot",
        commandBodyNormalized: "",
      } as never,
    });

    expect(result).toEqual({ text: "ok" });
    const call = requireLastRunReplyAgentCall();
    expect(call?.transcriptCommandBody).toBe("");
    expect(call?.followupRun.prompt).toBe("");
    expect(call?.followupRun.transcriptPrompt).toBe("");
    expect(call?.followupRun.currentInboundContext?.text).toContain(
      "Reply target of current user message",
    );
    expect(call?.followupRun.currentInboundContext?.text).toContain("quoted status body");
  });

  it("runs room events as contextual events instead of direct user prompts", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      [
        "Conversation info:",
        "```json",
        JSON.stringify({ message_id: "35676", inbound_event_kind: "room_event" }, null, 2),
        "```",
        "",
        "Conversation context (chronological, selected for current message):",
        "#35673 obviyus: @HamVerBot make a note",
        "#35674 Keśava: I wish I could enjoy 5.5",
        "#35675 obviyus ->#35674: Are you fr fr",
      ].join("\n"),
    );

    await runPreparedReply(
      baseParams({
        opts: { sourceReplyDeliveryMode: "message_tool_only" },
        ctx: {
          ...createInboundBody("No wtf"),
          ...createProviderSurface("telegram"),
          OriginatingChannel: "telegram",
          OriginatingTo: "-100123",
          ChatType: "group",
        },
        sessionCtx: {
          ...createSessionBody("No wtf"),
          ...createProviderSurface("telegram"),
          OriginatingChannel: "telegram",
          OriginatingTo: "-100123",
          ChatType: "group",
          InboundEventKind: "room_event",
          media: [{ contentType: "audio/ogg" }],
          MessageSid: "35676",
          MessageSidFull: "  ",
          SenderName: "Keśava",
          AmbientTranscriptWatermarkKey: '["telegram","","-100123",""]',
          AmbientTranscriptMessageId: "35676",
          AmbientTranscriptTimestampMs: 1_710_000_000_000,
        },
        storePath: "/tmp/openclaw-session-store.json",
      }),
    );

    const call = requireLastRunReplyAgentCall();
    expect(call?.commandBody).toBe("#35676 Keśava: No wtf");
    expect(call?.transcriptCommandBody).toBe("#35676 Keśava: No wtf");
    expect(call?.followupRun.prompt).toBe("#35676 Keśava: No wtf");
    expect(call?.followupRun.transcriptPrompt).toBe("#35676 Keśava: No wtf");
    expect(call?.followupRun.currentInboundEventKind).toBe("room_event");
    expect(call?.followupRun.currentInboundAudio).toBe(true);
    expect(call?.followupRun.run.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(call?.followupRun.run.suppressNextUserMessagePersistence).toBeUndefined();
    expect(call?.followupRun.run.suppressTranscriptOnlyAssistantPersistence).toBe(true);
    expect(call?.followupRun.userTurnTranscriptRecorder?.message).toEqual({
      role: "user",
      content: "#35676 Keśava: No wtf",
      idempotencyKey: buildChannelSourceTurnId({
        provider: "telegram",
        conversationId: "-100123",
        messageId: "35676",
      }),
      timestamp: expect.any(Number),
      __openclaw: {
        senderIsOwner: false,
        senderName: "Keśava",
        transport: {
          channel: "telegram",
          conversationRef: expect.stringMatching(/^conv_[a-f0-9]{32}$/),
          messageId: "35676",
        },
      },
    });
    call?.followupRun.userTurnTranscriptRecorder?.markRuntimePersisted({
      role: "user",
      content: "#35676 Keśava: No wtf",
      timestamp: 1_710_000_000_000,
    });
    expect(updateAmbientTranscriptWatermarkMock).toHaveBeenCalledWith({
      storePath: "/tmp/openclaw-session-store.json",
      sessionKey: "session-key",
      key: '["telegram","","-100123",""]',
      messageId: "35676",
      timestampMs: 1_710_000_000_000,
      expectedSessionId: expect.any(String),
    });
    expect(call?.followupRun.currentInboundContext?.text).toContain(
      "#35675 obviyus ->#35674: Are you fr fr",
    );
    expect(call?.followupRun.currentInboundContext?.text).toContain("[OpenClaw room event]");
    expect(call?.followupRun.currentInboundContext?.text).toContain(
      ROOM_EVENT_MESSAGE_TOOL_DIRECTIVE,
    );
    expect(call?.followupRun.currentInboundContext?.text).not.toContain("visible_reply_contract:");
    expect(call?.followupRun.currentInboundContext?.text).not.toContain("Current event:");
  });

  it("queues active room events as followups instead of steering fake prompts", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    const abortController = new AbortController();
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({
      mode: "steer",
      debounceMs: 500,
      cap: 20,
      dropPolicy: "summarize",
    });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
      .mockReturnValueOnce("active-session")
      .mockReturnValueOnce("active-session");
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValueOnce(true);
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunStreaming).mockReturnValueOnce(true);
    vi.mocked(embeddedAgentRuntime.abortEmbeddedAgentRun).mockClear();
    vi.mocked(embeddedAgentRuntime.waitForEmbeddedAgentRunEnd).mockClear();
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce("room context");

    await runPrepared({
      opts: { abortSignal: abortController.signal },
      ctx: {
        ...createInboundTurn("ambient", "telegram", "group"),
      },
      sessionCtx: {
        ...createSessionTurn("ambient", "telegram", "group"),
        InboundEventKind: "room_event",
        MessageSid: "992",
        SenderName: "Alice",
      },
    });

    const call = requireLastRunReplyAgentCall();
    expect(call.shouldSteer).toBe(false);
    expect(call.shouldFollowup).toBe(true);
    expect(call.isActive).toBe(true);
    expect(call.resolvedQueue.mode).toBe("steer");
    expect(call.followupRun.prompt).toBe("#992 Alice: ambient");
    expect(call.followupRun.currentInboundEventKind).toBe("room_event");
    expect(call.followupRun.abortSignal).toBe(abortController.signal);
    expect(call.followupRun.currentInboundContext?.text).toContain("Room context:");
  });

  it("uses queued followup abort ownership instead of borrowed active-lane abort ownership", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    const activeLaneAbortController = new AbortController();
    const sourceAbortController = new AbortController();
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({
      mode: "steer",
      debounceMs: 500,
      cap: 20,
      dropPolicy: "summarize",
    });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
      .mockReturnValueOnce("active-session")
      .mockReturnValueOnce("active-session");
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValueOnce(true);
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunStreaming).mockReturnValueOnce(true);
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce("room context");

    await runPrepared({
      opts: {
        abortSignal: activeLaneAbortController.signal,
        queuedFollowupAbortSignal: sourceAbortController.signal,
      } as NonNullable<Parameters<typeof runPreparedReply>[0]["opts"]> & {
        queuedFollowupAbortSignal?: AbortSignal;
      },
      ctx: {
        ...createInboundTurn("ambient", "telegram", "group"),
      },
      sessionCtx: {
        ...createSessionTurn("ambient", "telegram", "group"),
        InboundEventKind: "room_event",
        MessageSid: "993",
        SenderName: "Alice",
      },
    });

    const call = requireLastRunReplyAgentCall();
    expect(call.shouldFollowup).toBe(true);
    expect(call.isActive).toBe(true);
    expect(call.followupRun.currentInboundEventKind).toBe("room_event");
    expect(call.followupRun.abortSignal).toBe(sourceAbortController.signal);
  });

  it("detaches queued user requests from superseded source abort signals", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    const abortController = new AbortController();
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({
      mode: "collect",
      debounceMs: 500,
      cap: 20,
      dropPolicy: "summarize",
    });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
      .mockReturnValueOnce("active-session")
      .mockReturnValueOnce("active-session");
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValueOnce(true);
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunStreaming).mockReturnValueOnce(true);
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce("user request context");

    await runPrepared({
      opts: { abortSignal: abortController.signal },
      ctx: {
        ...createInboundTurn("@bot keep this", "telegram", "group"),
      },
      sessionCtx: {
        ...createSessionTurn("@bot keep this", "telegram", "group"),
        InboundEventKind: "user_request",
        MessageSid: "994",
        SenderName: "Alice",
      },
    });

    const call = requireLastRunReplyAgentCall();
    expect(call.shouldFollowup).toBe(true);
    expect(call.isActive).toBe(true);
    expect(call.followupRun.currentInboundEventKind).toBe("user_request");
    expect(call.followupRun.abortSignal).toBeUndefined();
  });

  it("queues active room events instead of interrupting active user requests", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({
      mode: "interrupt",
      debounceMs: 500,
      cap: 20,
      dropPolicy: "summarize",
    });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
      .mockReturnValueOnce("active-session")
      .mockReturnValueOnce("active-session");
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValueOnce(true);
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunStreaming).mockReturnValueOnce(true);
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce("room context");

    await runPrepared({
      ctx: {
        ...createInboundTurn("ambient", "telegram", "group"),
      },
      sessionCtx: {
        ...createSessionTurn("ambient", "telegram", "group"),
        InboundEventKind: "room_event",
        MessageSid: "993",
        SenderName: "Alice",
      },
    });

    const call = requireLastRunReplyAgentCall();
    expect(call.shouldSteer).toBe(false);
    expect(call.shouldFollowup).toBe(true);
    expect(call.isActive).toBe(true);
    expect(call.resolvedQueue.mode).toBe("interrupt");
    expect(embeddedAgentRuntime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(embeddedAgentRuntime.waitForEmbeddedAgentRunEnd).not.toHaveBeenCalled();
  });

  it("keeps room events tool-only when group replies are automatic", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce("room context");

    await runPrepared({
      opts: { sourceReplyDeliveryMode: "automatic" },
      ctx: {
        ...createInboundTurn("ambient", "telegram", "group"),
      },
      sessionCtx: {
        ...createSessionTurn("ambient", "telegram", "group"),
        InboundEventKind: "room_event",
        MessageSid: "991",
        SenderName: "Alice",
      },
    });

    const call = requireLastRunReplyAgentCall();
    expect(call?.followupRun.run.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(call?.followupRun.currentInboundContext?.text).toContain(
      ROOM_EVENT_MESSAGE_TOOL_DIRECTIVE,
    );
    expect(call?.followupRun.currentInboundContext?.text).not.toContain("visible_reply_contract:");
  });

  it("keeps webchat room events on automatic source delivery", async () => {
    await runPrepared({
      opts: { sourceReplyDeliveryMode: "automatic" },
      ctx: {
        ...createInboundTurn("webchat prompt", "webchat", "direct"),
      },
      sessionCtx: {
        ...createSessionTurn("webchat prompt", "webchat", "direct"),
        InboundEventKind: "room_event",
        MessageSid: "webchat-room-event",
        SenderName: "Operator",
      },
    });

    const call = requireLastRunReplyAgentCall();
    expect(call?.followupRun.run.sourceReplyDeliveryMode).toBe("automatic");
    expect(call?.followupRun.currentInboundContext?.text).not.toContain(
      "visible_reply_contract: message_tool_only",
    );
  });

  it("keeps routed external room events tool-only when provider is webchat", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce("room context");

    await runPrepared({
      opts: { sourceReplyDeliveryMode: "automatic" },
      ctx: {
        ...createInboundBody("ambient"),
        Provider: "webchat",
        Surface: "telegram",
        ChatType: "group",
      },
      sessionCtx: {
        ...createSessionBody("ambient"),
        Provider: "webchat",
        Surface: "telegram",
        ChatType: "group",
        InboundEventKind: "room_event",
        MessageSid: "routed-room-event",
        SenderName: "Alice",
      },
    });

    const call = requireLastRunReplyAgentCall();
    expect(call?.followupRun.run.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(call?.followupRun.currentInboundContext?.text).toContain(
      ROOM_EVENT_MESSAGE_TOOL_DIRECTIVE,
    );
    expect(call?.followupRun.currentInboundContext?.text).not.toContain("visible_reply_contract:");
  });

  it("keeps webchat direct replies automatic when message-tool mode is requested", async () => {
    await runPrepared({
      opts: { sourceReplyDeliveryMode: "message_tool_only" },
      ctx: {
        ...createInboundTurn("webchat prompt", "webchat", "direct"),
      },
      sessionCtx: {
        ...createSessionTurn("webchat prompt", "webchat", "direct"),
        MessageSid: "webchat-direct",
        SenderName: "Operator",
      },
    });

    const directContextParams = requireMockCallArg(
      vi.mocked(buildDirectChatContext),
      "direct chat context",
      1,
    ) as { sourceReplyDeliveryMode?: string };
    const call = requireLastRunReplyAgentCall();
    expect(directContextParams?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(call?.followupRun.run.sourceReplyDeliveryMode).toBe("message_tool_only");
  });

  it.each(["heartbeat", "cron", "exec"] as const)(
    "keeps %s heartbeat metadata out of the model prompt",
    async (source) => {
      const heartbeatPrompt = "Read HEARTBEAT.md and run any due maintenance.";
      const syntheticConversationInfo =
        'Conversation info:\n```json\n{"chat_id":"discord:channel-123"}\n```';
      vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(syntheticConversationInfo);

      await runPrepared({
        opts: { isHeartbeat: true },
        ctx: {
          Body: heartbeatPrompt,
          RawBody: heartbeatPrompt,
          CommandBody: heartbeatPrompt,
          InternalTurnSource: source,
          ChatType: "direct",
          OriginatingChannel: "discord",
          OriginatingTo: "discord:channel-123",
        },
        sessionCtx: {
          Body: heartbeatPrompt,
          BodyStripped: heartbeatPrompt,
          InternalTurnSource: source,
          ChatType: "direct",
          OriginatingChannel: "discord",
          OriginatingTo: "discord:channel-123",
        },
      });

      const call = requireLastRunReplyAgentCall();
      expect(call?.commandBody).toContain(heartbeatPrompt);
      expect(call?.followupRun.prompt).toContain(heartbeatPrompt);
      expect(call?.followupRun.prompt).not.toContain(syntheticConversationInfo);
      expect(buildInboundUserContextPrefix).not.toHaveBeenCalled();
      expect(call?.sessionCtx).toMatchObject({
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel-123",
      });
      expect(call?.transcriptCommandBody).toBe("[OpenClaw heartbeat poll]");
      expect(call?.followupRun.transcriptPrompt).toBe("[OpenClaw heartbeat poll]");
      expect(call?.followupRun.userTurnTranscriptRecorder?.message).toMatchObject({
        provenance: { kind: "internal_system", sourceTool: "heartbeat" },
      });
    },
  );

  it("keeps active goal context out of background heartbeat turns", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "heartbeat-goal-session",
      updatedAt: 1,
      goal: {
        schemaVersion: 1,
        id: "heartbeat-goal",
        objective: "Finish the interactive task",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
        tokenStart: 0,
        tokensUsed: 0,
        continuationTurns: 0,
      },
    };

    await runPrepared({
      opts: { isHeartbeat: true },
      sessionEntry,
      sessionStore: { "session-key": sessionEntry },
    });

    expect(buildInboundUserContextPrefix).not.toHaveBeenCalled();
  });

  it("uses persisted Discord chat metadata for system-event CLI static prompt identity", async () => {
    vi.mocked(buildGroupChatContext).mockImplementation(({ sessionCtx }) =>
      [`group`, sessionCtx.Provider, sessionCtx.ChatType, sessionCtx.GroupChannel].join(":"),
    );

    await runPrepared({
      opts: { isHeartbeat: true },
      isNewSession: false,
      systemSent: true,
      ctx: {
        ...createInboundBody("scheduled wake"),
        InternalTurnSource: "cron",
        SessionKey: "agent:main:discord:guild-1:channel-1",
      },
      sessionCtx: {
        ...createSessionBody("scheduled wake"),
        InternalTurnSource: "cron",
      },
      sessionEntry: {
        sessionId: "session-1",
        updatedAt: 1,
        systemSent: true,
        chatType: "channel",
        groupId: "guild-1",
        groupChannel: "#ops",
        delivery: normalizeSessionDeliveryState({
          context: { channel: "discord", to: "channel-1" },
          origin: {
            provider: "discord",
            surface: "discord",
            chatType: "channel",
            to: "channel-1",
          },
        }),
      },
    });

    const call = requireLastRunReplyAgentCall();
    expect(buildGroupChatContext).toHaveBeenCalledTimes(2);
    const groupContextParams = requireMockCallArg(
      vi.mocked(buildGroupChatContext),
      "group chat context",
    ) as {
      sessionCtx?: {
        Provider?: string;
        Surface?: string;
        ChatType?: string;
        GroupChannel?: string;
      };
    };
    expect(groupContextParams?.sessionCtx?.Provider).toBe("discord");
    expect(groupContextParams?.sessionCtx?.Surface).toBe("discord");
    expect(groupContextParams?.sessionCtx?.ChatType).toBe("channel");
    expect(groupContextParams?.sessionCtx?.GroupChannel).toBe("#ops");
    expect(call?.followupRun.run.chatType).toBe("channel");
    expect(call?.followupRun.run.extraSystemPromptStatic).toBe("group:discord:channel:#ops");
    expect(call?.followupRun.originatingChannel).toBe("discord");
    expect(call?.followupRun.originatingTo).toBe("channel-1");
  });

  it.each([
    {
      name: "automatic config",
      stableMode: "automatic",
      expectedPrompt: "group:telegram:group:automatic",
    },
    {
      name: "message-tool config",
      stableMode: "message_tool_only",
      expectedPrompt: "group:telegram:group:message_tool_only",
    },
  ] as const)(
    "keeps CLI binding facts stable across room-event, primary, and heartbeat assembly for $name",
    async ({ stableMode, expectedPrompt }) => {
      vi.mocked(buildGroupChatContext).mockImplementation(
        ({ sessionCtx, sourceReplyDeliveryMode }) =>
          [
            "group",
            sessionCtx.Provider,
            sessionCtx.ChatType,
            sourceReplyDeliveryMode ?? "automatic",
          ].join(":"),
      );
      // The direct-caller heartbeat run below resolves the stable mode from
      // config instead of injected opts; keep both sources agreeing per case.
      const caseCfg = {
        session: {},
        channels: {},
        agents: { defaults: {} },
        ...(stableMode === "message_tool_only"
          ? { messages: { visibleReplies: "message_tool" as const } }
          : {}),
      };
      const sessionEntry: SessionEntry = {
        sessionId: "session-telegram-group",
        updatedAt: 1,
        systemSent: true,
        chatType: "group",
        delivery: normalizeSessionDeliveryState({
          context: { channel: "telegram", to: "-100123" },
          origin: {
            provider: "telegram",
            surface: "telegram",
            chatType: "group",
            to: "-100123",
          },
        }),
      };

      await runPrepared({
        cfg: caseCfg,
        opts: {
          sourceReplyDeliveryMode: "message_tool_only",
          sessionPromptSourceReplyDeliveryMode: stableMode,
        },
        isNewSession: false,
        systemSent: true,
        sessionEntry,
        ctx: {
          ...createInboundTurn("@bot check this", "telegram", "group"),
          MessageSid: "msg-1",
        },
        sessionCtx: {
          ...createSessionTurn("@bot check this", "telegram", "group"),
          InboundEventKind: "room_event",
          MessageSid: "msg-1",
        },
      });
      await runPrepared({
        cfg: caseCfg,
        opts: {
          sourceReplyDeliveryMode: stableMode,
          sessionPromptSourceReplyDeliveryMode: stableMode,
        },
        isNewSession: false,
        systemSent: true,
        sessionEntry,
        ctx: {
          ...createInboundTurn("@bot check this", "telegram", "group"),
          MessageSid: "msg-2",
        },
        sessionCtx: {
          ...createSessionTurn("@bot check this", "telegram", "group"),
          MessageSid: "msg-2",
        },
      });
      await runPrepared({
        cfg: caseCfg,
        opts: {
          isHeartbeat: true,
          sourceReplyDeliveryMode: stableMode,
          sessionPromptSourceReplyDeliveryMode: stableMode,
        },
        isNewSession: false,
        systemSent: true,
        sessionEntry,
        ctx: {
          ...createInboundBody("scheduled wake"),
          InternalTurnSource: "cron",
          SessionKey: "agent:main:telegram:-100123",
        },
        sessionCtx: {
          ...createSessionBody("scheduled wake"),
          InternalTurnSource: "cron",
        },
      });
      // Production heartbeat wakes call the reply resolver directly, without
      // dispatch's injected delivery modes; their binding facts must still
      // match dispatched turns or the CLI session ping-pongs (#121485).
      await runPrepared({
        cfg: caseCfg,
        opts: { isHeartbeat: true },
        isNewSession: false,
        systemSent: true,
        sessionEntry,
        ctx: {
          ...createInboundBody("scheduled wake"),
          InternalTurnSource: "heartbeat",
          SessionKey: "agent:main:telegram:-100123",
        },
        sessionCtx: {
          ...createSessionBody("scheduled wake"),
          InternalTurnSource: "heartbeat",
        },
      });
      // Response-tool heartbeats carry an effective message_tool_only turn
      // mode; that is per-turn enforcement and must not become the session
      // policy fact, or these heartbeats keep ping-ponging the binding.
      await runPrepared({
        cfg: caseCfg,
        opts: { isHeartbeat: true, sourceReplyDeliveryMode: "message_tool_only" },
        isNewSession: false,
        systemSent: true,
        sessionEntry,
        ctx: {
          ...createInboundBody("scheduled wake"),
          InternalTurnSource: "heartbeat",
          SessionKey: "agent:main:telegram:-100123",
        },
        sessionCtx: {
          ...createSessionBody("scheduled wake"),
          InternalTurnSource: "heartbeat",
        },
      });

      const roomEventRun = requireRunReplyAgentCall(0).followupRun.run;
      const primaryRun = requireRunReplyAgentCall(1).followupRun.run;
      const heartbeatRun = requireRunReplyAgentCall(2).followupRun.run;
      const directHeartbeatRun = requireRunReplyAgentCall(3).followupRun.run;
      const responseToolHeartbeatRun = requireRunReplyAgentCall(4).followupRun.run;
      expect(roomEventRun.sourceReplyDeliveryMode).toBe("message_tool_only");
      expect(primaryRun.sourceReplyDeliveryMode).toBe(stableMode);
      expect(heartbeatRun.sourceReplyDeliveryMode).toBe(stableMode);
      expect(roomEventRun.extraSystemPrompt).toBe(expectedPrompt);
      expect(requireRunReplyAgentCall(0).followupRun.currentInboundContext?.text).toContain(
        "You were not explicitly tagged or mentioned in this room event",
      );
      expect(roomEventRun.extraSystemPromptStatic).toBe(expectedPrompt);
      expect(roomEventRun.extraSystemPromptStatic).not.toContain(
        "You were not explicitly tagged or mentioned in this room event",
      );
      expect(primaryRun.extraSystemPromptStatic).toBe(roomEventRun.extraSystemPromptStatic);
      expect(heartbeatRun.extraSystemPromptStatic).toBe(roomEventRun.extraSystemPromptStatic);
      expect(roomEventRun.cliSessionBindingFacts).toEqual({
        extraSystemPromptStatic: expectedPrompt,
        sourceReplyDeliveryMode: stableMode,
      });
      expect(primaryRun.cliSessionBindingFacts).toEqual(roomEventRun.cliSessionBindingFacts);
      expect(heartbeatRun.cliSessionBindingFacts).toEqual(roomEventRun.cliSessionBindingFacts);
      expect(directHeartbeatRun.cliSessionBindingFacts).toEqual(
        roomEventRun.cliSessionBindingFacts,
      );
      expect(responseToolHeartbeatRun.sourceReplyDeliveryMode).toBe("message_tool_only");
      expect(responseToolHeartbeatRun.cliSessionBindingFacts).toEqual(
        roomEventRun.cliSessionBindingFacts,
      );
    },
  );

  it("resolves origin-less sessions as internal for synthetic stable facts", async () => {
    vi.mocked(buildDirectChatContext).mockReturnValue("direct-context");
    selectAgentHarnessMock.mockClear();
    // An entry with no persisted delivery origin has only ever been driven
    // internally; its wake source must not leak into the
    // stable context as a non-internal surface or the fact diverges from
    // dispatch's live webchat turns.
    const sessionEntry: SessionEntry = {
      sessionId: "session-internal",
      updatedAt: 1,
      systemSent: true,
      chatType: "direct",
    };

    await runPrepared({
      cfg: { session: {}, channels: {}, agents: { defaults: {} } },
      opts: { isHeartbeat: true },
      isNewSession: false,
      systemSent: true,
      sessionEntry,
      ctx: {
        ...createInboundBody("scheduled wake"),
        InternalTurnSource: "heartbeat",
        SessionKey: "agent:main:main",
      },
      sessionCtx: {
        ...createSessionBody("scheduled wake"),
        InternalTurnSource: "heartbeat",
        ChatType: "direct",
      },
    });

    const run = requireRunReplyAgentCall(0).followupRun.run;
    expect(run.cliSessionBindingFacts?.sourceReplyDeliveryMode).toBe("automatic");
    expect(
      selectAgentHarnessMock.mock.calls.map(([params]) => ({
        provider: params.provider,
        modelId: params.modelId,
      })),
    ).toEqual([{ provider: "anthropic", modelId: "claude-opus-4-1" }]);
  });

  it("downgrades the synthetic stable mode when the message tool is policy-denied", async () => {
    vi.mocked(buildGroupChatContext).mockImplementation(({ sourceReplyDeliveryMode }) =>
      ["group", sourceReplyDeliveryMode ?? "automatic"].join(":"),
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session-telegram-group",
      updatedAt: 1,
      systemSent: true,
      chatType: "group",
      delivery: normalizeSessionDeliveryState({
        context: { channel: "telegram", to: "-100123" },
        origin: {
          provider: "telegram",
          surface: "telegram",
          chatType: "group",
          to: "-100123",
        },
      }),
    };

    // Tool-only delivery configured, but the message tool is denied: dispatch
    // downgrades its stable mode to automatic, so the synthetic fallback must
    // record automatic too or the binding hashes diverge again.
    await runPrepared({
      cfg: {
        session: {},
        channels: {},
        agents: { defaults: {} },
        messages: { visibleReplies: "message_tool" as const },
        tools: { deny: ["message"] },
      },
      opts: { isHeartbeat: true },
      isNewSession: false,
      systemSent: true,
      sessionEntry,
      ctx: {
        ...createInboundBody("scheduled wake"),
        InternalTurnSource: "heartbeat",
        SessionKey: "agent:main:telegram:-100123",
      },
      sessionCtx: {
        ...createSessionBody("scheduled wake"),
        InternalTurnSource: "heartbeat",
      },
    });

    const run = requireRunReplyAgentCall(0).followupRun.run;
    expect(run.cliSessionBindingFacts?.sourceReplyDeliveryMode).toBe("automatic");
  });

  it("keeps per-message room-event metadata out of CLI binding facts", async () => {
    vi.mocked(buildGroupChatContext).mockImplementation(({ sessionCtx, sourceReplyDeliveryMode }) =>
      [
        "group",
        sessionCtx.Provider,
        sessionCtx.ChatType,
        sourceReplyDeliveryMode ?? "automatic",
      ].join(":"),
    );
    const baseRoomEvent = {
      opts: {
        sourceReplyDeliveryMode: "message_tool_only" as const,
        sessionPromptSourceReplyDeliveryMode: "automatic" as const,
      },
      isNewSession: false,
      systemSent: true,
      ctx: {
        ...createInboundTurn("@bot check this", "telegram", "group"),
      },
      sessionCtx: {
        ...createSessionTurn("@bot check this", "telegram", "group"),
        InboundEventKind: "room_event" as const,
      },
    };

    await runPrepared({
      ...baseRoomEvent,
      ctx: { ...baseRoomEvent.ctx, MessageSid: "msg-1", Timestamp: 1_710_000_000_000 },
      sessionCtx: { ...baseRoomEvent.sessionCtx, MessageSid: "msg-1" },
    });
    await runPrepared({
      ...baseRoomEvent,
      ctx: { ...baseRoomEvent.ctx, MessageSid: "msg-2", Timestamp: 1_710_000_005_000 },
      sessionCtx: { ...baseRoomEvent.sessionCtx, MessageSid: "msg-2" },
    });

    const firstRun = requireRunReplyAgentCall(0).followupRun.run;
    const secondRun = requireRunReplyAgentCall(1).followupRun.run;
    expect(firstRun.cliSessionBindingFacts).toEqual({
      extraSystemPromptStatic: "group:telegram:group:automatic",
      sourceReplyDeliveryMode: "automatic",
    });
    expect(secondRun.cliSessionBindingFacts).toEqual(firstRun.cliSessionBindingFacts);
  });

  it("keeps explicit mention state in user context and out of CLI binding facts", async () => {
    vi.mocked(buildGroupChatContext).mockReturnValue("group:telegram:group:automatic");

    await runPrepared({
      opts: {
        sourceReplyDeliveryMode: "automatic",
        sessionPromptSourceReplyDeliveryMode: "automatic",
      },
      isNewSession: false,
      systemSent: true,
      ctx: {
        ...createInboundTurn("@SirPinchALotBot check this", "telegram", "group"),
        BotUsername: "SirPinchALotBot",
        ExplicitlyMentionedBot: true,
      },
      sessionCtx: {
        ...createSessionTurn("@SirPinchALotBot check this", "telegram", "group"),
        BotUsername: "SirPinchALotBot",
        ExplicitlyMentionedBot: true,
      },
    });

    const run = requireRunReplyAgentCall(0).followupRun.run;
    const inboundCtx = requireMockCallArg(
      vi.mocked(buildInboundUserContextPrefix),
      "inbound user context",
    ) as { ExplicitlyMentionedBot?: boolean; BotUsername?: string };
    expect(inboundCtx.ExplicitlyMentionedBot).toBe(true);
    expect(inboundCtx.BotUsername).toBe("SirPinchALotBot");
    expect(run.extraSystemPromptStatic).toBe("group:telegram:group:automatic");
    expect(run.cliSessionBindingFacts).toEqual({
      extraSystemPromptStatic: "group:telegram:group:automatic",
      sourceReplyDeliveryMode: "automatic",
    });
  });

  it("keeps group intro in the session-stable CLI prompt after turn one", async () => {
    vi.mocked(buildGroupChatContext).mockReturnValue("group:telegram:group:automatic");
    vi.mocked(buildGroupIntro).mockReturnValue("intro:mention");
    const sessionEntry: SessionEntry = {
      sessionId: "session-telegram-group",
      updatedAt: 1,
      systemSent: true,
      chatType: "group",
      delivery: normalizeSessionDeliveryState({
        context: { channel: "telegram", to: "-100123" },
        origin: {
          provider: "telegram",
          surface: "telegram",
          chatType: "group",
          to: "-100123",
        },
      }),
    };

    await runPrepared({
      opts: {
        sourceReplyDeliveryMode: "automatic",
        sessionPromptSourceReplyDeliveryMode: "automatic",
      },
      isNewSession: true,
      systemSent: false,
      sessionEntry,
      ctx: {
        ...createInboundTurn("@bot first", "telegram", "group"),
      },
      sessionCtx: {
        ...createSessionTurn("@bot first", "telegram", "group"),
      },
    });
    await runPrepared({
      opts: {
        sourceReplyDeliveryMode: "automatic",
        sessionPromptSourceReplyDeliveryMode: "automatic",
      },
      isNewSession: false,
      systemSent: true,
      sessionEntry,
      ctx: {
        ...createInboundTurn("second", "telegram", "group"),
      },
      sessionCtx: {
        ...createSessionTurn("second", "telegram", "group"),
      },
    });

    const firstRun = requireRunReplyAgentCall(0).followupRun.run;
    const secondRun = requireRunReplyAgentCall(1).followupRun.run;
    expect(firstRun.extraSystemPromptStatic).toBe(
      "group:telegram:group:automatic\n\nintro:mention",
    );
    expect(secondRun.extraSystemPromptStatic).toBe(firstRun.extraSystemPromptStatic);
    expect(secondRun.cliSessionBindingFacts).toEqual(firstRun.cliSessionBindingFacts);
  });

  it.each([
    ["/new", "new"],
    ["/reset", "reset"],
  ] as const)(
    "keeps inbound sender context in reply-targeted bare %s model prompt while hiding startup instructions from transcript prompt",
    async (commandText, startupAction) => {
      vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
        ["Conversation info:", "Sender:", "sender_id", "telegram-user-1"].join("\n"),
      );

      await runPrepared({
        ctx: {
          Body: commandText,
          RawBody: commandText,
          CommandBody: commandText,
          ...createProviderSurface("webchat"),
          ChatType: "direct",
          ReplyToBody: "quoted reset target",
          ReplyToSender: "Ada Lovelace",
        },
        sessionCtx: {
          ...createSessionTurn("", "webchat", "direct"),
          SenderId: "telegram-user-1",
          SenderName: "Ada Lovelace",
          ReplyToBody: "quoted reset target",
          ReplyToSender: "Ada Lovelace",
        },
        command: {
          surface: "webchat",
          channel: "webchat",
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: true,
          rawBodyNormalized: commandText,
          commandBodyNormalized: commandText,
        } as never,
      });

      const call = requireLastRunReplyAgentCall();
      expect(call?.commandBody).toContain("A new session was started via /new or /reset.");
      expect(call?.commandBody).toContain("Conversation info:");
      expect(call?.commandBody).toContain("Sender:");
      expect(call?.commandBody).toContain("telegram-user-1");
      expect(call?.followupRun.prompt).toContain("A new session was started via /new or /reset.");
      expect(call?.followupRun.prompt).toContain("Sender:");
      expect(call?.transcriptCommandBody).toBe(`[OpenClaw session ${startupAction}]`);
      expect(call?.followupRun.transcriptPrompt).toBe(`[OpenClaw session ${startupAction}]`);
      expect(call?.followupRun.transcriptPrompt).not.toContain("Sender:");
    },
  );

  it("keeps reset user notes visible while hiding startup instructions", async () => {
    await runPrepared({
      ctx: {
        ...createInboundTurn("/reset summarize my workspace", "webchat", "direct"),
      },
      sessionCtx: {
        ...createSessionTurn("", "webchat", "direct"),
      },
      command: {
        surface: "webchat",
        channel: "webchat",
        isAuthorizedSender: true,
        abortKey: "session-key",
        ownerList: [],
        senderIsOwner: true,
        rawBodyNormalized: "/reset summarize my workspace",
        commandBodyNormalized: "/reset summarize my workspace",
        softResetTriggered: true,
        softResetTail: "summarize my workspace",
      } as never,
    });

    const call = requireLastRunReplyAgentCall();
    expect(call?.commandBody).toContain("A new session was started via /new or /reset.");
    expect(call?.commandBody).toContain("summarize my workspace");
    expect(call?.transcriptCommandBody).toBe("summarize my workspace");
    expect(call?.followupRun.transcriptPrompt).toBe("summarize my workspace");
  });

  it("uses inbound origin channel for run messageProvider", async () => {
    await runPrepared({
      ctx: {
        ...createInboundBody(""),
        ThreadHistoryBody: "Earlier message in this thread",
        OriginatingChannel: "webchat",
        OriginatingTo: "session:abc",
        ChatType: "group",
      },
      sessionCtx: {
        ...createSessionBody(""),
        ThreadHistoryBody: "Earlier message in this thread",
        media: [{ path: "/tmp/input.png" }],
        Provider: "telegram",
        ChatType: "group",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:123",
      },
    });

    const call = requireRunReplyAgentCall();
    expect(call?.followupRun.run.messageProvider).toBe("webchat");
    expect(call?.followupRun.userTurnTranscriptRecorder?.message).toMatchObject({
      __openclaw: {
        transport: {
          channel: "telegram",
          conversationRef: expect.stringMatching(/^conv_[a-f0-9]{32}$/u),
        },
      },
    });
  });

  it("prefers Provider over Surface when origin channel is missing", async () => {
    await runPrepared({
      ctx: {
        ...createInboundBody(""),
        ThreadHistoryBody: "Earlier message in this thread",
        OriginatingChannel: undefined,
        OriginatingTo: undefined,
        Provider: "feishu",
        Surface: "webchat",
        ChatType: "group",
      },
      sessionCtx: {
        ...createSessionBody(""),
        ThreadHistoryBody: "Earlier message in this thread",
        media: [{ path: "/tmp/input.png" }],
        Provider: "webchat",
        ChatType: "group",
        OriginatingChannel: undefined,
        OriginatingTo: undefined,
      },
    });

    const call = requireRunReplyAgentCall();
    expect(call?.followupRun.run.messageProvider).toBe("feishu");
  });

  it("uses the effective session account for followup originatingAccountId when AccountId is omitted", async () => {
    await runPrepared({
      ctx: {
        ...createInboundBody(""),
        ThreadHistoryBody: "Earlier message in this thread",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:24680",
        ChatType: "group",
        AccountId: undefined,
      },
      sessionCtx: {
        ...createSessionBody(""),
        ThreadHistoryBody: "Earlier message in this thread",
        media: [{ path: "/tmp/input.png" }],
        Provider: "discord",
        ChatType: "group",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:24680",
        ReplyToId: "reply-24680",
        AccountId: "work",
      },
    });

    const call = requireRunReplyAgentCall();
    expect(call?.followupRun.originatingAccountId).toBe("work");
    expect(call?.followupRun.originatingReplyToId).toBe("reply-24680");
  });

  it("captures the prepared reply policy for queued Slack runs", async () => {
    await runPrepared({
      cfg: {
        session: {},
        channels: { slack: { replyToMode: "all" } },
        agents: { defaults: {} },
      },
      ctx: {
        ...createInboundBody(""),
        ThreadHistoryBody: "Earlier message in this thread",
        Provider: "slack",
        OriginatingChannel: undefined,
        OriginatingTo: "C123",
        ChatType: "group",
        ReplyToMode: "off",
      },
      sessionCtx: {
        ...createSessionBody(""),
        ThreadHistoryBody: "Earlier message in this thread",
        media: [{ path: "/tmp/input.png" }],
        Provider: "slack",
        ChatType: "group",
        OriginatingChannel: "slack",
        OriginatingTo: "C123",
        ReplyToId: "101.001",
        ReplyToMode: "off",
      },
    });

    const call = requireRunReplyAgentCall();
    expect(call?.followupRun.originatingReplyToId).toBe("101.001");
    expect(call?.followupRun.originatingReplyToMode).toBe("off");
  });

  it("captures queued reply policy from hydrated system-event session context", async () => {
    await runPrepared({
      cfg: {
        session: {},
        channels: {
          slack: {
            replyToMode: "all",
            replyToModeByChatType: { direct: "off" },
          },
        },
        agents: { defaults: {} },
      },
      opts: { isHeartbeat: true },
      ctx: {
        ...createInboundBody("scheduled wake"),
        InternalTurnSource: "cron",
        SessionKey: "agent:main:slack:direct:U1",
        OriginatingChannel: "slack",
        OriginatingTo: "user:U1",
      },
      sessionCtx: {
        ...createSessionBody("scheduled wake"),
        InternalTurnSource: "cron",
        OriginatingChannel: "slack",
        OriginatingTo: "user:U1",
      },
      sessionEntry: {
        sessionId: "session-1",
        updatedAt: 1,
        chatType: "direct",
        delivery: normalizeSessionDeliveryState({
          context: {
            channel: "slack",
            to: "user:U1",
            accountId: "work",
          },
          origin: {
            provider: "matrix",
            surface: "matrix",
            chatType: "direct",
            to: "room:origin",
            accountId: "origin",
          },
        }),
      },
    });

    const call = requireRunReplyAgentCall();
    expect(call?.followupRun.originatingChannel).toBe("slack");
    expect(call?.followupRun.originatingTo).toBe("user:U1");
    expect(call?.followupRun.originatingAccountId).toBe("work");
    expect(call?.followupRun.originatingChatType).toBe("direct");
    expect(call?.followupRun.originatingReplyToMode).toBe("off");
    expect(call?.followupRun.run.messageProvider).toBe("slack");
    expect(call?.followupRun.run.agentAccountId).toBe("work");
    expect(call?.followupRun.run.chatType).toBe("direct");
  });

  it("uses transport thread metadata for followup originatingThreadId", async () => {
    await runPrepared({
      ctx: {
        ...createInboundBody(""),
        ThreadHistoryBody: "Earlier message in this thread",
        OriginatingChannel: "slack",
        OriginatingTo: "user:U1",
        ChatType: "direct",
        MessageThreadId: undefined,
        TransportThreadId: "650.000",
      },
      sessionCtx: {
        ...createSessionBody(""),
        ThreadHistoryBody: "Earlier message in this thread",
        media: [{ path: "/tmp/input.png" }],
        Provider: "slack",
        ChatType: "direct",
        OriginatingChannel: "slack",
        OriginatingTo: "user:U1",
        TransportThreadId: "650.000",
      },
    });

    const call = requireRunReplyAgentCall();
    expect(call?.followupRun.originatingThreadId).toBe("650.000");
  });

  it("passes suppressTyping through typing mode resolution", async () => {
    await runPrepared({
      opts: {
        suppressTyping: true,
      },
    });

    const call = requireMockCallArg(vi.mocked(resolveTypingMode), "typing mode params") as {
      suppressTyping?: boolean;
    };
    expect(call?.suppressTyping).toBe(true);
  });

  it("routes queued system events into user prompt text, not system prompt context", async () => {
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce("System: [t] Model switched.");

    await runPrepared();

    const call = requireRunReplyAgentCall();
    expect(call.commandBody).toContain("System: [t] Model switched.");
    expect(call.followupRun.run.extraSystemPrompt ?? "").not.toContain("Runtime System Events");
  });

  it("includes route system events in a thread-scoped turn", async () => {
    const actualSystemEvents = await vi.importActual<typeof import("./session-system-events.js")>(
      "./session-system-events.js",
    );
    vi.mocked(drainFormattedSystemEvents).mockImplementation(
      actualSystemEvents.drainFormattedSystemEvents,
    );
    enqueueSystemEvent("Slack reaction added: :eyes:", {
      sessionKey: "agent:main:slack:channel:c123",
    });
    enqueueSystemEvent("Slack message in #claw-test from Alice", {
      sessionKey: "agent:main:slack:channel:c123:thread:123.456",
    });

    await runPrepared({
      agentId: "main",
      ctx: createInboundBody("report queued reactions"),
      opts: withReplySystemEventSessionKey({}, "agent:main:slack:channel:c123"),
      provider: "",
      model: "",
      resolvedThinkLevel: "off",
      sessionKey: "agent:main:slack:channel:c123:thread:123.456",
    });

    const prompt = requireRunReplyAgentCall().followupRun.prompt;
    expect(prompt).toContain("Slack reaction added: :eyes:");
    expect(prompt).toContain("Slack message in #claw-test from Alice");
    expect(peekSystemEventEntries("agent:main:slack:channel:c123")).toStrictEqual([]);
    expect(peekSystemEventEntries("agent:main:slack:channel:c123:thread:123.456")).toStrictEqual(
      [],
    );
  });

  it("keeps sender ownership when queued system events are prepended", async () => {
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce(
      "System: [t] External webhook payload.",
    );
    const params = ownerParams();

    await runPreparedReply(params);

    const call = requireRunReplyAgentCall();
    expect(call?.followupRun.run.senderIsOwner).toBe(true);
    expect(call?.followupRun.userTurnTranscriptRecorder?.message).toMatchObject({
      __openclaw: { senderIsOwner: true },
    });
  });

  it("keeps the canonical current owner in bounded reply-run prompt guidance", async () => {
    const ownerIds = Array.from({ length: 24 }, (_, index) =>
      String(100_000_000_000_000_000n + BigInt(index)),
    );
    const currentOwnerId = ownerIds.at(-1)!;
    const params = ownerParams();
    params.command = {
      ...params.command,
      ownerList: ownerIds,
      senderId: currentOwnerId,
      senderIsOwner: true,
    };
    params.sessionCtx = {
      ...params.sessionCtx,
      SenderId: `<@!${currentOwnerId}>`,
    };

    await runPreparedReply(params);

    const run = requireRunReplyAgentCall().followupRun.run;
    expect(run.senderId).toBe(`<@!${currentOwnerId}>`);
    expect(run.ownerNumbers).toHaveLength(16);
    expect(run.ownerNumbers?.at(-1)).toBe(currentOwnerId);
    expect(params.command.ownerList).toHaveLength(24);
  });

  it("preserves first-token think hint when system events are prepended", async () => {
    // drainFormattedSystemEvents returns the events block; the caller prepends it.
    // The hint must be extracted from the user body BEFORE prepending, so "System:"
    // does not shadow the low|medium|high shorthand.
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce("System: [t] Node connected.");

    const code = "Run  this:\r\n    if True:\r\n        print('a  b')";
    await runPrepared({
      ctx: createInboundBody(`low ${code}`),
      sessionCtx: createSessionBody(`low ${code}`),
      resolvedThinkLevel: undefined,
    });

    const call = requireRunReplyAgentCall();
    // Think hint extracted before events arrived — level must be "low", not the model default.
    expect(call.followupRun.run.thinkLevel).toBe("low");
    // The stripped user text (no "low" token) must still appear after the event block.
    expect(call.commandBody).toBe(`System: [t] Node connected.\n\n${code}`);
    expect(call.commandBody).not.toMatch(/^low\b/);
    // System events are still present in the body.
    expect(call.commandBody).toContain("System: [t] Node connected.");
  });

  it("forwards resolved fast-mode override into the followup run", async () => {
    await runPrepared({
      resolvedFastMode: "auto",
    });

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.run.fastMode).toBe("auto");
  });

  it("keeps an operator-reviewed proposal revision isolated on the queued run", async () => {
    const proposalRevision = {
      agentId: "main",
      workspaceDir: "/tmp/workspace",
      proposalId: "proposal-h1",
      expectedRevisionHash: "revision-h1",
    };
    await runPrepared({
      opts: { skillWorkshopProposalRevision: proposalRevision } as never,
    });

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.run.skillWorkshopProposalRevision).toEqual(proposalRevision);
    expect(call.followupRun.run.skillWorkshopProposalRevision).not.toBe(proposalRevision);
  });

  it("carries system events into followupRun.prompt for deferred turns", async () => {
    // drainFormattedSystemEvents returns the events block; the caller prepends it to
    // effectiveBaseBody for the queue path so deferred turns see events.
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce("System: [t] Node connected.");

    await runPrepared();

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.prompt).toContain("System: [t] Node connected.");
  });

  it("admits only system events visible to the prepared agent", async () => {
    const actualSystemEvents = await vi.importActual<typeof import("./session-system-events.js")>(
      "./session-system-events.js",
    );
    vi.mocked(drainFormattedSystemEvents).mockImplementationOnce(
      actualSystemEvents.drainFormattedSystemEvents,
    );
    enqueueSystemEvent(
      "Alpha hook finished",
      withSystemEventOwner({ sessionKey: "global" }, "alpha"),
    );
    enqueueSystemEvent(
      "Beta hook finished",
      withSystemEventOwner({ sessionKey: "global" }, "beta"),
    );
    enqueueSystemEvent("Legacy unowned event", { sessionKey: "global" });

    await runPreparedReply(
      baseParams({
        agentId: "alpha",
        sessionKey: "global",
        opts: { isHeartbeat: true },
      }),
    );

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.prompt).toContain("Alpha hook finished");
    expect(call.followupRun.prompt).toContain("Legacy unowned event");
    expect(call.followupRun.prompt).not.toContain("Beta hook finished");
    expect(peekSystemEventEntries("global").map((event) => event.text)).toEqual([
      "Beta hook finished",
    ]);
  });

  it("does not strip think-hint token from deferred queue body", async () => {
    // In steer mode the inferred thinkLevel is never consumed, so the first token
    // must not be stripped from the queue/steer body (followupRun.prompt).
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce(undefined);

    await runPrepared({
      ctx: { Body: "low steer this conversation", RawBody: "low steer this conversation" },
      sessionCtx: {
        ...createSessionBody("low steer this conversation"),
      },
      resolvedThinkLevel: undefined,
    });

    const call = requireRunReplyAgentCall();
    // Queue body (used by steer mode) must keep the full original text.
    expect(call.followupRun.prompt).toContain("low steer this conversation");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

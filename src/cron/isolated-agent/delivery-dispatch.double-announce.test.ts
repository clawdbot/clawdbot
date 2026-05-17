/**
 * Tests for the double-announce bug in cron delivery dispatch.
 *
 * Bug: early return paths in text finalization (active subagent suppression
 * and stale interim message suppression) returned without setting
 * deliveryAttempted = true. The timer saw deliveryAttempted = false and
 * fired enqueueSystemEvent as a fallback, causing a second delivery.
 *
 * Fix: both early return paths now set deliveryAttempted = true before
 * returning so the timer correctly skips the system-event fallback.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";

// --- Module mocks (must be hoisted before imports) ---

const {
  appendAssistantMessageToSessionTranscriptMock,
  countActiveDescendantRunsMock,
  deliverOutboundPayloadsMock,
  ensureOutboundSessionEntryMock,
  maybeApplyTtsToPayloadMock,
  retireSessionMcpRuntimeMock,
  resolveOutboundSessionRouteMock,
} = vi.hoisted(() => ({
  appendAssistantMessageToSessionTranscriptMock: vi.fn().mockResolvedValue({
    ok: true,
    sessionFile: "session.jsonl",
    messageId: "mirror-message",
  }),
  countActiveDescendantRunsMock: vi.fn().mockReturnValue(0),
  deliverOutboundPayloadsMock: vi.fn().mockResolvedValue([{ ok: true }]),
  ensureOutboundSessionEntryMock: vi.fn().mockResolvedValue(undefined),
  maybeApplyTtsToPayloadMock: vi.fn(async (params: { payload: unknown }) => params.payload),
  retireSessionMcpRuntimeMock: vi.fn().mockResolvedValue(true),
  resolveOutboundSessionRouteMock: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../config/sessions/main-session.js", () => ({
  canonicalizeMainSessionAlias: vi.fn(
    ({
      cfg,
      agentId,
      sessionKey,
    }: {
      cfg?: { session?: { mainKey?: string; scope?: string } };
      agentId: string;
      sessionKey: string;
    }) => {
      const mainKey = cfg?.session?.mainKey?.trim().toLowerCase() || "main";
      const normalizedAgentId = agentId.trim().toLowerCase() || "main";
      const raw = sessionKey.trim();
      const aliases = new Set([
        "main",
        mainKey,
        `agent:${normalizedAgentId}:main`,
        `agent:${normalizedAgentId}:${mainKey}`,
        `agent:main:main`,
        `agent:main:${mainKey}`,
      ]);
      if (!aliases.has(raw)) {
        return sessionKey;
      }
      return cfg?.session?.scope === "global" ? "global" : `agent:${normalizedAgentId}:${mainKey}`;
    },
  ),
  resolveAgentMainSessionKey: vi.fn(
    ({ cfg, agentId }: { cfg?: { session?: { mainKey?: string } }; agentId: string }) =>
      `agent:${agentId}:${cfg?.session?.mainKey ?? "main"}`,
  ),
  resolveMainSessionKey: vi.fn(() => "global"),
}));

vi.mock("../../agents/subagent-registry-read.js", () => ({
  countActiveDescendantRuns: countActiveDescendantRunsMock,
}));

vi.mock("../../agents/pi-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntime: retireSessionMcpRuntimeMock,
}));

vi.mock("./delivery-subagent-registry.runtime.js", () => ({
  countActiveDescendantRuns: countActiveDescendantRunsMock,
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliverOutboundPayloadsMock,
  deliverOutboundPayloadsInternal: deliverOutboundPayloadsMock,
}));

vi.mock("../../infra/outbound/identity.js", () => ({
  resolveAgentOutboundIdentity: vi.fn().mockReturnValue({}),
}));

vi.mock("../../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: vi.fn().mockReturnValue({}),
}));

vi.mock("../../infra/outbound/outbound-session.js", () => ({
  ensureOutboundSessionEntry: ensureOutboundSessionEntryMock,
  resolveOutboundSessionRoute: resolveOutboundSessionRouteMock,
}));

vi.mock("../../config/sessions/transcript.runtime.js", () => ({
  appendAssistantMessageToSessionTranscript: appendAssistantMessageToSessionTranscriptMock,
}));

vi.mock("../../cli/outbound-send-deps.js", () => ({
  createOutboundSendDeps: vi.fn().mockReturnValue({}),
}));

vi.mock("../../gateway/call.runtime.js", () => ({
  callGateway: vi.fn().mockResolvedValue({ status: "ok" }),
}));

vi.mock("../../logger.js", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: maybeApplyTtsToPayloadMock,
}));

vi.mock("./subagent-followup-hints.js", () => ({
  expectsSubagentFollowup: vi.fn().mockReturnValue(false),
  isLikelyInterimCronMessage: vi.fn().mockReturnValue(false),
}));

vi.mock("./subagent-followup.runtime.js", () => ({
  readDescendantSubagentFallbackReply: vi.fn().mockResolvedValue(undefined),
  waitForDescendantSubagentSummary: vi.fn().mockResolvedValue(undefined),
}));

import { retireSessionMcpRuntime } from "../../agents/pi-bundle-mcp-tools.js";
// Import after mocks
import { countActiveDescendantRuns } from "../../agents/subagent-registry-read.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.runtime.js";
import { callGateway } from "../../gateway/call.runtime.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import {
  ensureOutboundSessionEntry,
  resolveOutboundSessionRoute,
} from "../../infra/outbound/outbound-session.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { shouldEnqueueCronMainSummary } from "../heartbeat-policy.js";
import {
  dispatchCronDelivery,
  getCompletedDirectCronDeliveriesCountForTests,
  resetCompletedDirectCronDeliveriesForTests,
} from "./delivery-dispatch.js";
import type { DeliveryTargetResolution } from "./delivery-target.js";
import type { RunCronAgentTurnResult } from "./run.js";
import { expectsSubagentFollowup, isLikelyInterimCronMessage } from "./subagent-followup-hints.js";
import {
  readDescendantSubagentFallbackReply,
  waitForDescendantSubagentSummary,
} from "./subagent-followup.runtime.js";

type SuccessfulDeliveryResolution = Extract<DeliveryTargetResolution, { ok: true }>;
type ResolvedOutboundSessionRoute = NonNullable<
  Awaited<ReturnType<typeof resolveOutboundSessionRoute>>
>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResolvedDelivery(
  overrides: Partial<SuccessfulDeliveryResolution> = {},
): SuccessfulDeliveryResolution {
  return {
    ok: true,
    channel: "telegram",
    to: "123456",
    accountId: undefined,
    threadId: undefined,
    mode: "explicit",
    ...overrides,
  };
}

function makeWithRunSession() {
  return (
    result: Omit<RunCronAgentTurnResult, "sessionId" | "sessionKey">,
  ): RunCronAgentTurnResult => ({
    ...result,
    sessionId: "test-session-id",
    sessionKey: "test-session-key",
  });
}

function makeBaseParams(overrides: {
  synthesizedText?: string;
  deliveryRequested?: boolean;
  runStartedAt?: number;
  sessionTarget?: string;
  deliveryBestEffort?: boolean;
  runSessionKey?: string;
  resolvedDeliveryMode?: "explicit" | "implicit";
}): Parameters<typeof dispatchCronDelivery>[0] {
  const resolvedDelivery = {
    ...makeResolvedDelivery(),
    mode: overrides.resolvedDeliveryMode ?? "explicit",
  } satisfies Extract<DeliveryTargetResolution, { ok: true }>;
  const runStartedAt = overrides.runStartedAt ?? Date.now();
  return {
    cfg: {} as never,
    cfgWithAgentDefaults: {} as never,
    deps: {} as never,
    job: {
      id: "test-job",
      name: "Test Job",
      sessionTarget: overrides.sessionTarget ?? "isolated",
      deleteAfterRun: false,
      payload: { kind: "agentTurn", message: "hello" },
    } as never,
    agentId: "main",
    agentSessionKey: "agent:main",
    runSessionKey: overrides.runSessionKey ?? "agent:main",
    sessionId: "test-session-id",
    runStartedAt,
    runEndedAt: runStartedAt,
    timeoutMs: 30_000,
    resolvedDelivery,
    deliveryRequested: overrides.deliveryRequested ?? true,
    skipHeartbeatDelivery: false,
    deliveryBestEffort: overrides.deliveryBestEffort ?? false,
    deliveryPayloadHasStructuredContent: false,
    deliveryPayloads: overrides.synthesizedText ? [{ text: overrides.synthesizedText }] : [],
    synthesizedText: overrides.synthesizedText ?? "on it",
    summary: overrides.synthesizedText ?? "on it",
    outputText: overrides.synthesizedText ?? "on it",
    telemetry: undefined,
    abortSignal: undefined,
    isAborted: () => false,
    abortReason: () => "aborted",
    withRunSession: makeWithRunSession(),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function outboundDeliveryCall(callIndex = 0) {
  const call = vi.mocked(deliverOutboundPayloads).mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected outbound delivery call ${callIndex}`);
  }
  return requireRecord(call[0], `outbound delivery call ${callIndex}`);
}

function expectFields(actual: Record<string, unknown>, expected: Record<string, unknown>) {
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key], key).toEqual(value);
  }
}

function expectDeliveryCall(callIndex: number, expected: Record<string, unknown>) {
  expectFields(outboundDeliveryCall(callIndex), expected);
}

function expectResultFields(result: unknown, expected: Record<string, unknown>) {
  expectFields(requireRecord(result, "cron delivery result"), expected);
}

function mockResolvedOutboundRoute(
  overrides: Partial<ResolvedOutboundSessionRoute> = {},
): ResolvedOutboundSessionRoute {
  const route: ResolvedOutboundSessionRoute = {
    sessionKey: "agent:main:telegram:direct:123456",
    baseSessionKey: "agent:main:telegram:direct:123456",
    peer: { kind: "direct", id: "123456" },
    chatType: "direct",
    from: "telegram:123456",
    to: "123456",
    ...overrides,
  };
  vi.mocked(resolveOutboundSessionRoute).mockResolvedValue(route);
  return route;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatchCronDelivery — double-announce guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCompletedDirectCronDeliveriesForTests();
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(expectsSubagentFollowup).mockReturnValue(false);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
    vi.mocked(readDescendantSubagentFallbackReply).mockResolvedValue(undefined);
    vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue(undefined);
    vi.mocked(retireSessionMcpRuntime).mockResolvedValue(true);
    vi.mocked(resolveOutboundSessionRoute).mockResolvedValue(null);
    vi.mocked(ensureOutboundSessionEntry).mockResolvedValue(undefined);
    vi.mocked(appendAssistantMessageToSessionTranscript).mockResolvedValue({
      ok: true,
      sessionFile: "session.jsonl",
      messageId: "mirror-message",
    });
    maybeApplyTtsToPayloadMock.mockReset().mockImplementation(async (params) => params.payload);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("early return (active subagent) sets deliveryAttempted=true so timer skips enqueueSystemEvent", async () => {
    // countActiveDescendantRuns returns >0 → enters wait block; still >0 after wait → early return
    vi.mocked(countActiveDescendantRuns).mockReturnValue(2);
    vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue(undefined);
    vi.mocked(readDescendantSubagentFallbackReply).mockResolvedValue(undefined);

    const params = makeBaseParams({ synthesizedText: "on it" });
    const state = await dispatchCronDelivery(params);

    // deliveryAttempted must be true so timer does NOT fire enqueueSystemEvent
    expect(state.deliveryAttempted).toBe(true);
    expect(waitForDescendantSubagentSummary).toHaveBeenCalledTimes(1);

    // Verify timer guard agrees: shouldEnqueueCronMainSummary returns false
    expect(
      shouldEnqueueCronMainSummary({
        summaryText: "on it",
        deliveryRequested: true,
        delivered: state.delivered,
        deliveryAttempted: state.deliveryAttempted,
        suppressMainSummary: false,
        isCronSystemEvent: () => true,
      }),
    ).toBe(false);

    // No announce should have been attempted (subagents still running)
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("bestEffort delivery skips active subagent wait and sends the cron reply", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(2);
    vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue(undefined);
    vi.mocked(readDescendantSubagentFallbackReply).mockResolvedValue(undefined);

    const params = makeBaseParams({
      synthesizedText: "Parent cron summary is ready.",
      deliveryBestEffort: true,
    });
    const state = await dispatchCronDelivery(params);

    expect(waitForDescendantSubagentSummary).not.toHaveBeenCalled();
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expectDeliveryCall(0, {
      channel: "telegram",
      to: "123456",
      payloads: [{ text: "Parent cron summary is ready." }],
      skipQueue: true,
    });
    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(true);
  });

  it("bestEffort delivery skips expected subagent follow-up waits", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(expectsSubagentFollowup).mockReturnValue(true);
    vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue(undefined);

    const params = makeBaseParams({
      synthesizedText: "Spawned a subagent and returning the parent summary now.",
      deliveryBestEffort: true,
    });
    const state = await dispatchCronDelivery(params);

    expect(waitForDescendantSubagentSummary).not.toHaveBeenCalled();
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expectDeliveryCall(0, {
      payloads: [{ text: "Spawned a subagent and returning the parent summary now." }],
    });
    expect(state.delivered).toBe(true);
  });

  it("bestEffort delivery still suppresses stale interim text while descendants run", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(2);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(true);
    vi.mocked(readDescendantSubagentFallbackReply).mockResolvedValue(undefined);
    vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue(undefined);

    const params = makeBaseParams({
      synthesizedText: "on it, pulling everything together",
      deliveryBestEffort: true,
    });
    const state = await dispatchCronDelivery(params);

    expect(waitForDescendantSubagentSummary).not.toHaveBeenCalled();
    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(false);
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("early return (stale interim suppression) sets deliveryAttempted=true so timer skips enqueueSystemEvent", async () => {
    // First countActiveDescendantRuns call returns >0 (had descendants), second returns 0
    vi.mocked(countActiveDescendantRuns)
      .mockReturnValueOnce(2) // initial check → hadDescendants=true, enters wait block
      .mockReturnValueOnce(0); // second check after wait → activeSubagentRuns=0
    vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue(undefined);
    vi.mocked(readDescendantSubagentFallbackReply).mockResolvedValue(undefined);
    // synthesizedText matches initialSynthesizedText & isLikelyInterimCronMessage → stale interim
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(true);

    const params = makeBaseParams({ synthesizedText: "on it, pulling everything together" });
    const state = await dispatchCronDelivery(params);

    // deliveryAttempted must be true so timer does NOT fire enqueueSystemEvent
    expect(state.deliveryAttempted).toBe(true);

    // Verify timer guard agrees
    expect(
      shouldEnqueueCronMainSummary({
        summaryText: "on it, pulling everything together",
        deliveryRequested: true,
        delivered: state.delivered,
        deliveryAttempted: state.deliveryAttempted,
        suppressMainSummary: false,
        isCronSystemEvent: () => true,
      }),
    ).toBe(false);

    // No direct delivery should have been sent (stale interim suppressed)
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("consolidates descendant output into the final direct delivery", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(true);
    vi.mocked(readDescendantSubagentFallbackReply).mockResolvedValue(
      "Detailed child result, everything finished successfully.",
    );

    const params = makeBaseParams({ synthesizedText: "on it" });
    const state = await dispatchCronDelivery(params);

    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expectDeliveryCall(0, {
      channel: "telegram",
      to: "123456",
      payloads: [{ text: "Detailed child result, everything finished successfully." }],
      skipQueue: true,
    });
  });

  it("uses the run-scoped session key for isolated cron descendant fallback delivery", async () => {
    const runStartedAt = 1_000;
    const agentSessionKey = "agent:main:cron:daily-monitor";
    const runSessionKey = "agent:main:cron:daily-monitor:run:test-session-id";
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(true);
    vi.mocked(readDescendantSubagentFallbackReply).mockImplementation(async (params) =>
      params.sessionKey === runSessionKey
        ? "Run-scoped child result, everything finished successfully."
        : undefined,
    );

    const params = makeBaseParams({
      synthesizedText: "on it",
      runStartedAt,
      runSessionKey,
    });
    params.agentSessionKey = agentSessionKey;

    const state = await dispatchCronDelivery(params);

    expect(countActiveDescendantRuns).toHaveBeenCalledWith(runSessionKey);
    expect(countActiveDescendantRuns).not.toHaveBeenCalledWith(agentSessionKey);
    expect(readDescendantSubagentFallbackReply).toHaveBeenCalledWith({
      sessionKey: runSessionKey,
      runStartedAt,
    });
    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(true);
    expectDeliveryCall(0, {
      payloads: [{ text: "Run-scoped child result, everything finished successfully." }],
    });
  });

  it("normal text delivery sends exactly once and sets deliveryAttempted=true", async () => {
    const params = makeBaseParams({
      synthesizedText: "Morning briefing complete.",
      runStartedAt: 1_000,
    });
    const state = await dispatchCronDelivery(params);

    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);

    // Timer should not fire enqueueSystemEvent (delivered=true)
    expect(
      shouldEnqueueCronMainSummary({
        summaryText: "Morning briefing complete.",
        deliveryRequested: true,
        delivered: state.delivered,
        deliveryAttempted: state.deliveryAttempted,
        suppressMainSummary: false,
        isCronSystemEvent: () => true,
      }),
    ).toBe(false);
  });

  it("applies TTS directives before direct cron announce delivery and mirrors spoken text", async () => {
    vi.mocked(deliverOutboundPayloads).mockImplementationOnce(async (deliveryParams) => {
      deliveryParams.onPayload?.({
        text: "Morning briefing complete.",
        mediaUrls: [
          "file:///tmp/chart.png",
          "file:///tmp/narration.ogg",
          "file:///tmp/cron-tts.mp3",
        ],
        audioAsVoice: true,
      });
      return [{ ok: true } as never];
    });
    maybeApplyTtsToPayloadMock.mockImplementation(async (params: { payload: unknown }) => {
      const payload = params.payload as { text?: string };
      expect(payload.text).toBe("[[tts]] Morning briefing complete.");
      return {
        text: "Morning briefing complete.",
        mediaUrl: "file:///tmp/cron-tts.mp3",
        mediaUrls: ["file:///tmp/chart.png", "file:///tmp/narration.ogg"],
        audioAsVoice: true,
        spokenText: "Morning briefing complete.",
      };
    });

    const params = makeBaseParams({
      synthesizedText: "[[tts]] Morning briefing complete.",
      runStartedAt: 1_000,
    });
    params.cfgWithAgentDefaults = {
      messages: {
        tts: {
          auto: "tagged",
          provider: "microsoft",
        },
      },
    } as never;

    const state = await dispatchCronDelivery(params);

    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(true);
    const ttsCall = maybeApplyTtsToPayloadMock.mock.calls[0];
    if (!ttsCall) {
      throw new Error("expected TTS payload call");
    }
    expectFields(requireRecord(ttsCall[0], "TTS payload params"), {
      cfg: params.cfgWithAgentDefaults,
      channel: "telegram",
      kind: "final",
      agentId: "main",
      accountId: undefined,
    });
    expectDeliveryCall(0, {
      channel: "telegram",
      to: "123456",
      payloads: [
        {
          text: "Morning briefing complete.",
          mediaUrl: "file:///tmp/cron-tts.mp3",
          mediaUrls: ["file:///tmp/chart.png", "file:///tmp/narration.ogg"],
          audioAsVoice: true,
          spokenText: "Morning briefing complete.",
        },
      ],
    });
    expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Morning briefing complete.\nchart.png",
        mediaUrls: undefined,
      }),
    );
  });

  it("mirrors direct delivery text with media filenames", async () => {
    const params = makeBaseParams({ synthesizedText: "Report attached." });
    params.deliveryPayloadHasStructuredContent = true;
    params.deliveryPayloads = [
      { text: "Report attached.", mediaUrl: "https://example.com/report.png" },
    ] as never;

    const state = await dispatchCronDelivery(params);

    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(true);
    expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Report attached.\nreport.png",
        mediaUrls: undefined,
      }),
    );
  });

  it("mirrors the effective outbound payload after send hooks rewrite delivery text", async () => {
    mockResolvedOutboundRoute();
    vi.mocked(deliverOutboundPayloads).mockImplementationOnce(async (params) => {
      params.onPayload?.({ text: "Redacted cron update.", mediaUrls: [] });
      return [{ channel: "telegram", messageId: "tg-redacted" }];
    });

    const params = makeBaseParams({
      synthesizedText: "Sensitive cron update.",
      runStartedAt: 1_000,
    });
    const state = await dispatchCronDelivery(params);

    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(true);
    expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:direct:123456",
        text: "Redacted cron update.",
        mediaUrls: undefined,
      }),
    );
    expect(enqueueSystemEvent).toHaveBeenCalledWith("Redacted cron update.", {
      sessionKey: "agent:main:main",
      contextKey: "cron-direct-delivery:v1:cron:test-job:1000:telegram::123456:",
      forceSenderIsOwnerFalse: true,
      trusted: false,
    });
  });

  it("preserves all successful text payloads for direct delivery", async () => {
    const params = makeBaseParams({ synthesizedText: undefined });
    params.deliveryPayloads = [{ text: "Working on it..." }, { text: "Final weather summary" }];
    params.summary = "Final weather summary";
    params.outputText = "Final weather summary";

    const state = await dispatchCronDelivery(params);

    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expectDeliveryCall(0, {
      channel: "telegram",
      to: "123456",
      payloads: [{ text: "Working on it..." }, { text: "Final weather summary" }],
    });
  });

  it("queues main-session awareness for isolated cron jobs with explicit delivery targets", async () => {
    const params = makeBaseParams({
      synthesizedText: "Morning briefing complete.",
      runStartedAt: 1_000,
    });
    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(state.deliveryAttempted).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).toHaveBeenCalledWith("Morning briefing complete.", {
      sessionKey: "agent:main:main",
      contextKey: "cron-direct-delivery:v1:cron:test-job:1000:telegram::123456:",
      forceSenderIsOwnerFalse: true,
      trusted: false,
    });
  });

  it("does not mirror separately when the resolved delivery session is the awareness main session", async () => {
    mockResolvedOutboundRoute({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
    });
    vi.mocked(deliverOutboundPayloads).mockImplementationOnce(async (params) => {
      params.onPayload?.({ text: "First main session briefing.", mediaUrls: [] });
      params.onPayload?.({ text: "Second main session briefing.", mediaUrls: [] });
      return [{ channel: "telegram", messageId: "tg-main" }];
    });

    const params = makeBaseParams({
      synthesizedText: "Main session briefing complete.",
      runStartedAt: 1_000,
    });
    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "First main session briefing.\nSecond main session briefing.",
      {
        sessionKey: "agent:main:main",
        contextKey: "cron-direct-delivery:v1:cron:test-job:1000:telegram::123456:",
        forceSenderIsOwnerFalse: true,
        trusted: false,
      },
    );
  });

  it("keeps effective media-only payloads in main-session awareness before suppressing the mirror", async () => {
    mockResolvedOutboundRoute({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
    });
    vi.mocked(deliverOutboundPayloads).mockImplementationOnce(async (params) => {
      params.onPayload?.({
        text: "",
        mediaUrls: ["https://example.com/main-chart.png"],
      });
      return [{ channel: "telegram", messageId: "tg-main-media" }];
    });

    const params = makeBaseParams({
      synthesizedText: "Main session briefing.",
      runStartedAt: 1_000,
    });
    params.deliveryPayloadHasStructuredContent = true;
    params.deliveryPayloads = [
      { text: "Main session briefing.", mediaUrl: "https://example.com/main-chart.png" },
    ] as never;
    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).toHaveBeenCalledWith("main-chart.png", {
      sessionKey: "agent:main:main",
      contextKey: "cron-direct-delivery:v1:cron:test-job:1000:telegram::123456:",
      forceSenderIsOwnerFalse: true,
      trusted: false,
    });
  });

  it("mirrors media-only main-session deliveries because awareness has no transcript text", async () => {
    mockResolvedOutboundRoute({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
    });

    const params = makeBaseParams({
      synthesizedText: undefined,
      runStartedAt: 1_000,
    });
    params.deliveryPayloadHasStructuredContent = true;
    params.deliveryPayloads = [{ mediaUrl: "https://example.com/main-report.png" }] as never;
    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        text: "main-report.png",
        mediaUrls: undefined,
      }),
    );
  });

  it("mirrors main-session deliveries when awareness queueing is suppressed", async () => {
    mockResolvedOutboundRoute({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
    });

    const params = makeBaseParams({
      synthesizedText: "Best-effort main session briefing complete.",
      deliveryBestEffort: true,
      runStartedAt: 1_000,
    });
    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        text: "Best-effort main session briefing complete.",
        mediaUrls: undefined,
      }),
    );
  });

  it("canonicalizes routed main-session aliases before the awareness duplicate guard", async () => {
    mockResolvedOutboundRoute({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
      to: "telegram:123456",
    });

    const params = makeBaseParams({
      synthesizedText: "Custom main session briefing complete.",
      runStartedAt: 1_000,
    });
    params.cfgWithAgentDefaults = {
      session: { mainKey: "work" },
    } as never;
    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(buildOutboundSessionContext).toHaveBeenCalledWith({
      cfg: params.cfgWithAgentDefaults,
      agentId: "main",
      sessionKey: "agent:main:work",
    });
    expect(ensureOutboundSessionEntry).toHaveBeenCalledWith({
      cfg: params.cfgWithAgentDefaults,
      channel: "telegram",
      accountId: undefined,
      route: expect.objectContaining({
        sessionKey: "agent:main:work",
        baseSessionKey: "agent:main:work",
      }),
    });
    expect(appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).toHaveBeenCalledWith("Custom main session briefing complete.", {
      sessionKey: "agent:main:work",
      contextKey: "cron-direct-delivery:v1:cron:test-job:1000:telegram::123456:",
      forceSenderIsOwnerFalse: true,
      trusted: false,
    });
  });

  it("canonicalizes routed thread-suffixed main-session aliases before mirroring", async () => {
    mockResolvedOutboundRoute({
      sessionKey: "agent:main:main:thread:42",
      baseSessionKey: "agent:main:main",
      to: "telegram:123456",
      threadId: "42",
    });

    const params = makeBaseParams({
      synthesizedText: "Threaded custom main session briefing complete.",
      runStartedAt: 1_000,
    });
    params.cfgWithAgentDefaults = {
      session: { mainKey: "work" },
    } as never;
    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(buildOutboundSessionContext).toHaveBeenCalledWith({
      cfg: params.cfgWithAgentDefaults,
      agentId: "main",
      sessionKey: "agent:main:work:thread:42",
    });
    expect(ensureOutboundSessionEntry).toHaveBeenCalledWith({
      cfg: params.cfgWithAgentDefaults,
      channel: "telegram",
      accountId: undefined,
      route: expect.objectContaining({
        sessionKey: "agent:main:work:thread:42",
        baseSessionKey: "agent:main:work",
      }),
    });
    expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:work:thread:42",
        text: "Threaded custom main session briefing complete.",
      }),
    );
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Threaded custom main session briefing complete.",
      {
        sessionKey: "agent:main:work",
        contextKey: "cron-direct-delivery:v1:cron:test-job:1000:telegram::123456:",
        forceSenderIsOwnerFalse: true,
        trusted: false,
      },
    );
  });

  it("skips main-session awareness for isolated cron jobs with implicit delivery targets", async () => {
    mockResolvedOutboundRoute({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
    });
    const params = makeBaseParams({
      synthesizedText: "Implicit cron update.",
      resolvedDeliveryMode: "implicit",
    });
    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(state.deliveryAttempted).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("skips awareness text when direct delivery strips a silent caption", async () => {
    const params = makeBaseParams({ synthesizedText: undefined });
    params.deliveryPayloadHasStructuredContent = true;
    params.deliveryPayloads = [
      { mediaUrl: "https://example.com/image.png", text: "All done\n\nNO_REPLY" },
    ];
    params.outputText = "All done\n\nNO_REPLY";
    params.summary = "All done\n\nNO_REPLY";

    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(state.deliveryAttempted).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expectDeliveryCall(0, {
      payloads: [{ mediaUrl: "https://example.com/image.png", text: undefined }],
    });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("keeps the cron run successful when awareness queueing throws after delivery", async () => {
    vi.mocked(enqueueSystemEvent).mockImplementation(() => {
      throw new Error("queue unavailable");
    });

    const params = makeBaseParams({ synthesizedText: "Morning briefing complete." });
    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(state.deliveryAttempted).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });

  it("skips main-session awareness for session-bound cron jobs", async () => {
    const params = makeBaseParams({
      synthesizedText: "Session-bound cron update.",
      sessionTarget: "session:agent:main:main:thread:9999",
    });
    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(state.deliveryAttempted).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("skips main-session awareness for best-effort deliveries", async () => {
    const params = makeBaseParams({
      synthesizedText: "Best-effort cron update.",
      deliveryBestEffort: true,
    });
    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(state.deliveryAttempted).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("skips stale cron deliveries while still suppressing fallback main summary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T17:00:00.000Z"));

    const params = makeBaseParams({ synthesizedText: "Yesterday's morning briefing." });
    (params.job as { state?: { nextRunAtMs?: number } }).state = {
      nextRunAtMs: Date.now() - (3 * 60 * 60_000 + 1),
    };

    const state = await dispatchCronDelivery(params);

    expectResultFields(state.result, {
      status: "ok",
      delivered: false,
      deliveryAttempted: true,
    });
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(
      shouldEnqueueCronMainSummary({
        summaryText: "Yesterday's morning briefing.",
        deliveryRequested: true,
        delivered: state.result?.delivered,
        deliveryAttempted: state.result?.deliveryAttempted,
        suppressMainSummary: false,
        isCronSystemEvent: () => true,
      }),
    ).toBe(false);
  });

  it("still delivers when the run started on time but finished more than three hours later", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T17:00:00.000Z"));
    vi.mocked(deliverOutboundPayloads).mockResolvedValue([{ ok: true } as never]);

    const params = makeBaseParams({ synthesizedText: "Long running report finished." });
    params.runStartedAt = Date.now() - (3 * 60 * 60_000 + 1);
    (params.job as { state?: { nextRunAtMs?: number } }).state = {
      nextRunAtMs: params.runStartedAt,
    };

    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(state.delivered).toBe(true);
    expect(state.deliveryAttempted).toBe(true);
  });

  it("falls back to runStartedAt when nextRunAtMs=0", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T17:00:00.000Z"));
    vi.mocked(deliverOutboundPayloads).mockResolvedValue([{ ok: true } as never]);

    const params = makeBaseParams({ synthesizedText: "Long running report finished." });
    params.runStartedAt = Date.now() - (3 * 60 * 60_000 + 1);
    (params.job as { state?: { nextRunAtMs?: number } }).state = {
      nextRunAtMs: 0,
    };

    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(state.delivered).toBe(true);
    expect(state.deliveryAttempted).toBe(true);
  });

  it("cleans up the direct cron session after a silent reply when deleteAfterRun is enabled", async () => {
    const params = makeBaseParams({ synthesizedText: SILENT_REPLY_TOKEN });
    params.agentSessionKey = "agent:main:cron:test-job";
    (params.job as { deleteAfterRun?: boolean }).deleteAfterRun = true;

    const state = await dispatchCronDelivery(params);

    expectResultFields(state.result, {
      status: "ok",
      delivered: false,
    });
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: "agent:main:cron:test-job",
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
  });

  it("cleans up the direct cron session after text delivery when deleteAfterRun is enabled", async () => {
    const params = makeBaseParams({ synthesizedText: "HEARTBEAT_OK 🦞" });
    params.agentSessionKey = "agent:main:cron:test-job";
    (params.job as { deleteAfterRun?: boolean }).deleteAfterRun = true;

    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: "agent:main:cron:test-job",
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
  });

  it("retires the MCP runtime directly when deleteAfterRun gateway cleanup fails", async () => {
    vi.mocked(callGateway).mockRejectedValueOnce(new Error("gateway down"));

    const params = makeBaseParams({ synthesizedText: SILENT_REPLY_TOKEN });
    params.agentSessionKey = "agent:main:cron:test-job";
    (params.job as { deleteAfterRun?: boolean }).deleteAfterRun = true;

    const state = await dispatchCronDelivery(params);

    expectResultFields(state.result, {
      status: "ok",
      delivered: false,
    });
    expect(retireSessionMcpRuntime).toHaveBeenCalledWith({
      sessionId: "test-session-id",
      reason: "cron-delete-after-run-fallback",
    });
  });

  it("skips deleteAfterRun cleanup for non-cron sessions", async () => {
    const params = makeBaseParams({ synthesizedText: SILENT_REPLY_TOKEN });
    params.agentSessionKey = "agent:main:whatsapp:direct:+15551234567";
    (params.job as { deleteAfterRun?: boolean }).deleteAfterRun = true;

    const state = await dispatchCronDelivery(params);

    expectResultFields(state.result, {
      status: "ok",
      delivered: false,
    });
    expect(callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.delete",
      }),
    );
    expect(retireSessionMcpRuntime).not.toHaveBeenCalled();
  });

  it("text delivery fires exactly once (no double-deliver)", async () => {
    vi.mocked(deliverOutboundPayloads).mockResolvedValue([{ ok: true } as never]);

    const params = makeBaseParams({ synthesizedText: "Briefing ready." });
    const state = await dispatchCronDelivery(params);

    // Delivery was attempted; direct fallback picked up the slack
    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(true);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });

  it("retries transient direct announce failures before succeeding", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.mocked(deliverOutboundPayloads)
      .mockRejectedValueOnce(new Error("ECONNRESET while sending"))
      .mockResolvedValueOnce([{ ok: true } as never]);

    const params = makeBaseParams({ synthesizedText: "Retry me once." });
    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(2);
  });

  it("keeps direct announce delivery idempotent across replay for the same cron execution", async () => {
    vi.mocked(deliverOutboundPayloads).mockResolvedValue([{ ok: true } as never]);

    const params = makeBaseParams({ synthesizedText: "Replay-safe cron update." });
    const first = await dispatchCronDelivery(params);
    const second = await dispatchCronDelivery(params);

    expect(first.delivered).toBe(true);
    expect(second.delivered).toBe(true);
    expect(second.deliveryAttempted).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });

  it("does not collapse distinct recurring runs for the same job", async () => {
    vi.mocked(deliverOutboundPayloads).mockResolvedValue([{ ok: true } as never]);

    const first = makeBaseParams({
      runStartedAt: 1_000,
      synthesizedText: "8:00 AM cron update.",
    });
    const second = makeBaseParams({
      runStartedAt: 2_000,
      synthesizedText: "9:00 AM cron update.",
    });

    const firstState = await dispatchCronDelivery(first);
    const secondState = await dispatchCronDelivery(second);

    expect(firstState.delivered).toBe(true);
    expect(secondState.delivered).toBe(true);
    expect(secondState.deliveryAttempted).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(2);
    expectDeliveryCall(0, {
      payloads: [{ text: "8:00 AM cron update." }],
    });
    expectDeliveryCall(1, {
      payloads: [{ text: "9:00 AM cron update." }],
    });
  });

  it("does not cache partial bestEffort delivery replays as delivered", async () => {
    vi.mocked(deliverOutboundPayloads).mockImplementation(async (params) => {
      const failedPayload = Array.isArray(params.payloads) ? params.payloads[0] : undefined;
      params.onError?.(new Error("payload failed"), failedPayload as never);
      return [{ ok: true } as never];
    });

    const params = makeBaseParams({ synthesizedText: "Partial bestEffort replay." }) as Record<
      string,
      unknown
    >;
    params.deliveryBestEffort = true;

    const first = await dispatchCronDelivery(params as never);
    const second = await dispatchCronDelivery(params as never);

    expect(first.delivered).toBe(false);
    expect(second.delivered).toBe(false);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(2);
    expect(appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("prunes the completed-delivery cache back to the entry cap", async () => {
    vi.mocked(deliverOutboundPayloads).mockResolvedValue([{ ok: true } as never]);

    for (let i = 0; i < 2003; i += 1) {
      const params = makeBaseParams({
        synthesizedText: `Replay-safe cron update ${i}.`,
        runStartedAt: i,
      });
      const state = await dispatchCronDelivery(params);
      expect(state.delivered).toBe(true);
    }

    expect(getCompletedDirectCronDeliveriesCountForTests()).toBe(2000);
  });

  it("does not retry permanent direct announce failures", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.mocked(deliverOutboundPayloads).mockRejectedValue(new Error("chat not found"));

    const params = makeBaseParams({ synthesizedText: "This should fail once." });
    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expectResultFields(state.result, {
      status: "error",
      error: "Error: chat not found",
      deliveryAttempted: true,
    });
  });

  it("surfaces structured direct delivery failures without retry when best-effort is disabled", async () => {
    vi.mocked(deliverOutboundPayloads).mockRejectedValue(new Error("boom"));

    const params = makeBaseParams({ synthesizedText: "Report attached." });
    (params as Record<string, unknown>).deliveryPayloadHasStructuredContent = true;
    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expectResultFields(state.result, {
      status: "error",
      error: "Error: boom",
      deliveryAttempted: true,
    });
  });

  it("ignores structured direct delivery failures when best-effort is enabled", async () => {
    vi.mocked(deliverOutboundPayloads).mockRejectedValue(new Error("boom"));

    const params = makeBaseParams({ synthesizedText: "Report attached." }) as Record<
      string,
      unknown
    >;
    params.deliveryPayloadHasStructuredContent = true;
    params.deliveryBestEffort = true;
    const state = await dispatchCronDelivery(params as never);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(false);
    expect(state.deliveryAttempted).toBe(true);
  });

  it("no delivery requested means deliveryAttempted stays false and no delivery is sent", async () => {
    const params = makeBaseParams({
      synthesizedText: "Task done.",
      deliveryRequested: false,
    });
    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(state.deliveryAttempted).toBe(false);
  });

  it("text delivery always bypasses the write-ahead queue", async () => {
    vi.mocked(deliverOutboundPayloads).mockResolvedValue([{ ok: true } as never]);

    const params = makeBaseParams({ synthesizedText: "Daily digest ready." });
    const state = await dispatchCronDelivery(params);

    expect(state.delivered).toBe(true);
    expect(state.deliveryAttempted).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);

    expectDeliveryCall(0, {
      channel: "telegram",
      to: "123456",
      payloads: [{ text: "Daily digest ready." }],
      skipQueue: true,
    });
  });

  it("structured/thread delivery also bypasses the write-ahead queue", async () => {
    vi.mocked(deliverOutboundPayloads).mockResolvedValue([{ ok: true } as never]);

    const params = makeBaseParams({ synthesizedText: "Report attached." });
    // Simulate structured content so useDirectDelivery path is taken (no retryTransient)
    (params as Record<string, unknown>).deliveryPayloadHasStructuredContent = true;
    await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expectDeliveryCall(0, { skipQueue: true });
  });

  it("transient retry delivers exactly once with skipQueue on both attempts", async () => {
    // First call throws a transient error, second call succeeds.
    vi.mocked(deliverOutboundPayloads)
      .mockRejectedValueOnce(new Error("gateway timeout"))
      .mockResolvedValueOnce([{ ok: true } as never]);

    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    try {
      const params = makeBaseParams({ synthesizedText: "Retry test." });
      const state = await dispatchCronDelivery(params);

      expect(state.delivered).toBe(true);
      expect(state.deliveryAttempted).toBe(true);
      // Two calls total: first failed transiently, second succeeded.
      expect(deliverOutboundPayloads).toHaveBeenCalledTimes(2);

      expectDeliveryCall(0, { skipQueue: true });
      expectDeliveryCall(1, { skipQueue: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("suppresses NO_REPLY payload in direct delivery so sentinel never leaks to external channels", async () => {
    const params = makeBaseParams({ synthesizedText: "NO_REPLY" });
    // Force the useDirectDelivery path (structured content) to exercise
    // deliverViaDirect without going through finalizeTextDelivery.
    (params as Record<string, unknown>).deliveryPayloadHasStructuredContent = true;
    const state = await dispatchCronDelivery(params);

    // NO_REPLY must be filtered out before reaching the outbound adapter.
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expectResultFields(state.result, {
      status: "ok",
      delivered: false,
      deliveryAttempted: true,
    });
    // deliveryAttempted must be true so the heartbeat timer does not fire
    // a fallback enqueueSystemEvent with the NO_REPLY sentinel text.
    expect(state.deliveryAttempted).toBe(true);

    // Verify timer guard agrees: shouldEnqueueCronMainSummary returns false
    expect(
      shouldEnqueueCronMainSummary({
        summaryText: "NO_REPLY",
        deliveryRequested: true,
        delivered: state.result?.delivered,
        deliveryAttempted: state.result?.deliveryAttempted,
        suppressMainSummary: false,
        isCronSystemEvent: () => true,
      }),
    ).toBe(false);
  });

  it("delivers explicit targets with direct text through the outbound adapter", async () => {
    const params = makeBaseParams({ synthesizedText: "hello from cron" });
    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(state.deliveryAttempted).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expectDeliveryCall(0, {
      channel: "telegram",
      to: "123456",
      accountId: undefined,
      threadId: undefined,
      bestEffort: false,
      skipQueue: true,
      payloads: [{ text: "hello from cron" }],
    });
  });

  it("keeps unresolved message-tool delivery out of delivered status", async () => {
    const params = makeBaseParams({ synthesizedText: "hello from cron" });
    params.resolvedDelivery = {
      ok: false,
      channel: undefined,
      to: undefined,
      accountId: undefined,
      threadId: undefined,
      mode: "implicit",
      error: new Error("sessionKey is required to resolve delivery.channel=last"),
    };
    params.unverifiedMessagingToolDelivery = true;

    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(state.delivered).toBe(false);
    expect(state.deliveryAttempted).toBe(false);
    expectResultFields(state.result, {
      status: "error",
      errorKind: "delivery-target",
      deliveryAttempted: false,
    });
    expect(state.result?.error).toContain(
      "sessionKey is required to resolve delivery.channel=last",
    );
    expect(state.result?.error).toContain(
      "the agent used the message tool, but OpenClaw could not verify",
    );
  });

  it("falls back to the current agent session key when route resolution is unavailable", async () => {
    const params = makeBaseParams({ synthesizedText: "hello from cron" });
    params.cfgWithAgentDefaults = {
      session: { dmScope: "per-channel-peer" },
    } as never;
    params.agentSessionKey = "agent:main:telegram:123456";

    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(buildOutboundSessionContext).toHaveBeenCalledWith({
      cfg: params.cfgWithAgentDefaults,
      agentId: "main",
      sessionKey: "agent:main:telegram:123456",
    });
  });

  it("mirrors isolated cron direct delivery into the resolved destination channel session", async () => {
    mockResolvedOutboundRoute({
      sessionKey: "agent:main:whatsapp:direct:+15551234567",
      baseSessionKey: "agent:main:whatsapp:direct:+15551234567",
      peer: { kind: "direct", id: "+15551234567" },
      from: "whatsapp:+15551234567",
      to: "+15551234567",
    });

    const params = makeBaseParams({ synthesizedText: "REPRO_TOKEN_K7M3X9" });
    params.cfgWithAgentDefaults = {
      session: { dmScope: "per-channel-peer", store: "cron-mirror-sessions.json" },
    } as never;
    params.resolvedDelivery = makeResolvedDelivery({
      channel: "whatsapp",
      to: "+15551234567",
    });

    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(resolveOutboundSessionRoute).toHaveBeenCalledWith({
      cfg: params.cfgWithAgentDefaults,
      channel: "whatsapp",
      agentId: "main",
      accountId: undefined,
      target: "+15551234567",
      currentSessionKey: "agent:main",
      threadId: undefined,
    });
    expect(ensureOutboundSessionEntry).toHaveBeenCalledWith({
      cfg: params.cfgWithAgentDefaults,
      channel: "whatsapp",
      accountId: undefined,
      route: expect.objectContaining({
        sessionKey: "agent:main:whatsapp:direct:+15551234567",
      }),
    });
    expect(buildOutboundSessionContext).toHaveBeenCalledWith({
      cfg: params.cfgWithAgentDefaults,
      agentId: "main",
      sessionKey: "agent:main:whatsapp:direct:+15551234567",
    });
    expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith({
      sessionKey: "agent:main:whatsapp:direct:+15551234567",
      agentId: "main",
      text: "REPRO_TOKEN_K7M3X9",
      mediaUrls: undefined,
      storePath: expect.stringContaining("cron-mirror-sessions.json"),
      idempotencyKey: expect.stringContaining("test-job"),
      config: params.cfgWithAgentDefaults,
    });
  });

  it("keeps successful direct delivery delivered when the transcript mirror append fails", async () => {
    mockResolvedOutboundRoute({
      sessionKey: "agent:main:whatsapp:direct:+15551234567",
      baseSessionKey: "agent:main:whatsapp:direct:+15551234567",
      peer: { kind: "direct", id: "+15551234567" },
      from: "whatsapp:+15551234567",
      to: "+15551234567",
    });
    vi.mocked(appendAssistantMessageToSessionTranscript).mockRejectedValueOnce(
      new Error("transcript locked"),
    );

    const params = makeBaseParams({ synthesizedText: "sent despite mirror failure" });
    params.cfgWithAgentDefaults = {
      session: { dmScope: "per-channel-peer" },
    } as never;
    params.resolvedDelivery = makeResolvedDelivery({
      channel: "whatsapp",
      to: "+15551234567",
    });

    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(1);
    expect(getCompletedDirectCronDeliveriesCountForTests()).toBe(1);
  });

  it("keeps custom session cron delivery mirrors on the custom session", async () => {
    const params = makeBaseParams({
      synthesizedText: "custom-session report",
      sessionTarget: "session:daily-report",
    });
    params.agentSessionKey = "agent:main:session:daily-report";
    params.cfgWithAgentDefaults = {
      session: { store: "cron-custom-session-mirror.json" },
    } as never;
    params.resolvedDelivery = makeResolvedDelivery({
      channel: "whatsapp",
      to: "+15551234567",
    });

    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(resolveOutboundSessionRoute).not.toHaveBeenCalled();
    expect(buildOutboundSessionContext).toHaveBeenCalledWith({
      cfg: params.cfgWithAgentDefaults,
      agentId: "main",
      sessionKey: "agent:main:session:daily-report",
    });
    expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith({
      sessionKey: "agent:main:session:daily-report",
      agentId: "main",
      text: "custom-session report",
      mediaUrls: undefined,
      storePath: expect.stringContaining("cron-custom-session-mirror.json"),
      idempotencyKey: expect.stringContaining("test-job"),
      config: params.cfgWithAgentDefaults,
    });
  });

  it("passes threaded telegram delivery through to the outbound adapter", async () => {
    const params = makeBaseParams({ synthesizedText: "Final weather summary" });
    params.resolvedDelivery = makeResolvedDelivery({
      mode: "implicit",
      threadId: 42,
    });

    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expectDeliveryCall(0, {
      channel: "telegram",
      to: "123456",
      threadId: 42,
      payloads: [{ text: "Final weather summary" }],
    });
  });

  it("cleans up the direct cron session after threaded direct delivery when deleteAfterRun is enabled", async () => {
    const params = makeBaseParams({ synthesizedText: "Final weather summary" });
    params.agentSessionKey = "agent:main:cron:test-job";
    params.resolvedDelivery = makeResolvedDelivery({
      mode: "implicit",
      threadId: 42,
    });
    (params.job as { deleteAfterRun?: boolean }).deleteAfterRun = true;

    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: "agent:main:cron:test-job",
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
  });

  it("delivers structured heartbeat/media payloads once through the outbound adapter", async () => {
    const params = makeBaseParams({ synthesizedText: "HEARTBEAT_OK" });
    params.cfgWithAgentDefaults = {
      channels: {
        telegram: {
          allowFrom: ["111", "222", "333"],
        },
      },
    } as never;
    params.deliveryPayloadHasStructuredContent = true;
    params.deliveryPayloads = [
      { text: "HEARTBEAT_OK", mediaUrl: "https://example.com/img.png" },
    ] as never;

    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expectDeliveryCall(0, {
      channel: "telegram",
      to: "123456",
      payloads: [{ text: "HEARTBEAT_OK", mediaUrl: "https://example.com/img.png" }],
    });
    expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "HEARTBEAT_OK\nimg.png",
        mediaUrls: undefined,
      }),
    );
  });

  it("cleans up the direct cron session after structured direct delivery when deleteAfterRun is enabled", async () => {
    const params = makeBaseParams({ synthesizedText: "HEARTBEAT_OK" });
    params.agentSessionKey = "agent:main:cron:test-job";
    params.deliveryPayloadHasStructuredContent = true;
    params.deliveryPayloads = [
      { text: "HEARTBEAT_OK", mediaUrl: "https://example.com/img.png" },
    ] as never;
    (params.job as { deleteAfterRun?: boolean }).deleteAfterRun = true;

    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: "agent:main:cron:test-job",
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
  });

  it("suppresses NO_REPLY payload with surrounding whitespace", async () => {
    const params = makeBaseParams({ synthesizedText: "  NO_REPLY  " });
    (params as Record<string, unknown>).deliveryPayloadHasStructuredContent = true;
    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expectResultFields(state.result, {
      status: "ok",
      delivered: false,
      deliveryAttempted: true,
    });
    expect(state.deliveryAttempted).toBe(true);

    expect(
      shouldEnqueueCronMainSummary({
        summaryText: "  NO_REPLY  ",
        deliveryRequested: true,
        delivered: state.result?.delivered,
        deliveryAttempted: state.result?.deliveryAttempted,
        suppressMainSummary: false,
        isCronSystemEvent: () => true,
      }),
    ).toBe(false);
  });

  it("suppresses mixed-case NO_REPLY in text delivery", async () => {
    const params = makeBaseParams({ synthesizedText: "No_Reply" });
    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expectResultFields(state.result, {
      status: "ok",
      delivered: false,
    });
    expect(
      shouldEnqueueCronMainSummary({
        summaryText: "No_Reply",
        deliveryRequested: true,
        delivered: state.result?.delivered,
        deliveryAttempted: state.result?.deliveryAttempted,
        suppressMainSummary: false,
        isCronSystemEvent: () => true,
      }),
    ).toBe(false);
  });

  it("cleans up the direct cron session after a structured silent reply when deleteAfterRun is enabled", async () => {
    const params = makeBaseParams({ synthesizedText: SILENT_REPLY_TOKEN });
    params.agentSessionKey = "agent:main:cron:test-job";
    (params as Record<string, unknown>).deliveryPayloadHasStructuredContent = true;
    (params.job as { deleteAfterRun?: boolean }).deleteAfterRun = true;

    const state = await dispatchCronDelivery(params);

    expectResultFields(state.result, {
      status: "ok",
      delivered: false,
      deliveryAttempted: true,
    });
    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: "agent:main:cron:test-job",
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
    expect(callGateway).toHaveBeenCalledTimes(1);
  });

  it("suppresses trailing NO_REPLY after summary text in direct delivery (#64976)", async () => {
    const params = makeBaseParams({
      synthesizedText: "All 3 items already processed.\n\nNO_REPLY",
    });
    (params as Record<string, unknown>).deliveryPayloadHasStructuredContent = true;
    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expectResultFields(state.result, {
      status: "ok",
      delivered: false,
      deliveryAttempted: true,
    });
  });

  it("suppresses trailing NO_REPLY after summary text in text delivery (#64976)", async () => {
    const params = makeBaseParams({
      synthesizedText: "Nothing actionable found today.\n\nNO_REPLY",
    });
    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expectResultFields(state.result, {
      status: "ok",
      delivered: false,
      deliveryAttempted: true,
    });
  });

  it("suppresses mixed-case trailing No_Reply after summary text (#64976)", async () => {
    const params = makeBaseParams({
      synthesizedText: "All done, nothing to report.\n\nNo_Reply",
    });
    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expectResultFields(state.result, {
      status: "ok",
      delivered: false,
      deliveryAttempted: true,
    });
  });

  it("delivers substantive text that mentions NO_REPLY in non-trailing content (text delivery)", async () => {
    const params = makeBaseParams({
      synthesizedText:
        "The NO_REPLY sentinel tells the agent to skip delivery when nothing changes.",
    });
    const state = await dispatchCronDelivery(params);

    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });

  it("delivers substantive text that mentions NO_REPLY in non-trailing content (direct delivery)", async () => {
    const params = makeBaseParams({
      synthesizedText:
        "Reminder: reply NO_REPLY when there is nothing to announce, otherwise send a summary.",
    });
    (params as Record<string, unknown>).deliveryPayloadHasStructuredContent = true;
    const state = await dispatchCronDelivery(params);

    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });

  it("delivers non-trailing NO_REPLY mention with trailing whitespace", async () => {
    const params = makeBaseParams({
      synthesizedText: "Use NO_REPLY when nothing actionable changed.\n",
    });
    const state = await dispatchCronDelivery(params);

    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });

  it("drops only the payload with trailing NO_REPLY in a multi-payload direct delivery", async () => {
    const params = makeBaseParams({ synthesizedText: undefined });
    params.deliveryPayloads = [
      { text: "Working on it..." },
      { text: "Final weather summary\n\nNO_REPLY" },
    ];
    params.summary = "Working on it...";
    params.outputText = "Working on it...";

    const state = await dispatchCronDelivery(params);

    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expectDeliveryCall(0, {
      payloads: [{ text: "Working on it..." }],
    });
  });
});

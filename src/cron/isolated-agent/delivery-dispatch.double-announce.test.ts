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

const { countActiveDescendantRunsMock, maybeApplyTtsToPayloadMock, retireSessionMcpRuntimeMock } =
  vi.hoisted(() => ({
    countActiveDescendantRunsMock: vi.fn().mockReturnValue(0),
    maybeApplyTtsToPayloadMock: vi.fn(async (params: { payload: unknown }) => params.payload),
    retireSessionMcpRuntimeMock: vi.fn().mockResolvedValue(true),
  }));

vi.mock("../../config/sessions/main-session.js", () => ({
  resolveAgentMainSessionKey: vi.fn(({ agentId }: { agentId: string }) => `agent:${agentId}:main`),
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
  deliverOutboundPayloads: vi.fn().mockResolvedValue([{ ok: true }]),
}));

vi.mock("../../infra/outbound/identity.js", () => ({
  resolveAgentOutboundIdentity: vi.fn().mockReturnValue({}),
}));

vi.mock("../../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: vi.fn().mockReturnValue({}),
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
import { callGateway } from "../../gateway/call.runtime.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResolvedDelivery(): Extract<DeliveryTargetResolution, { ok: true }> {
  return {
    ok: true,
    channel: "telegram",
    to: "123456",
    accountId: undefined,
    threadId: undefined,
    mode: "explicit",
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
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "123456",
        payloads: [{ text: "Detailed child result, everything finished successfully." }],
      }),
    );
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ skipQueue: true }),
    );
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
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ text: "Run-scoped child result, everything finished successfully." }],
      }),
    );
  });

  it("normal text delivery sends exactly once and sets deliveryAttempted=true", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

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

  it("applies TTS directives before direct cron announce delivery", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
    maybeApplyTtsToPayloadMock.mockImplementation(async (params: { payload: unknown }) => {
      const payload = params.payload as { text?: string };
      expect(payload.text).toBe("[[tts]] Morning briefing complete.");
      return {
        text: "Morning briefing complete.",
        mediaUrl: "file:///tmp/cron-tts.mp3",
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
    expect(maybeApplyTtsToPayloadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: params.cfgWithAgentDefaults,
        channel: "telegram",
        kind: "final",
        agentId: "main",
        accountId: undefined,
      }),
    );
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "123456",
        payloads: [
          {
            text: "Morning briefing complete.",
            mediaUrl: "file:///tmp/cron-tts.mp3",
            audioAsVoice: true,
            spokenText: "Morning briefing complete.",
          },
        ],
      }),
    );
  });

  it("preserves all successful text payloads for direct delivery", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

    const params = makeBaseParams({ synthesizedText: undefined });
    params.deliveryPayloads = [{ text: "Working on it..." }, { text: "Final weather summary" }];
    params.summary = "Final weather summary";
    params.outputText = "Final weather summary";

    const state = await dispatchCronDelivery(params);

    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "123456",
        payloads: [{ text: "Working on it..." }, { text: "Final weather summary" }],
      }),
    );
  });

  it("queues main-session awareness for isolated cron jobs with explicit delivery targets", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

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
      trusted: false,
    });
  });

  it("skips main-session awareness for isolated cron jobs with implicit delivery targets", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

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
  });

  it("skips awareness text when direct delivery strips a silent caption", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

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
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ mediaUrl: "https://example.com/image.png", text: undefined }],
      }),
    );
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("keeps the cron run successful when awareness queueing throws after delivery", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
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
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

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
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

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
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

    const params = makeBaseParams({ synthesizedText: "Yesterday's morning briefing." });
    (params.job as { state?: { nextRunAtMs?: number } }).state = {
      nextRunAtMs: Date.now() - (3 * 60 * 60_000 + 1),
    };

    const state = await dispatchCronDelivery(params);

    expect(state.result).toEqual(
      expect.objectContaining({
        status: "ok",
        delivered: false,
        deliveryAttempted: true,
      }),
    );
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
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
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
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
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
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

    const params = makeBaseParams({ synthesizedText: SILENT_REPLY_TOKEN });
    (params.job as { deleteAfterRun?: boolean }).deleteAfterRun = true;

    const state = await dispatchCronDelivery(params);

    expect(state.result).toEqual(
      expect.objectContaining({
        status: "ok",
        delivered: false,
      }),
    );
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: "agent:main",
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
  });

  it("cleans up the direct cron session after text delivery when deleteAfterRun is enabled", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

    const params = makeBaseParams({ synthesizedText: "HEARTBEAT_OK 🦞" });
    (params.job as { deleteAfterRun?: boolean }).deleteAfterRun = true;

    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: "agent:main",
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
  });

  it("retires the MCP runtime directly when deleteAfterRun gateway cleanup fails", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
    vi.mocked(callGateway).mockRejectedValueOnce(new Error("gateway down"));

    const params = makeBaseParams({ synthesizedText: SILENT_REPLY_TOKEN });
    (params.job as { deleteAfterRun?: boolean }).deleteAfterRun = true;

    const state = await dispatchCronDelivery(params);

    expect(state.result).toEqual(
      expect.objectContaining({
        status: "ok",
        delivered: false,
      }),
    );
    expect(retireSessionMcpRuntime).toHaveBeenCalledWith({
      sessionId: "test-session-id",
      reason: "cron-delete-after-run-fallback",
    });
  });

  it("text delivery fires exactly once (no double-deliver)", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
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
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
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
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
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
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
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
    expect(deliverOutboundPayloads).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        payloads: [{ text: "8:00 AM cron update." }],
      }),
    );
    expect(deliverOutboundPayloads).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        payloads: [{ text: "9:00 AM cron update." }],
      }),
    );
  });

  it("does not cache partial bestEffort delivery replays as delivered", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
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
  });

  it("prunes the completed-delivery cache back to the entry cap", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
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
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
    vi.mocked(deliverOutboundPayloads).mockRejectedValue(new Error("chat not found"));

    const params = makeBaseParams({ synthesizedText: "This should fail once." });
    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(state.result).toEqual(
      expect.objectContaining({
        status: "error",
        error: "Error: chat not found",
        deliveryAttempted: true,
      }),
    );
  });

  it("surfaces structured direct delivery failures without retry when best-effort is disabled", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
    vi.mocked(deliverOutboundPayloads).mockRejectedValue(new Error("boom"));

    const params = makeBaseParams({ synthesizedText: "Report attached." });
    (params as Record<string, unknown>).deliveryPayloadHasStructuredContent = true;
    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(state.result).toEqual(
      expect.objectContaining({
        status: "error",
        error: "Error: boom",
        deliveryAttempted: true,
      }),
    );
  });

  it("ignores structured direct delivery failures when best-effort is enabled", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
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
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
    vi.mocked(deliverOutboundPayloads).mockResolvedValue([{ ok: true } as never]);

    const params = makeBaseParams({ synthesizedText: "Daily digest ready." });
    const state = await dispatchCronDelivery(params);

    expect(state.delivered).toBe(true);
    expect(state.deliveryAttempted).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);

    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "123456",
        payloads: [{ text: "Daily digest ready." }],
        skipQueue: true,
      }),
    );
  });

  it("structured/thread delivery also bypasses the write-ahead queue", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
    vi.mocked(deliverOutboundPayloads).mockResolvedValue([{ ok: true } as never]);

    const params = makeBaseParams({ synthesizedText: "Report attached." });
    // Simulate structured content so useDirectDelivery path is taken (no retryTransient)
    (params as Record<string, unknown>).deliveryPayloadHasStructuredContent = true;
    await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ skipQueue: true }),
    );
  });

  it("transient retry delivers exactly once with skipQueue on both attempts", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

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

      const calls = vi.mocked(deliverOutboundPayloads).mock.calls;
      expect(calls[0][0]).toEqual(expect.objectContaining({ skipQueue: true }));
      expect(calls[1][0]).toEqual(expect.objectContaining({ skipQueue: true }));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("suppresses NO_REPLY payload in direct delivery so sentinel never leaks to external channels", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

    const params = makeBaseParams({ synthesizedText: "NO_REPLY" });
    // Force the useDirectDelivery path (structured content) to exercise
    // deliverViaDirect without going through finalizeTextDelivery.
    (params as Record<string, unknown>).deliveryPayloadHasStructuredContent = true;
    const state = await dispatchCronDelivery(params);

    // NO_REPLY must be filtered out before reaching the outbound adapter.
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(state.result).toEqual(
      expect.objectContaining({
        status: "ok",
        delivered: false,
        deliveryAttempted: true,
      }),
    );
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
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

    const params = makeBaseParams({ synthesizedText: "hello from cron" });
    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(state.deliveryAttempted).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "123456",
        accountId: undefined,
        threadId: undefined,
        bestEffort: false,
        skipQueue: true,
        payloads: [{ text: "hello from cron" }],
      }),
    );
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
    expect(state.result).toEqual(
      expect.objectContaining({
        status: "error",
        errorKind: "delivery-target",
        deliveryAttempted: false,
      }),
    );
    expect(state.result?.error).toContain(
      "sessionKey is required to resolve delivery.channel=last",
    );
    expect(state.result?.error).toContain(
      "the agent used the message tool, but OpenClaw could not verify",
    );
  });

  it("builds outbound session context from the run session key under per-channel-peer scoping", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

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

  it("passes threaded telegram delivery through to the outbound adapter", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

    const params = makeBaseParams({ synthesizedText: "Final weather summary" });
    params.resolvedDelivery = {
      ...makeResolvedDelivery(),
      mode: "implicit",
      threadId: 42,
    };

    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "123456",
        threadId: 42,
        payloads: [{ text: "Final weather summary" }],
      }),
    );
  });

  it("cleans up the direct cron session after threaded direct delivery when deleteAfterRun is enabled", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

    const params = makeBaseParams({ synthesizedText: "Final weather summary" });
    params.resolvedDelivery = {
      ...makeResolvedDelivery(),
      mode: "implicit",
      threadId: 42,
    };
    (params.job as { deleteAfterRun?: boolean }).deleteAfterRun = true;

    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: "agent:main",
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
  });

  it("delivers structured heartbeat/media payloads once through the outbound adapter", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

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
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "123456",
        payloads: [{ text: "HEARTBEAT_OK", mediaUrl: "https://example.com/img.png" }],
      }),
    );
  });

  it("cleans up the direct cron session after structured direct delivery when deleteAfterRun is enabled", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

    const params = makeBaseParams({ synthesizedText: "HEARTBEAT_OK" });
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
        key: "agent:main",
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
  });

  it("suppresses NO_REPLY payload with surrounding whitespace", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

    const params = makeBaseParams({ synthesizedText: "  NO_REPLY  " });
    (params as Record<string, unknown>).deliveryPayloadHasStructuredContent = true;
    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(state.result).toEqual(
      expect.objectContaining({
        status: "ok",
        delivered: false,
        deliveryAttempted: true,
      }),
    );
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
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

    const params = makeBaseParams({ synthesizedText: "No_Reply" });
    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(state.result).toEqual(
      expect.objectContaining({
        status: "ok",
        delivered: false,
      }),
    );
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
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

    const params = makeBaseParams({ synthesizedText: SILENT_REPLY_TOKEN });
    (params as Record<string, unknown>).deliveryPayloadHasStructuredContent = true;
    (params.job as { deleteAfterRun?: boolean }).deleteAfterRun = true;

    const state = await dispatchCronDelivery(params);

    expect(state.result).toEqual(
      expect.objectContaining({
        status: "ok",
        delivered: false,
        deliveryAttempted: true,
      }),
    );
    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: "agent:main",
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
    expect(callGateway).toHaveBeenCalledTimes(1);
  });

  it("suppresses trailing NO_REPLY after summary text in direct delivery (#64976)", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

    const params = makeBaseParams({
      synthesizedText: "All 3 items already processed.\n\nNO_REPLY",
    });
    (params as Record<string, unknown>).deliveryPayloadHasStructuredContent = true;
    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(state.result).toEqual(
      expect.objectContaining({ status: "ok", delivered: false, deliveryAttempted: true }),
    );
  });

  it("suppresses trailing NO_REPLY after summary text in text delivery (#64976)", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

    const params = makeBaseParams({
      synthesizedText: "Nothing actionable found today.\n\nNO_REPLY",
    });
    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(state.result).toEqual(
      expect.objectContaining({ status: "ok", delivered: false, deliveryAttempted: true }),
    );
  });

  it("suppresses mixed-case trailing No_Reply after summary text (#64976)", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

    const params = makeBaseParams({
      synthesizedText: "All done, nothing to report.\n\nNo_Reply",
    });
    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(state.result).toEqual(
      expect.objectContaining({ status: "ok", delivered: false, deliveryAttempted: true }),
    );
  });

  it("delivers substantive text that mentions NO_REPLY in non-trailing content (text delivery)", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

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
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

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
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

    const params = makeBaseParams({
      synthesizedText: "Use NO_REPLY when nothing actionable changed.\n",
    });
    const state = await dispatchCronDelivery(params);

    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });

  it("drops only the payload with trailing NO_REPLY in a multi-payload direct delivery", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

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
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ text: "Working on it..." }],
      }),
    );
  });
});

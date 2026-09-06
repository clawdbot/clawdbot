import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// Mantis-shaped integration regression for #126813: a peer message that queues
// while an agent turn is in flight must re-invoke the agent with a prompt that
// acknowledges the just-delivered message-tool reply instead of the bare
// answer-expected hint. Real gateway admission (two runReplyAgent calls), real
// completion pipeline, real queue state, real drain and real followup runner;
// only the embedded LLM runner is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { buildEmbeddedRunPayloads } from "../../agents/embedded-agent-runner/run/payloads.js";
import { testing as embeddedRunTesting } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { clearRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import {
  MESSAGE_TOOL_ONLY_DELIVERY_HINT,
  MESSAGE_TOOL_ONLY_DELIVERY_HINT_AFTER_DELIVERED_REPLY,
} from "../../plugin-sdk/message-tool-delivery-hints.js";
import { clearMemoryPluginState } from "../../plugins/memory-state.test-fixtures.js";
import { runReplyAgent } from "./agent-runner.js";
import {
  createTestQueueSettings,
  createTestQueuedFollowupRun,
  createTestTemplateContext,
} from "./agent-runner.test-fixtures.js";
import type { FollowupRun } from "./queue.js";
import { testing as replyRunRegistryTesting } from "./reply-run-registry.test-support.js";
import { createMockTypingController } from "./test-helpers.js";

const runEmbeddedAgentMock = vi.fn();

vi.mock("../../agents/embedded-agent.js", () => ({
  compactEmbeddedAgentSession: async () => ({
    compacted: false,
    reason: "test-preflight-disabled",
  }),
  runEmbeddedAgent: (params: unknown) => runEmbeddedAgentMock(params),
  abortEmbeddedAgentRun: () => {},
  isEmbeddedAgentRunActive: () => false,
}));

vi.mock("../../agents/model-fallback-runner.js", () => ({
  runWithModelFallback: async (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => ({
    result: await params.run(params.provider, params.model),
    provider: params.provider,
    model: params.model,
    attempts: [],
  }),
}));

vi.mock("../../agents/model-fallback-attempt.js", () => ({
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error && err.name === "FallbackSummaryError",
}));

vi.mock("../../agents/model-auth.js", () => ({
  isMissingProviderAuthError: () => false,
  resolveModelAuthMode: () => "api-key",
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: vi.fn(),
}));

vi.mock("../../agents/model-selection.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/model-selection.js")>(
    "../../agents/model-selection.js",
  );
  return {
    ...actual,
    isCliProvider: () => false,
  };
});

vi.mock("../../agents/thinking-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/thinking-runtime.js")>();
  return {
    ...actual,
    resolveCandidateThinkingLevel: (
      params: Parameters<typeof actual.resolveCandidateThinkingLevel>[0],
    ) => params.level,
    resolveEffectiveAgentRuntime: () => "openclaw",
  };
});

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: (...args: unknown[]) => console.log("[runtime.log]", ...args),
    error: (...args: unknown[]) => console.error("[runtime.error]", ...args),
    exit: vi.fn(),
  },
}));

vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    diagnostics: [],
  }),
}));

vi.mock("../../cli/command-secret-targets.js", () => ({
  getAgentRuntimeCommandSecretTargetIds: () => new Set<string>(),
  getAgentRuntimeOptionalCommandSecretPaths: () => new Set<string>(),
  getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
}));

vi.mock("../../agents/harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: async () => undefined,
}));

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: () => false,
}));

vi.mock("../../cron/store.js", () => {
  const resolveCronPath = (storePath?: string) => storePath ?? "/tmp/openclaw-cron-store.json";
  return {
    loadCronJobsStore: async () => ({ version: 1, jobs: [] }),
    loadCronStore: async () => ({ version: 1, jobs: [] }),
    resolveCronJobsStorePath: resolveCronPath,
    resolveCronStorePath: resolveCronPath,
  };
});

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: () => ({ kind: "none" }),
    cancelSession: async () => {},
  }),
}));

vi.mock("../../agents/subagents/registry/subagent-registry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../agents/subagents/registry/subagent-registry.js")>();
  return {
    ...actual,
    getSwarmRunByLaunchReplayKey: () => undefined,
    markSubagentRunTerminated: () => 0,
  };
});
vi.mock("../../agents/subagents/registry/subagent-registry-read.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../agents/subagents/registry/subagent-registry-read.js")
  >()),
  getLatestSubagentRunByChildSessionKey: () => null,
  listSubagentRunsForController: () => [],
}));

function buildMessageToolDeliveredRunResult(runId: string, answerText: string) {
  // The exact payload shape the real embedded runner emits for a
  // message-tool-only delivery: the source-reply mirror, not a fresh answer.
  const payloads = buildEmbeddedRunPayloads({
    assistantTexts: [],
    lastAssistant: undefined,
    sessionKey: "peer-reinvoke",
    didSendViaMessagingTool: true,
    didDeliverSourceReplyViaMessageTool: true,
    messagingToolSourceReplyPayloads: [{ text: answerText }],
    messagingToolSentTargets: [
      {
        tool: "message",
        provider: "whatsapp",
        to: "+15550001111",
        text: answerText,
        sourceReplyFinal: true,
      },
    ],
    sourceReplyDeliveryMode: "message_tool_only",
    runId,
  });
  return {
    payloads,
    meta: { agentMeta: {}, finalAssistantVisibleText: answerText },
    didDeliverSourceReplyViaMessageTool: true,
    messagingToolSourceReplyPayloads: [{ text: answerText }],
    messagingToolSentTargets: [
      {
        tool: "message",
        provider: "whatsapp",
        to: "+15550001111",
        text: answerText,
        sourceReplyFinal: true,
      },
    ],
    messagingToolSentTexts: [answerText],
  };
}

/** Live shape where delivery evidence exists but the run result carries no payloads. */
function buildEvidenceOnlyDeliveredRunResult(answerText: string) {
  return {
    payloads: [],
    meta: { agentMeta: {}, finalAssistantVisibleText: answerText },
    didDeliverSourceReplyViaMessageTool: true,
    messagingToolSourceReplyPayloads: [],
    messagingToolSentTargets: [
      {
        tool: "message",
        provider: "whatsapp",
        to: "+15550001111",
        text: answerText,
        sourceReplyFinal: true,
      },
    ],
    messagingToolSentTexts: [answerText],
  };
}

function createMessageToolOnlyRun(params: {
  sessionKey: string;
  prompt: string;
  summaryLine: string;
  tmp: string;
}): FollowupRun {
  return createTestQueuedFollowupRun({
    prompt: params.prompt,
    summaryLine: params.summaryLine,
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey: params.sessionKey,
      messageProvider: "whatsapp",
      sessionFile: path.join(params.tmp, "session.jsonl"),
      workspaceDir: params.tmp,
      // Canonical tool-only run fact; keeps delivery policy aligned so the
      // final answer is never eligible for automatic source delivery.
      config: { messages: { visibleReplies: "message_tool" } },
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      reasoningLevel: "on",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
      sourceReplyDeliveryMode: "message_tool_only",
    },
  });
}

function setupRunnerMocks(): void {
  vi.useRealTimers();
  clearRuntimeConfigSnapshot();
  resetDiagnosticEventsForTest();
  resetSystemEventsForTest();
  embeddedRunTesting.resetActiveEmbeddedRuns();
  replyRunRegistryTesting.resetReplyRunRegistry();
  runEmbeddedAgentMock.mockReset();
}

beforeEach(setupRunnerMocks);

afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetDiagnosticEventsForTest();
  resetSystemEventsForTest();
  vi.useRealTimers();
  clearMemoryPluginState();
  replyRunRegistryTesting.resetReplyRunRegistry();
  embeddedRunTesting.resetActiveEmbeddedRuns();
});

describe("queued peer re-invocation after a delivered message-tool reply (#126813)", () => {
  async function runQueuedPeerScenario(
    buildQ1Result: (answerText: string) => unknown,
  ): Promise<string> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-peer-reinvoke-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "peer-reinvoke";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 1_000,
    };
    await replaceSessionEntry({ storePath, sessionKey }, sessionEntry);

    const q1Text = "MANTIS-Q1 queued-delivery proof: answer once via message tool";
    const q2Text = "MANTIS-Q2 queued-delivery proof: this arrives while Q1 is still active";
    const answerText = "MANTIS-Q1 answer sent via the message tool.";

    const sessionCtx = createTestTemplateContext({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "+15550001111",
      AccountId: "primary",
      MessageSid: "msg",
      ChatType: "direct",
    });
    const q1Run = createMessageToolOnlyRun({
      sessionKey,
      tmp,
      prompt: q1Text,
      summaryLine: q1Text,
    });
    // The queued peer run as composed at queue time: the bare answer-expected
    // hint plus the peer text, exactly what the gateway bakes for
    // message-tool-only delivery.
    const q2Run = createMessageToolOnlyRun({
      sessionKey,
      tmp,
      prompt: `${MESSAGE_TOOL_ONLY_DELIVERY_HINT}\n\n${q2Text}`,
      summaryLine: q2Text,
    });

    // Seeding the session entry resolves the runtime config snapshot; clear it
    // so the runs keep their visibleReplies=message_tool config instead of
    // re-resolving delivery to automatic.
    clearRuntimeConfigSnapshot();

    // Q1's turn: the embedded runner returns the live-shaped delivered result.
    const q1Started = createDeferred();
    const releaseQ1 = createDeferred();
    runEmbeddedAgentMock.mockImplementationOnce(async () => {
      q1Started.resolve();
      await releaseQ1.promise;
      return buildQ1Result(answerText);
    });
    // The drained re-invocation: capture the prompt handed to the provider.
    const reinvocationPrompt = createDeferred<string>();
    runEmbeddedAgentMock.mockImplementationOnce(async (params: unknown) => {
      const prompt = (params as { prompt?: unknown }).prompt;
      reinvocationPrompt.resolve(typeof prompt === "string" ? prompt : "");
      return { payloads: [], meta: { agentMeta: {} } };
    });

    const commonParams = {
      queueKey: sessionKey,
      resolvedQueue: createTestQueueSettings({ mode: "followup" }),
      sessionCtx,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath,
      defaultModel: "anthropic/claude-opus-4-6",
      resolvedVerboseLevel: "off" as const,
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end" as const,
      shouldInjectGroupIntro: false,
      typingMode: "instant" as const,
    };

    const q1Promise = runReplyAgent({
      ...commonParams,
      commandBody: q1Text,
      followupRun: q1Run,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      typing: createMockTypingController(),
      opts: { runId: `q1-${path.basename(tmp)}` },
    });

    await q1Started.promise;

    // Q2 arrives while Q1 is in flight: the gateway admission path queues it.
    await runReplyAgent({
      ...commonParams,
      commandBody: q2Text,
      followupRun: q2Run,
      shouldSteer: false,
      shouldFollowup: true,
      isActive: true,
      typing: createMockTypingController(),
      opts: { runId: `q2-${path.basename(tmp)}` },
    });

    releaseQ1.resolve();
    await q1Promise;

    return await Promise.race([
      reinvocationPrompt.promise,
      new Promise<string>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("drained re-invocation never reached the provider")),
          30_000,
        );
        timer.unref?.();
      }),
    ]);
  }

  it("acknowledges the delivered reply when the run result carries the source-reply mirror", async () => {
    const prompt = await runQueuedPeerScenario((answerText) =>
      buildMessageToolDeliveredRunResult("q1", answerText),
    );

    expect(prompt).toContain("MANTIS-Q2 queued-delivery proof");
    expect(prompt).toContain(MESSAGE_TOOL_ONLY_DELIVERY_HINT_AFTER_DELIVERED_REPLY);
    expect(prompt).not.toContain(MESSAGE_TOOL_ONLY_DELIVERY_HINT);
  });

  it("acknowledges the delivered reply when delivery evidence exists but the payload array is empty", async () => {
    // Live shape: delivery evidence (didDeliverSourceReplyViaMessageTool,
    // sent targets) is present while runResult.payloads is empty, so the
    // completion pipeline's payload branch cannot carry the queue fact.
    const prompt = await runQueuedPeerScenario((answerText) =>
      buildEvidenceOnlyDeliveredRunResult(answerText),
    );

    expect(prompt).toContain("MANTIS-Q2 queued-delivery proof");
    expect(prompt).toContain(MESSAGE_TOOL_ONLY_DELIVERY_HINT_AFTER_DELIVERED_REPLY);
    expect(prompt).not.toContain(MESSAGE_TOOL_ONLY_DELIVERY_HINT);
  });
});

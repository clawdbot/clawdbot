import path from "node:path";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { hasModelSwitchContinuitySignal } from "./model-switch-eval.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { readSessionTranscriptSummary } from "./suite-runtime-agent-session.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { cleanup, makeTempDir } = createTempDirHarness();
const sessionKey = "agent:qa:model-switch-tools";
const sessionId = "model-switch-tool-continuity";
const oldCallId = "read-before-switch";
const newCallId = "read-after-switch";

afterEach(cleanup);

type ProviderMode = "mock-openai" | "live-frontier";
type ToolEvidence = "successful" | "delayed-success" | "failed" | "planned-only" | "old-only";

async function runModelSwitchToolContinuityFlow(params: {
  providerMode: ProviderMode;
  evidence: ToolEvidence;
}) {
  const tempRoot = await makeTempDir("qa-model-switch-tool-continuity-");
  const runtimeEnv = { ...process.env, OPENCLAW_STATE_DIR: path.join(tempRoot, "state") };
  await upsertSessionEntry({
    agentId: "qa",
    env: runtimeEnv,
    sessionKey,
    entry: { sessionId, updatedAt: Date.now() },
  });

  const state = createQaBusState();
  const requests: Array<{
    allInputText: string;
    model: string;
    plannedToolCallId: string;
    plannedToolName: string;
  }> = [];
  const env = {
    providerMode: params.providerMode,
    primaryModel: "openai/primary-model",
    alternateModel: "openai/alternate-model",
    gateway: { tempRoot },
    ...(params.providerMode === "mock-openai" ? { mock: { baseUrl: "http://qa.mock" } } : {}),
  };
  const appendMessage = async (message: unknown) =>
    await appendSessionTranscriptMessageByIdentity({
      agentId: "qa",
      env: runtimeEnv,
      sessionId,
      sessionKey,
      message,
    });
  const appendToolCall = async (toolCallId: string) =>
    await appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: {} }],
    });
  const appendToolResult = async (toolCallId: string, isError = false) =>
    await appendMessage({
      role: "toolResult",
      toolCallId,
      toolName: "read",
      isError,
      timestamp: Date.now(),
      content: [{ type: "text", text: isError ? "read failed" : "QA scenario pack mission" }],
    });
  const scopedSuccessfulReadCounts: number[] = [];
  let delayedReadPersisted = false;
  const readTranscriptSummary = vi.fn(
    async (
      summaryEnv: Parameters<typeof readSessionTranscriptSummary>[0],
      requestedSessionKey: string,
      options?: Parameters<typeof readSessionTranscriptSummary>[2],
    ) => {
      const summary = await readSessionTranscriptSummary(summaryEnv, requestedSessionKey, options);
      if (options?.afterEventCursor !== undefined) {
        scopedSuccessfulReadCounts.push(summary.successfulToolCallCounts.read ?? 0);
        if (params.evidence === "delayed-success" && !delayedReadPersisted) {
          const wholeSession = await readSessionTranscriptSummary(summaryEnv, requestedSessionKey);
          expect(wholeSession.successfulToolCallCounts.read).toBe(1);
          expect(summary.successfulToolCallCounts.read ?? 0).toBe(0);
          delayedReadPersisted = true;
          await appendToolResult(newCallId);
        }
      }
      return summary;
    },
  );

  const result = await runLoadedScenarioFlow("model-switch-tool-continuity", {
    state,
    api: {
      env,
      hasModelSwitchContinuitySignal,
      readSessionTranscriptSummary: readTranscriptSummary,
      resolveQaLiveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
      splitModelRef: (ref: string) => {
        const slash = ref.indexOf("/");
        return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
      },
      fetchJson: async (input: string) => {
        const url = new URL(input);
        if (url.pathname === "/debug/request-cursor") {
          return { cursor: requests.length };
        }
        if (url.pathname === "/debug/requests") {
          return requests.slice(Number(url.searchParams.get("after") ?? 0));
        }
        throw new Error(`unexpected mock provider endpoint: ${url.pathname}`);
      },
      runAgentPrompt: async (_env: unknown, prompt: { message: string; model?: string }) => {
        const isFollowup = requests.length > 0;
        const callId = isFollowup ? newCallId : oldCallId;
        requests.push({
          allInputText: prompt.message,
          model: prompt.model ?? "primary-model",
          plannedToolCallId: callId,
          plannedToolName: "read",
        });

        await appendMessage({ role: "user", content: prompt.message });
        if (!isFollowup || params.evidence !== "old-only") {
          await appendToolCall(callId);
        }
        if (!isFollowup || params.evidence === "successful" || params.evidence === "failed") {
          await appendToolResult(callId, isFollowup && params.evidence === "failed");
        }
        const reply = isFollowup
          ? "The model handoff preserved the QA mission after rereading the scenario pack."
          : "The QA scenario pack mission is to verify source and docs.";
        await appendMessage({ role: "assistant", content: reply });
        state.addOutboundMessage({ accountId: "qa-channel", to: "dm:qa-operator", text: reply });
      },
    },
  });

  return { result, readTranscriptSummary, scopedSuccessfulReadCounts };
}

describe("model-switch tool continuity scenario persisted evidence", () => {
  it.each(["mock-openai", "live-frontier"] as const)(
    "accepts only a successful correlated read from after the model switch (%s)",
    async (providerMode) => {
      const { result, readTranscriptSummary } = await runModelSwitchToolContinuityFlow({
        providerMode,
        evidence: "successful",
      });

      expect(result.status).toBe("pass");
      expect(readTranscriptSummary).toHaveBeenCalledWith(expect.anything(), sessionKey);
      expect(readTranscriptSummary).toHaveBeenCalledWith(
        expect.anything(),
        sessionKey,
        expect.objectContaining({ afterEventCursor: expect.any(Number) }),
      );
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "waits for the new correlated read when its SQLite result persists after agent completion (%s)",
    async (providerMode) => {
      const { result, scopedSuccessfulReadCounts } = await runModelSwitchToolContinuityFlow({
        providerMode,
        evidence: "delayed-success",
      });

      expect(result.status).toBe("pass");
      expect(scopedSuccessfulReadCounts).toEqual([0, 1]);
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "rejects a fabricated handoff when only the prior turn successfully read (%s)",
    async (providerMode) => {
      await expect(
        runModelSwitchToolContinuityFlow({ providerMode, evidence: "old-only" }),
      ).rejects.toThrow(/read.*switch|switch.*read|test condition was not met/i);
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "rejects a planned post-switch read that returned an error (%s)",
    async (providerMode) => {
      await expect(
        runModelSwitchToolContinuityFlow({ providerMode, evidence: "failed" }),
      ).rejects.toThrow(/read.*switch|switch.*read|test condition was not met/i);
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "rejects a planned post-switch read without a correlated result (%s)",
    async (providerMode) => {
      await expect(
        runModelSwitchToolContinuityFlow({ providerMode, evidence: "planned-only" }),
      ).rejects.toThrow(/read.*switch|switch.*read|test condition was not met/i);
    },
  );
});

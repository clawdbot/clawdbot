import path from "node:path";
import { parseModelRef } from "openclaw/plugin-sdk/agent-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { hasModelSwitchContinuitySignal } from "./model-switch-eval.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import {
  readRawQaSessionStore,
  readSessionTranscriptSummary,
} from "./suite-runtime-agent-session.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { cleanup, makeTempDir } = createTempDirHarness();
const sessionKey = "agent:qa:model-switch-tools";
const sessionId = "model-switch-tool-continuity";
const oldCallId = "read-before-switch";
const newCallId = "read-after-switch";

afterEach(cleanup);

type ProviderMode = "mock-openai" | "live-frontier";
type ToolEvidence =
  | "successful"
  | "delayed-success"
  | "delayed-initial-only"
  | "failed"
  | "planned-only"
  | "old-only";

async function runModelSwitchToolContinuityFlow(params: {
  providerMode: ProviderMode;
  evidence: ToolEvidence;
  alternateModel?: string;
  previousAttemptSuccessfulRead?: boolean;
  followupDelivery?: "visible" | "deleted-only" | "deleted-preview-then-visible";
  persistedFollowUpModel?: { provider: string; model: string };
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
    alternateModel: params.alternateModel ?? "openai/alternate-model",
    gateway: {
      baseUrl: "http://qa.gateway",
      tempRoot,
      workspaceDir: path.join(tempRoot, "workspace"),
      runtimeEnv,
      call: async () => undefined,
    },
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
  if (params.previousAttemptSuccessfulRead) {
    await appendToolCall("read-previous-attempt");
    await appendToolResult("read-previous-attempt");
  }
  const scopedSuccessfulReadCounts: number[] = [];
  let delayedReadPersisted = false;
  let initialReadPersisted = false;
  const readTranscriptSummary = vi.fn(
    async (
      summaryEnv: Parameters<typeof readSessionTranscriptSummary>[0],
      requestedSessionKey: string,
      options?: Parameters<typeof readSessionTranscriptSummary>[2],
    ) => {
      if (
        options?.afterEventCursor !== undefined &&
        params.evidence === "delayed-initial-only" &&
        !initialReadPersisted
      ) {
        initialReadPersisted = true;
        await appendToolCall(oldCallId);
        await appendToolResult(oldCallId);
      }
      const summary = await readSessionTranscriptSummary(summaryEnv, requestedSessionKey, options);
      if (options?.afterEventCursor !== undefined) {
        scopedSuccessfulReadCounts.push(summary.successfulToolCallCounts.read ?? 0);
        if (params.evidence === "delayed-success" && requests.length > 1 && !delayedReadPersisted) {
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
      normalizeLowercaseStringOrEmpty: (value: unknown) =>
        typeof value === "string" ? value.trim().toLowerCase() : "",
      normalizeModelRef: (raw: string) => parseModelRef(raw, raw.split("/")[0] ?? ""),
      readRawQaSessionStore,
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
      runAgentPrompt: async (
        _env: unknown,
        prompt: {
          message: string;
          model?: string;
          provider?: string;
          transcriptToolName?: string;
          requireSuccessfulTranscriptToolResult?: boolean;
        },
      ) => {
        const isFollowup = requests.length > 0;
        const callId = isFollowup ? newCallId : oldCallId;
        const isDelayedInitialRead = !isFollowup && params.evidence === "delayed-initial-only";
        requests.push({
          allInputText: prompt.message,
          model:
            parseModelRef(
              `${prompt.provider ?? "openai"}/${prompt.model ?? "primary-model"}`,
              prompt.provider ?? "openai",
            )?.model ?? "",
          plannedToolCallId: callId,
          plannedToolName: "read",
        });
        const actualModel =
          isFollowup && params.persistedFollowUpModel
            ? params.persistedFollowUpModel
            : { provider: prompt.provider ?? "openai", model: prompt.model ?? "primary-model" };
        await upsertSessionEntry({
          agentId: "qa",
          env: runtimeEnv,
          sessionKey,
          entry: {
            sessionId,
            updatedAt: Date.now(),
            modelProvider: actualModel.provider,
            model: actualModel.model,
          },
        });

        await appendMessage({ role: "user", content: prompt.message });
        if (
          !isDelayedInitialRead &&
          (!isFollowup ||
            (params.evidence !== "old-only" && params.evidence !== "delayed-initial-only"))
        ) {
          await appendToolCall(callId);
        }
        if (
          (!isFollowup && !isDelayedInitialRead) ||
          params.evidence === "successful" ||
          params.evidence === "failed"
        ) {
          await appendToolResult(callId, isFollowup && params.evidence === "failed");
        }
        const reply = isFollowup
          ? "The model handoff preserved the QA mission after rereading the scenario pack."
          : "The QA scenario pack mission is to verify source and docs.";
        await appendMessage({ role: "assistant", content: reply });
        const outbound = state.addOutboundMessage({
          accountId: "qa-channel",
          to: "dm:qa-operator",
          text: reply,
        });
        if (isFollowup && params.followupDelivery !== undefined) {
          if (params.followupDelivery !== "visible") {
            state.deleteMessage({ accountId: "qa-channel", messageId: outbound.id });
          }
          if (params.followupDelivery === "deleted-preview-then-visible") {
            state.addOutboundMessage({
              accountId: "qa-channel",
              to: "dm:qa-operator",
              text: reply,
            });
          }
        }
        if (
          isDelayedInitialRead &&
          prompt.transcriptToolName === "read" &&
          prompt.requireSuccessfulTranscriptToolResult === true
        ) {
          const wholeSession = await readSessionTranscriptSummary(env, sessionKey, {
            allowEmpty: true,
          });
          if ((wholeSession.successfulToolCallCounts.read ?? 0) === 0) {
            initialReadPersisted = true;
            await appendToolCall(oldCallId);
            await appendToolResult(oldCallId);
          }
        }
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
      expect(readTranscriptSummary).toHaveBeenCalledWith(
        expect.anything(),
        sessionKey,
        expect.objectContaining({ allowEmpty: true }),
      );
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
      expect(scopedSuccessfulReadCounts).toEqual([1, 0, 1]);
    },
  );

  it.each([
    ["mock-openai", "anthropic/opus"],
    ["live-frontier", "anthropic/opus"],
    ["mock-openai", "Anthropic/OPUS"],
    ["live-frontier", "Anthropic/OPUS"],
  ] as const)(
    "accepts the canonical persisted model for the requested %s alias %s",
    async (providerMode, alternateModel) => {
      const { result } = await runModelSwitchToolContinuityFlow({
        providerMode,
        evidence: "successful",
        alternateModel,
        persistedFollowUpModel: { provider: "anthropic", model: "claude-opus-5" },
      });

      expect(result.status).toBe("pass");
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
    "rejects an initial-turn read that persists after the baseline when the alternate never reads (%s)",
    async (providerMode) => {
      await expect(
        runModelSwitchToolContinuityFlow({ providerMode, evidence: "delayed-initial-only" }),
      ).rejects.toThrow(/read.*switch|switch.*read|test condition was not met/i);
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "rejects a delayed current initial read when a previous attempt already persisted a read (%s)",
    async (providerMode) => {
      await expect(
        runModelSwitchToolContinuityFlow({
          providerMode,
          evidence: "delayed-initial-only",
          previousAttemptSuccessfulRead: true,
        }),
      ).rejects.toThrow(/read.*switch|switch.*read|test condition was not met/i);
    },
  );

  it.each([
    ["mock-openai", "openai", "primary-model"],
    ["mock-openai", "anthropic", "alternate-model"],
    ["live-frontier", "openai", "primary-model"],
    ["live-frontier", "anthropic", "alternate-model"],
  ] as const)(
    "rejects successful continuity when the persisted %s run used %s/%s",
    async (providerMode, provider, model) => {
      await expect(
        runModelSwitchToolContinuityFlow({
          providerMode,
          evidence: "successful",
          persistedFollowUpModel: { provider, model },
        }),
      ).rejects.toThrow(/alternate.*model|persisted.*model|model.*switch/i);
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "rejects a deleted post-switch reply when no visible final response remains (%s)",
    async (providerMode) => {
      await expect(
        runModelSwitchToolContinuityFlow({
          providerMode,
          evidence: "successful",
          followupDelivery: "deleted-only",
        }),
      ).rejects.toThrow("test condition was not met");
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "accepts a visible post-switch response after its streaming preview was deleted (%s)",
    async (providerMode) => {
      const { result } = await runModelSwitchToolContinuityFlow({
        providerMode,
        evidence: "successful",
        followupDelivery: "deleted-preview-then-visible",
      });

      expect(result.status).toBe("pass");
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

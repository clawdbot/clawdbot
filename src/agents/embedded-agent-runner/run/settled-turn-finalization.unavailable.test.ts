import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import { useTempSessionsFixture } from "../../../config/sessions/test-helpers.js";
import {
  appendSessionTranscriptMessageByIdentity,
  readVisibleSessionTranscriptMessageEntries,
} from "../../../plugin-sdk/session-transcript-runtime.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import {
  buildEmbeddedRunnerAssistant,
  createResolvedEmbeddedRunnerModel,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { prepareTerminalWithSettledTurnFinalization } from "./settled-turn-finalization.js";
import { createSettledFinalizationTestInput } from "./settled-turn-finalization.test-support.js";

const FALLBACK =
  "The tool run finished, but no final summary was produced. I did not repeat any completed actions.";
const CATALOG_MISS =
  "Unknown tool id: MCP.github.missing. Use tools.search to find a tool, tools.describe to inspect it, then tools.call with the exact id or name.";

describe("unavailable finalization through the real core backend", () => {
  const fixture = useTempSessionsFixture("settled-finalization-unavailable-");
  let admission: ReturnType<typeof prepareSystemAgentRunAdmission>;

  beforeEach(() => {
    admission = prepareSystemAgentRunAdmission({}, "run-settled", "main", "unavailable-finalizer");
  });
  afterEach(() => admission.close());

  it.each([
    { terminal: "ok", context: "unavailable", toolFailed: false, silentExpected: false },
    {
      terminal: "failed",
      context: "openclaw-transcript",
      toolFailed: true,
      silentExpected: false,
    },
    { terminal: "ok", context: "unavailable", toolFailed: false, silentExpected: true },
  ] as const)(
    "keeps settled work terminal when finalizer capability is absent ($terminal/$context, silent: $silentExpected)",
    async ({ terminal, context, toolFailed, silentExpected }) => {
      const admittedRunContext = await admission.admit("embedded");
      const assistant = buildEmbeddedRunnerAssistant({
        provider: "openai",
        model: "gpt-5.6-luna",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "completed-command", name: "exec", arguments: {} }],
      });
      const attempt = makeEmbeddedRunnerAttempt({
        terminal:
          terminal === "ok"
            ? { kind: "ok" }
            : { kind: "failed", source: "prompt", error: new Error("The provider is overloaded") },
        sessionIdUsed: "session-settled",
        assistantTexts: [],
        currentAttemptAssistant: toolFailed ? assistant : undefined,
        currentAttemptCompletedAssistant: undefined,
        lastAssistant: toolFailed ? assistant : undefined,
        messagesSnapshot: [
          { role: "user", content: "Run the command once.", timestamp: 1 },
          assistant,
          {
            role: "toolResult",
            toolCallId: "completed-command",
            toolName: "exec",
            content: [{ type: "text", text: "completed-once" }],
            isError: toolFailed,
            timestamp: 3,
          },
        ],
        toolMetas: [
          {
            toolName: "exec",
            toolCallId: "completed-command",
            isError: toolFailed,
            replaySafe: false,
          },
        ],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        ...(toolFailed
          ? {
              codeModeEngaged: true,
              lastToolError: {
                toolName: "exec",
                error: CATALOG_MISS,
                errorCode: "INVALID_REQUEST",
              },
            }
          : {}),
      });
      attempt.settledTurnFinalizationContext =
        context === "unavailable"
          ? Object.freeze({ source: context })
          : { source: context, messages: attempt.messagesSnapshot };
      const original = JSON.stringify(attempt);
      const storePath = path.join(fs.realpathSync(fixture.sessionsDir()), "sessions.json");
      const target = {
        agentId: "main",
        sessionId: "session-settled",
        sessionKey: "agent:main:settled",
        storePath,
      };
      await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
      for (const message of attempt.messagesSnapshot) {
        await appendSessionTranscriptMessageByIdentity({ ...target, message });
      }
      const prefix = await readVisibleSessionTranscriptMessageEntries(target);
      const prefixBytes = JSON.stringify(prefix);
      const input = createSettledFinalizationTestInput(attempt, admittedRunContext);
      input.terminalBase.runParams.trigger = toolFailed ? "cron" : "user";
      input.terminalBase.runParams.sessionKey = target.sessionKey;
      Object.assign(
        input.finalization.preparedAttempt,
        createResolvedEmbeddedRunnerModel("openai", "gpt-5.6-sol"),
        {
          provider: "openai",
          modelId: "gpt-5.6-sol",
          agentId: "main",
          sessionKey: target.sessionKey,
          sessionTarget: target,
          authProfileStore: { version: 1, profiles: {} },
          resolvedApiKey: "synthetic-unused-host-key",
        },
      );
      const runAttempt = vi.fn(async () => {
        throw new Error("Completed work must not be replayed");
      });
      delete input.finalization.harness.finalizeSettledTurn;
      input.finalization.harness.runAttempt = runAttempt;
      input.finalization.preparedAttempt.silentExpected = silentExpected;

      const result = await prepareTerminalWithSettledTurnFinalization(input);

      expect("finalizeSettledTurn" in input.finalization.harness).toBe(false);
      expect(Reflect.get(input.finalization.harness, "finalizeSettledTurn")).toBeUndefined();
      expect(runAttempt).not.toHaveBeenCalled();
      expect(result.finalizationOutcome).toBe("failed");
      expect(JSON.stringify(attempt)).toBe(original);
      expect(attempt.terminal.kind).toBe(terminal);
      const transcript = await readVisibleSessionTranscriptMessageEntries(target);
      expect(JSON.stringify(transcript.slice(0, prefix.length))).toBe(prefixBytes);
      if (silentExpected) {
        expect(result.attempt).toBe(attempt);
        expect(result.prepared.payloadsWithToolMedia).not.toContainEqual(
          expect.objectContaining({ text: FALLBACK }),
        );
        expect(transcript).toHaveLength(prefix.length);
        return;
      }

      expect(result.prepared.payloadsWithToolMedia?.[0]?.isError).not.toBe(true);
      expect(result.prepared.payloadsWithToolMedia).toEqual([
        expect.objectContaining({ text: FALLBACK }),
      ]);
      expect(
        getReplyPayloadMetadata(result.prepared.payloadsWithToolMedia?.[0] ?? {}),
      ).toMatchObject({
        assistantTranscriptOwned: true,
        assistantTranscriptIdempotencyKey: "run-settled:settled-finalization-fallback",
        deliverDespiteSourceReplySuppression: true,
      });
      expect(result.attempt.currentAttemptAssistant).toMatchObject({
        provider: assistant.provider,
        model: assistant.model,
      });
      expect(transcript.slice(prefix.length)).toMatchObject([
        {
          idempotencyKey: "run-settled:settled-finalization-fallback",
          message: {
            provider: "openclaw",
            model: "delivery-mirror",
            content: [{ type: "text", text: FALLBACK }],
          },
        },
      ]);
      expect(transcript).toHaveLength(prefix.length + 1);
      if (toolFailed) {
        expect(result.prepared.failureSignal).toEqual({
          kind: "execution_denied",
          source: "tool",
          toolName: "exec",
          code: "INVALID_REQUEST",
          message: CATALOG_MISS,
          fatalForCron: true,
        });
        expect(result.prepared.terminalToolFailure).toEqual({
          source: "tool",
          toolName: "exec",
          code: "UNKNOWN_TOOL_ID",
        });
      } else {
        expect(result.prepared.failureSignal).toBeUndefined();
        expect(result.prepared.terminalToolFailure).toBeUndefined();
      }
    },
  );
});

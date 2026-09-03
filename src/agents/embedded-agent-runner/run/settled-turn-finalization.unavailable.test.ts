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

describe("unavailable finalization through the real core backend", () => {
  const fixture = useTempSessionsFixture("settled-finalization-unavailable-");
  let admission: ReturnType<typeof prepareSystemAgentRunAdmission>;

  beforeEach(() => {
    admission = prepareSystemAgentRunAdmission({}, "run-settled", "main", "unavailable-finalizer");
  });
  afterEach(() => admission.close());

  it("persists and prepares one honest fallback without replaying completed work", async () => {
    const admittedRunContext = await admission.admit("embedded");
    const assistant = buildEmbeddedRunnerAssistant({
      provider: "openai",
      model: "gpt-5.6-luna",
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "completed-command", name: "exec", arguments: {} }],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      terminal: { kind: "ok" },
      sessionIdUsed: "session-settled",
      assistantTexts: [],
      currentAttemptAssistant: undefined,
      currentAttemptCompletedAssistant: undefined,
      lastAssistant: undefined,
      messagesSnapshot: [
        { role: "user", content: "Run the command once.", timestamp: 1 },
        assistant,
        {
          role: "toolResult",
          toolCallId: "completed-command",
          toolName: "exec",
          content: [{ type: "text", text: "completed-once" }],
          isError: false,
          timestamp: 3,
        },
      ],
      toolMetas: [{ toolName: "exec", toolCallId: "completed-command", replaySafe: false }],
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      settledTurnFinalizationContext: Object.freeze({ source: "unavailable" }),
    });
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
    const input = createSettledFinalizationTestInput(attempt, admittedRunContext);
    input.terminalBase.runParams.trigger = "user";
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
    const finalize = vi.fn(async () => {
      throw new Error("Harness-owned finalization is unavailable");
    });
    const runAttempt = vi.fn(async () => {
      throw new Error("Completed work must not be replayed");
    });
    input.finalization.harness.finalizeSettledTurn = finalize;
    input.finalization.harness.runAttempt = runAttempt;

    const result = await prepareTerminalWithSettledTurnFinalization(input);

    expect(finalize).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ settledAttempt: attempt }));
    expect(runAttempt).not.toHaveBeenCalled();
    expect(result.finalizationOutcome).toBe("failed");
    expect(result.prepared.payloadsWithToolMedia).toEqual([
      expect.objectContaining({ text: FALLBACK }),
    ]);
    expect(getReplyPayloadMetadata(result.prepared.payloadsWithToolMedia?.[0] ?? {})).toMatchObject(
      {
        assistantTranscriptOwned: true,
        assistantTranscriptIdempotencyKey: "run-settled:settled-finalization-fallback",
        deliverDespiteSourceReplySuppression: true,
      },
    );
    expect(result.attempt.currentAttemptAssistant).toMatchObject({
      provider: assistant.provider,
      model: assistant.model,
    });
    expect(JSON.stringify(attempt)).toBe(original);
    expect(attempt.terminal).toEqual({ kind: "ok" });
    const transcript = await readVisibleSessionTranscriptMessageEntries(target);
    expect(transcript.slice(0, prefix.length)).toEqual(prefix);
    expect(transcript.slice(prefix.length)).toMatchObject([
      {
        message: {
          provider: "openclaw",
          model: "delivery-mirror",
          content: [{ type: "text", text: FALLBACK }],
        },
      },
    ]);
    expect(transcript).toHaveLength(prefix.length + 1);
  });
});

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeModelFallbackCfg } from "../test-helpers/model-fallback-config-fixture.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedClassifyFailoverReason,
  mockedMarkAuthProfileFailure,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

function codexClientClosedAttempt(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  return makeAttemptResult({
    assistantTexts: [],
    promptError: new Error("codex app-server client closed before turn completed"),
    promptErrorSource: "prompt",
    codexAppServerFailure: {
      kind: "client_closed_before_turn_completed",
      transport: "stdio",
      threadId: "thread-1",
      turnId: "turn-1",
      replaySafe: true,
    },
    ...overrides,
  });
}

function codexTurnCompletionIdleTimeoutAttempt(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  return makeAttemptResult({
    assistantTexts: [],
    aborted: true,
    timedOut: true,
    promptError: new Error("codex app-server turn idle timed out waiting for turn/completed"),
    promptErrorSource: "prompt",
    codexAppServerFailure: {
      kind: "turn_completion_idle_timeout",
      turnWatchTimeoutKind: "completion",
      transport: "stdio",
      threadId: "thread-1",
      turnId: "turn-1",
      replaySafe: true,
    },
    ...overrides,
  });
}

function successAttempt(): EmbeddedRunAttemptResult {
  return makeAttemptResult({
    promptError: null,
    assistantTexts: ["Done."],
  });
}

describe("runEmbeddedAgent Codex app-server recovery", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedClassifyFailoverReason.mockReturnValue(null);
  });

  it("retries a replay-safe stdio client close once", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(codexClientClosedAttempt())
      .mockResolvedValueOnce(successAttempt());

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "codex",
      model: "gpt-5.5",
      runId: "run-codex-client-close-retry",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });

  it("suppresses duplicate Codex prompt mirroring on retry", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(codexClientClosedAttempt())
      .mockResolvedValueOnce(successAttempt());

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "codex",
      model: "gpt-5.5",
      runId: "run-codex-client-close-retry-mirror",
    });

    expect(
      (
        mockedRunEmbeddedAttempt.mock.calls[1]?.[0] as {
          suppressNextUserMessagePersistence?: boolean;
        }
      ).suppressNextUserMessagePersistence,
    ).toBe(true);
  });

  it("suppresses duplicate user persistence when retrying after the inbound message was persisted", async () => {
    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (attemptParams) => {
        (
          attemptParams as {
            onUserMessagePersisted?: (message: { role: "user"; content: string }) => void;
          }
        ).onUserMessagePersisted?.({ role: "user", content: overflowBaseRunParams.prompt });
        return codexClientClosedAttempt();
      })
      .mockResolvedValueOnce(successAttempt());

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "codex",
      model: "gpt-5.5",
      runId: "run-codex-client-close-retry-persisted",
      currentMessageId: "msg-1",
    });

    expect(
      (
        mockedRunEmbeddedAttempt.mock.calls[1]?.[0] as {
          suppressNextUserMessagePersistence?: boolean;
        }
      ).suppressNextUserMessagePersistence,
    ).toBe(true);
  });

  it("does not retry websocket client closes", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      codexClientClosedAttempt({
        codexAppServerFailure: {
          kind: "client_closed_before_turn_completed",
          transport: "websocket",
          threadId: "thread-1",
          turnId: "turn-1",
          replaySafe: true,
        },
      }),
    );

    await expect(
      runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "codex",
        model: "gpt-5.5",
        runId: "run-codex-client-close-websocket",
      }),
    ).rejects.toThrow("codex app-server client closed before turn completed");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("retries a replay-safe stdio turn/completed idle timeout once", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(codexTurnCompletionIdleTimeoutAttempt())
      .mockResolvedValueOnce(successAttempt());

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "codex",
      model: "gpt-5.5",
      runId: "run-codex-turn-completion-idle-timeout",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-completion Codex turn watch timeouts", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      codexTurnCompletionIdleTimeoutAttempt({
        codexAppServerFailure: {
          kind: "turn_completion_idle_timeout",
          turnWatchTimeoutKind: "progress",
          transport: "stdio",
          threadId: "thread-1",
          turnId: "turn-1",
          replaySafe: true,
        },
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "codex",
      model: "gpt-5.5",
      runId: "run-codex-progress-idle-timeout",
    });

    expect(result.payloads?.[0]).toMatchObject({
      isError: true,
      text: "Request timed out before a response was generated. Please try again, or increase `agents.defaults.timeoutSeconds` in your config.",
    });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(mockedMarkAuthProfileFailure).not.toHaveBeenCalled();
  });

  it("returns a timeout payload after a replay-safe turn/completed idle timeout retry is exhausted", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(codexTurnCompletionIdleTimeoutAttempt())
      .mockResolvedValueOnce(codexTurnCompletionIdleTimeoutAttempt());

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "codex",
      model: "gpt-5.5",
      runId: "run-codex-turn-completion-idle-timeout-retry-exhausted",
    });

    expect(result.payloads?.[0]).toMatchObject({
      isError: true,
      text: "Request timed out before a response was generated. Please try again, or increase `agents.defaults.timeoutSeconds` in your config.",
    });
    expect(result.meta.timeoutPhase).toBe("provider");
    expect(result.meta.providerStarted).toBe(true);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedMarkAuthProfileFailure).not.toHaveBeenCalled();
  });

  it("surfaces non-stdio turn/completed idle timeouts instead of throwing", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      codexTurnCompletionIdleTimeoutAttempt({
        codexAppServerFailure: {
          kind: "turn_completion_idle_timeout",
          turnWatchTimeoutKind: "completion",
          transport: "websocket",
          threadId: "thread-1",
          turnId: "turn-1",
          replaySafe: true,
        },
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "codex",
      model: "gpt-5.5",
      runId: "run-codex-turn-completion-idle-timeout-websocket",
    });

    expect(result.payloads?.[0]).toMatchObject({
      isError: true,
      text: "Request timed out before a response was generated. Please try again, or increase `agents.defaults.timeoutSeconds` in your config.",
    });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(mockedMarkAuthProfileFailure).not.toHaveBeenCalled();
  });

  it("does not hand Codex app-server idle timeouts to model fallback", async () => {
    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      codexTurnCompletionIdleTimeoutAttempt({
        timedOut: true,
        didSendViaMessagingTool: true,
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        promptTimeoutOutcome: {
          message:
            "Codex stopped before confirming the turn was complete. Some work may already have been performed; verify the current state before retrying.",
          replayInvalid: true,
          livenessState: "abandoned",
        },
        codexAppServerFailure: {
          kind: "turn_completion_idle_timeout",
          turnWatchTimeoutKind: "completion",
          transport: "stdio",
          threadId: "thread-1",
          turnId: "turn-1",
          replaySafe: false,
          replayBlockedReason: "potential_side_effect",
        },
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "codex",
      model: "gpt-5.5",
      runId: "run-codex-turn-completion-idle-timeout-fallback",
      config: makeModelFallbackCfg({
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.5",
              fallbacks: ["anthropic/claude-opus-4-6"],
            },
          },
        },
      }),
    });

    expect(result.payloads?.[0]).toMatchObject({
      isError: true,
      text: "Codex stopped before confirming the turn was complete. Some work may already have been performed; verify the current state before retrying.",
    });
    expect(result.meta.replayInvalid).toBe(true);
    expect(result.meta.livenessState).toBe("abandoned");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(mockedMarkAuthProfileFailure).not.toHaveBeenCalled();
  });

  it("does not retry after visible assistant output", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      codexClientClosedAttempt({
        assistantTexts: ["partial answer"],
        codexAppServerFailure: {
          kind: "client_closed_before_turn_completed",
          transport: "stdio",
          threadId: "thread-1",
          turnId: "turn-1",
          replaySafe: false,
          replayBlockedReason: "assistant_output",
        },
      }),
    );

    await expect(
      runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "codex",
        model: "gpt-5.5",
        runId: "run-codex-client-close-visible-output",
      }),
    ).rejects.toThrow("codex app-server client closed before turn completed");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });
});

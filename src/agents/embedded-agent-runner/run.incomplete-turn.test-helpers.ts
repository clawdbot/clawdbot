// Shared fixtures for split incomplete-turn owner tests.
import { expect } from "vitest";
import {
  mockedLog,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  runIncompleteTurnOwnerHarness,
} from "./run.incomplete-turn.test-support.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  resolveEmptyResponseRetryInstruction,
  resolveReasoningOnlyRetryInstruction,
  resolveSettledToolTerminalContinuationInstruction,
  shouldTreatEmptyAssistantReplyAsSilent,
} from "./run/incomplete-turn-recovery.js";
import { resolveIncompleteTurnPayloadText as resolveIncompleteTurnPayloadTextCore } from "./run/incomplete-turn-resolution.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

export const REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";
export const EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";
export const SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION =
  "The previous assistant turn completed its tool calls but did not produce a user-visible answer. Continue from the current transcript and produce the final user-visible answer now. Do not repeat completed tool calls or restart from scratch.";

export const runEmbeddedAgent = runIncompleteTurnOwnerHarness;

type LastAssistant = NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
type AttemptOverrides = Parameters<typeof makeAttemptResult>[0];
type RunParams = Parameters<typeof runEmbeddedAgent>[0];
type LastAssistantFixture = Omit<LastAssistant, "content" | "stopReason" | "usage"> & {
  content: Array<Record<string, unknown>>;
  stopReason: LastAssistant["stopReason"] | "end_turn";
  usage: Partial<LastAssistant["usage"]> & { total?: number };
};

export function makeLastAssistant(overrides: Partial<LastAssistantFixture> = {}): LastAssistant {
  return {
    role: "assistant",
    stopReason: "stop",
    provider: "openai",
    model: "gpt-5.5",
    content: [],
    ...overrides,
  } as unknown as LastAssistant;
}

export function resolveIncompleteTurnPayloadText(
  params: Omit<Parameters<typeof resolveIncompleteTurnPayloadTextCore>[0], "externalAbort"> & {
    externalAbort?: boolean;
  },
): string | null {
  // Most helper tests exercise internal abort behavior; external aborts opt in
  // explicitly through params.
  return resolveIncompleteTurnPayloadTextCore({ externalAbort: false, ...params });
}

export function makeRunParams(runId: string, overrides: Partial<RunParams> = {}): RunParams {
  return {
    ...overflowBaseRunParams,
    provider: "openai",
    model: "gpt-5.5",
    runId,
    ...overrides,
  };
}

export function makeIncompleteTurnParams(
  attemptOverrides: AttemptOverrides = {},
  overrides: Partial<Omit<Parameters<typeof resolveIncompleteTurnPayloadText>[0], "attempt">> = {},
): Parameters<typeof resolveIncompleteTurnPayloadText>[0] {
  return {
    payloadCount: 0,
    aborted: false,
    timedOut: false,
    attempt: makeAttemptResult(attemptOverrides),
    ...overrides,
  };
}

export function makeReasoningRetryParams(
  attemptOverrides: AttemptOverrides = {},
  overrides: Partial<
    Omit<Parameters<typeof resolveReasoningOnlyRetryInstruction>[0], "attempt">
  > = {},
): Parameters<typeof resolveReasoningOnlyRetryInstruction>[0] {
  return {
    provider: "openai",
    modelId: "gpt-5.4",
    aborted: false,
    timedOut: false,
    attempt: makeAttemptResult(attemptOverrides),
    ...overrides,
  };
}

export function makeEmptyResponseRetryParams(
  attemptOverrides: AttemptOverrides = {},
  overrides: Partial<
    Omit<Parameters<typeof resolveEmptyResponseRetryInstruction>[0], "attempt">
  > = {},
): Parameters<typeof resolveEmptyResponseRetryInstruction>[0] {
  return {
    provider: "openai",
    modelId: "gpt-5.4",
    payloadCount: 0,
    aborted: false,
    timedOut: false,
    attempt: makeAttemptResult(attemptOverrides),
    ...overrides,
  };
}

export function makeSettledContinuationParams(
  attemptOverrides: AttemptOverrides = {},
  overrides: Partial<
    Omit<Parameters<typeof resolveSettledToolTerminalContinuationInstruction>[0], "attempt">
  > = {},
): Parameters<typeof resolveSettledToolTerminalContinuationInstruction>[0] {
  return {
    provider: "openai",
    modelId: "gpt-5.5",
    modelApi: "openai-chatgpt-responses",
    payloadCount: 0,
    aborted: false,
    timedOut: false,
    attempt: makeAttemptResult(attemptOverrides),
    ...overrides,
  };
}

export function makeSilentReplyParams(
  attempt: EmbeddedRunAttemptResult,
  overrides: Partial<
    Omit<Parameters<typeof shouldTreatEmptyAssistantReplyAsSilent>[0], "attempt">
  > = {},
): Parameters<typeof shouldTreatEmptyAssistantReplyAsSilent>[0] {
  return {
    allowEmptyAssistantReplyAsSilent: true,
    payloadCount: 0,
    aborted: false,
    timedOut: false,
    attempt,
    ...overrides,
  };
}

function warnMessages(): string[] {
  return mockedLog.warn.mock.calls.map(([message]) => String(message));
}

export function expectWarnMessageWith(text: string): void {
  expect(warnMessages().join("\n")).toContain(text);
}

export function expectNoWarnMessageWith(text: string): void {
  expect(warnMessages().join("\n")).not.toContain(text);
}

export function runAttemptCall(index: number): {
  prompt?: string;
  disableTools?: boolean;
  operation?: string;
  suppressNextUserMessagePersistence?: boolean;
  skipPreparedUserTurnMessage?: boolean;
} {
  // Continuation prompt assertions read the exact prompt passed to the runner
  // attempt rather than derived result metadata.
  const call = mockedRunEmbeddedAttempt.mock.calls[index];
  if (!call) {
    throw new Error(`Expected run embedded attempt call ${index}`);
  }
  return call[0] as {
    prompt?: string;
    disableTools?: boolean;
    operation?: string;
    suppressNextUserMessagePersistence?: boolean;
    skipPreparedUserTurnMessage?: boolean;
  };
}

export function markUserMessagePersisted(attemptParams: unknown): void {
  (
    attemptParams as {
      onUserMessagePersisted?: (message: { role: "user"; content: string }) => void;
    }
  ).onUserMessagePersisted?.({ role: "user", content: "test prompt" });
}

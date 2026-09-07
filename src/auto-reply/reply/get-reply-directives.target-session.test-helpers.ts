import { expect, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { resolveReplyDirectives } from "./get-reply-directives.js";

export function makeSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-id",
    updatedAt: Date.now(),
    ...overrides,
  };
}

export function makeTypingController() {
  return {
    onReplyStart: async () => {},
    startTypingLoop: async () => {},
    startTypingOnText: async () => {},
    refreshTypingTtl: () => {},
    isActive: () => false,
    markRunComplete: () => {},
    markDispatchIdle: () => {},
    cleanup: vi.fn(),
  };
}

export function mockCallInput(
  mock: { mock: { calls: unknown[][] } },
  index = 0,
): Record<string, unknown> {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected mock call ${index}`);
  }
  const input = call[0];
  if (!input || typeof input !== "object") {
    throw new Error(`expected mock input ${index}`);
  }
  return input as Record<string, unknown>;
}

export function expectContinueResult(
  value: Awaited<ReturnType<typeof resolveReplyDirectives>>,
  fields: Record<string, unknown>,
) {
  expect(value.kind).toBe("continue");
  if (value.kind !== "continue") {
    throw new Error(`expected continue result, got ${value.kind}`);
  }
  for (const [key, expected] of Object.entries(fields)) {
    expect(value.result[key as keyof typeof value.result]).toEqual(expected);
  }
}

export function parseInlineDirectivesForTargetSessionTest(body: string) {
  const normalized = body.trim();
  const modelDirective = normalized.match(/(?:^|\n)\/model\s+(\S+)/)?.[1];
  if (modelDirective) {
    return {
      cleaned: normalized.replace(/(?:^|\n)\/model\s+\S+/, "").trim(),
      hasThinkDirective: false,
      hasVerboseDirective: false,
      hasTraceDirective: false,
      traceLevel: undefined,
      rawTraceLevel: undefined,
      hasFastDirective: false,
      hasReasoningDirective: false,
      hasElevatedDirective: false,
      hasExecDirective: false,
      hasModelDirective: true,
      hasQueueDirective: false,
      hasStatusDirective: false,
      queueReset: false,
      thinkLevel: undefined,
      verboseLevel: undefined,
      fastMode: undefined,
      reasoningLevel: undefined,
      elevatedLevel: undefined,
      rawElevatedLevel: undefined,
      rawModelDirective: modelDirective,
    };
  }
  if (normalized === "/reasoning stream") {
    return {
      cleaned: "",
      hasThinkDirective: false,
      hasVerboseDirective: false,
      hasTraceDirective: false,
      traceLevel: undefined,
      rawTraceLevel: undefined,
      hasFastDirective: false,
      hasReasoningDirective: true,
      reasoningLevel: "stream",
      rawReasoningLevel: "stream",
      hasElevatedDirective: false,
      hasExecDirective: false,
      hasModelDirective: false,
      hasQueueDirective: false,
      hasStatusDirective: false,
      queueReset: false,
      thinkLevel: undefined,
      verboseLevel: undefined,
      fastMode: undefined,
      elevatedLevel: undefined,
      rawElevatedLevel: undefined,
      rawModelDirective: undefined,
    };
  }
  if (normalized === "/trace on") {
    return {
      cleaned: "",
      hasThinkDirective: false,
      hasVerboseDirective: false,
      hasTraceDirective: true,
      traceLevel: "on",
      rawTraceLevel: "on",
      hasFastDirective: false,
      hasReasoningDirective: false,
      hasElevatedDirective: false,
      hasExecDirective: false,
      hasModelDirective: false,
      hasQueueDirective: false,
      hasStatusDirective: false,
      queueReset: false,
      thinkLevel: undefined,
      verboseLevel: undefined,
      fastMode: undefined,
      reasoningLevel: undefined,
      elevatedLevel: undefined,
      rawElevatedLevel: undefined,
      rawModelDirective: undefined,
    };
  }
  return {
    cleaned: body,
    hasThinkDirective: false,
    hasVerboseDirective: false,
    hasTraceDirective: false,
    traceLevel: undefined,
    rawTraceLevel: undefined,
    hasFastDirective: false,
    hasReasoningDirective: false,
    hasElevatedDirective: false,
    hasExecDirective: false,
    hasModelDirective: false,
    hasQueueDirective: false,
    hasStatusDirective: false,
    queueReset: false,
    thinkLevel: undefined,
    verboseLevel: undefined,
    fastMode: undefined,
    reasoningLevel: undefined,
    elevatedLevel: undefined,
    rawElevatedLevel: undefined,
    rawModelDirective: undefined,
  };
}

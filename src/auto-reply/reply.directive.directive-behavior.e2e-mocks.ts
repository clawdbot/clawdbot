/** Shared E2E mocks for directive behavior tests that exercise reply-agent dispatch. */
import { vi, type Mock } from "vitest";

export const runEmbeddedAgentMock: Mock = vi.fn();
export const compactEmbeddedAgentSessionMock: Mock = vi.fn();
export const loadModelCatalogMock: Mock = vi.fn();
export const resolveCommandSecretRefsViaGatewayMock: Mock = vi.fn();
export const clearSessionAuthProfileOverrideMock: Mock = vi.fn();
export const resolveSessionAuthProfileOverrideMock: Mock = vi.fn();

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function normalizeReplyAgentPayload(payload: Record<string, unknown>, params: unknown) {
  const text = typeof payload.text === "string" ? payload.text : undefined;
  if (!text) {
    return payload;
  }
  const explicitReplyMatch = text.match(/\[\[\s*reply_to\s*:\s*([^\]]+?)\s*\]\]/i);
  const explicitReplyToId = explicitReplyMatch?.[1]?.trim();
  const replyToCurrentPattern = /\[\[\s*reply_to_current\s*\]\]/gi;
  const hasReplyToCurrent = replyToCurrentPattern.test(text);
  const currentMessageId = objectRecord(objectRecord(params)?.sessionCtx)?.MessageSid;
  // Directive tests encode reply targets in text markers so mocked agents can stay lightweight.
  const cleanedText = text
    .replace(replyToCurrentPattern, "")
    .replace(/\[\[\s*reply_to\s*:\s*([^\]]+?)\s*\]\]/gi, "")
    .trim();

  return {
    ...payload,
    text: cleanedText,
    ...(explicitReplyToId
      ? { replyToId: explicitReplyToId }
      : hasReplyToCurrent && typeof currentMessageId === "string"
        ? { replyToId: currentMessageId, replyToCurrent: true }
        : {}),
  };
}

async function runMockedReplyAgent(runParams: unknown, params: unknown) {
  const result = await runEmbeddedAgentMock(runParams);
  const payloadsRaw = objectRecord(result)?.payloads;
  const payloads = Array.isArray(payloadsRaw)
    ? payloadsRaw.flatMap((payload) => {
        const record = objectRecord(payload);
        return record ? [record] : [];
      })
    : [];
  const normalized = payloads.map((payload) => normalizeReplyAgentPayload(payload, params));
  if (normalized.length === 0) {
    return undefined;
  }
  return normalized.length === 1 ? normalized[0] : normalized;
}

/** Runs the mocked reply agent using the follow-up run payload from directive tests. */
export async function runDirectiveBehaviorReplyAgent(params: unknown) {
  const runParams = objectRecord(objectRecord(params)?.followupRun)?.run ?? {};
  return await runMockedReplyAgent(runParams, params);
}

export const runReplyAgentMock: Mock = vi.fn(runDirectiveBehaviorReplyAgent);

/** Runs the mocked prepared-reply path with the resolved model and elevation settings. */
export async function runDirectiveBehaviorPreparedReply(params: unknown) {
  const input = objectRecord(params) ?? {};
  const runParams = {
    provider: input.provider,
    model: input.model,
    thinkLevel: input.resolvedThinkLevel,
    reasoningLevel: input.resolvedReasoningLevel,
    bashElevated: {
      enabled: input.elevatedEnabled === true,
      allowed: input.elevatedAllowed === true,
      defaultLevel:
        typeof input.resolvedElevatedLevel === "string" ? input.resolvedElevatedLevel : "off",
      fullAccessAvailable: true,
    },
  };
  return await runMockedReplyAgent(runParams, params);
}

export const runPreparedReplyMock: Mock = vi.fn(runDirectiveBehaviorPreparedReply);

vi.mock("../agents/embedded-agent.js", () => ({
  abortEmbeddedAgentRun: vi.fn().mockReturnValue(false),
  compactEmbeddedAgentSession: (...args: unknown[]) => compactEmbeddedAgentSessionMock(...args),
  runEmbeddedAgent: (...args: unknown[]) => runEmbeddedAgentMock(...args),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  isEmbeddedAgentRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedAgentRunStreaming: vi.fn().mockReturnValue(false),
}));

vi.mock("../agents/embedded-agent.runtime.js", () => ({
  abortEmbeddedAgentRun: vi.fn().mockReturnValue(false),
  compactEmbeddedAgentSession: (...args: unknown[]) => compactEmbeddedAgentSessionMock(...args),
  runEmbeddedAgent: (...args: unknown[]) => runEmbeddedAgentMock(...args),
  resolveActiveEmbeddedRunSessionId: vi.fn().mockReturnValue(undefined),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  isEmbeddedAgentRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedAgentRunStreaming: vi.fn().mockReturnValue(false),
  waitForEmbeddedAgentRunEnd: vi.fn().mockResolvedValue(true),
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadPreparedModelCatalog: loadModelCatalogMock,
}));

vi.mock("../agents/thinking-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/thinking-runtime.js")>();
  return {
    ...actual,
    // These tests cover directive acknowledgements and persistence, not harness selection.
    // Keep each directive from loading unrelated provider-route metadata through auto selection.
    resolveEffectiveAgentRuntime: () => "openclaw",
  };
});

vi.mock("../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: (...args: unknown[]) =>
    resolveCommandSecretRefsViaGatewayMock(...args),
}));

vi.mock("../agents/auth-profiles/session-override.js", () => ({
  clearSessionAuthProfileOverride: (...args: unknown[]) =>
    clearSessionAuthProfileOverrideMock(...args),
  resolveSessionAuthProfileOverride: (...args: unknown[]) =>
    resolveSessionAuthProfileOverrideMock(...args),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => undefined,
  initializeGlobalHookRunner: vi.fn(),
  resetGlobalHookRunner: vi.fn(),
}));

vi.mock("./reply/agent-runner.runtime.js", () => ({
  runReplyAgent: (...args: unknown[]) => runReplyAgentMock(...args),
}));

vi.mock("./reply/get-reply-run.js", () => ({
  runPreparedReply: (...args: unknown[]) => runPreparedReplyMock(...args),
}));

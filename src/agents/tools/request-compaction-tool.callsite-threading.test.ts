/**
 * Tests for volitional compaction call-site threading.
 *
 * Regression coverage for the volitional compaction threading fix arc:
 * - The triggerCompaction closure passed to request_compaction tool must call
 *   compactEmbeddedAgentSession with the session's active provider/model/authProfileId
 *   — NOT the hardcoded defaults (DEFAULT_PROVIDER/DEFAULT_MODEL).
 * - When the compaction provider != persisted primary provider, authProfileId
 *   must be dropped (set to undefined) so resolveEmbeddedCompactionTarget
 *   picks the default profile for that provider.
 *
 * These tests verify the closure construction pattern used by the
 * agent-runner-execution and followup-runner triggerCompaction call sites.
 *
 * See: docs/design/continue-work-signal-v2.md
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetDiagnosticTraceContextForTest,
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import type { RequestCompactionInvocation } from "../compaction-attribution.js";
import {
  _resetGuardState,
  _resetVolitionalCounts,
  createRequestCompactionTool,
  type RequestCompactionToolOpts,
} from "./request-compaction-tool.js";

// ---------------------------------------------------------------------------
// Mock setup for compactEmbeddedAgentSession
// ---------------------------------------------------------------------------

interface CapturedCompactParams {
  sessionId: string;
  sessionKey: string;
  sessionFile: string;
  workspaceDir: string;
  messageProvider?: string;
  provider: string;
  model: string;
  authProfileId?: string;
  customInstructions?: string;
}

const REQUEST_COMPACTION_SESSION_KEY = "agent:main:discord:channel:request-compaction-trace";
const REQUEST_COMPACTION_SESSION_ID = "request-compaction-trace-session";
const REQUEST_COMPACTION_REASON = "context pressure at 85%, working state evacuated";
const ACTIVE_TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00";
const ACTIVE_TRACE_CONTEXT: DiagnosticTraceContext = {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  traceFlags: "00",
};

const capturedCompactCalls: CapturedCompactParams[] = [];
const compactEmbeddedAgentSessionMock = vi.fn(
  async (
    params: CapturedCompactParams,
  ): Promise<{ ok: boolean; compacted: boolean; reason?: string }> => {
    capturedCompactCalls.push(params);
    return { ok: true, compacted: true, reason: undefined };
  },
);

function buildRequestCompactionOpts(
  overrides: Partial<RequestCompactionToolOpts> = {},
): RequestCompactionToolOpts {
  return {
    agentSessionKey: REQUEST_COMPACTION_SESSION_KEY,
    sessionId: REQUEST_COMPACTION_SESSION_ID,
    getContextUsage: () => 0.85,
    triggerCompaction: vi.fn(async () => ({ ok: true, compacted: true })),
    ...overrides,
  };
}

async function executeRequestCompactionTool(
  opts: RequestCompactionToolOpts,
  args: Record<string, unknown> = { reason: REQUEST_COMPACTION_REASON },
): Promise<{ status: string; [key: string]: unknown }> {
  const tool = createRequestCompactionTool(opts);
  const result = await tool.execute("call-id", args);
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0]?.text ?? "{}");
}

async function drainRequestCompactionMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

vi.mock("../../agents/embedded-agent-runner/compact.queued.js", () => ({
  compactEmbeddedAgentSession: (params: CapturedCompactParams) =>
    compactEmbeddedAgentSessionMock(params),
}));

// ---------------------------------------------------------------------------
// Test helpers: recreate the closure construction pattern from call sites
// ---------------------------------------------------------------------------

/**
 * Recreates the triggerCompaction closure pattern from followup-runner.
 *
 * This is the closure that gets passed to createRequestCompactionTool.
 * Key behavior: it must use the captured provider/model from the
 * fallback dispatcher, NOT the hardcoded DEFAULT_PROVIDER/DEFAULT_MODEL.
 *
 * @param innerProvider - The provider selected by runWithModelFallback (may differ from run.provider on fallback)
 * @param innerModel - The model selected by runWithModelFallback
 * @param run - The session run parameters
 */
function buildTriggerCompactionClosure(
  innerProvider: string,
  innerModel: string,
  run: {
    sessionId: string;
    sessionKey: string;
    sessionFile: string;
    workspaceDir: string;
    messageProvider?: string;
    provider: string; // The persisted primary provider
    authProfileId?: string;
  },
): (
  request?: Pick<RequestCompactionInvocation, "customInstructions">,
) => Promise<{ ok: boolean; compacted: boolean; reason?: string }> {
  return async (request = {}) => {
    try {
      // Inline the import pattern from the call sites
      const { compactEmbeddedAgentSession } =
        await import("../../agents/embedded-agent-runner/compact.queued.js");

      // Thread the session's active provider/model through so volitional
      // compaction does not fall back to DEFAULT_PROVIDER/MODEL, which may not
      // match the session's configured credentials.
      //
      // Thread authProfileId only when the
      // inner-scope provider matches the persisted primary (the persisted
      // profile is keyed to the primary). On fallback to a different provider,
      // leave undefined so resolveEmbeddedCompactionTarget picks the default
      // profile for that provider.
      const compactionAuthProfileId =
        innerProvider === run.provider ? run.authProfileId : undefined;

      const result = await compactEmbeddedAgentSession({
        sessionId: run.sessionId ?? "",
        sessionKey: run.sessionKey,
        sessionFile: run.sessionFile ?? "",
        workspaceDir: run.workspaceDir ?? process.cwd(),
        messageProvider: run.messageProvider,
        provider: innerProvider,
        model: innerModel,
        authProfileId: compactionAuthProfileId,
        customInstructions: request.customInstructions,
      });

      return {
        ok: result.ok,
        compacted: result.compacted,
        reason: result.reason,
      };
    } catch (err) {
      return {
        ok: false,
        compacted: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Tests: Provider/Model threading
// ---------------------------------------------------------------------------

describe("call-site threading: provider/model passthrough", () => {
  beforeEach(() => {
    capturedCompactCalls.length = 0;
    compactEmbeddedAgentSessionMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes inner-scope provider/model to compactEmbeddedAgentSession (not defaults)", async () => {
    const run = {
      sessionId: "session-123",
      sessionKey: "agent:main:discord:channel:test",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/workspace",
      messageProvider: "discord",
      provider: "anthropic",
      authProfileId: "profile-abc",
    };

    // Inner provider/model from fallback dispatcher (matches primary)
    const innerProvider = "anthropic";
    const innerModel = "claude-sonnet-4-6";

    const triggerCompaction = buildTriggerCompactionClosure(innerProvider, innerModel, run);
    await triggerCompaction();

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(capturedCompactCalls[0]).toMatchObject({
      sessionId: "session-123",
      sessionKey: "agent:main:discord:channel:test",
      provider: "anthropic", // NOT DEFAULT_PROVIDER (openai)
      model: "claude-sonnet-4-6", // NOT DEFAULT_MODEL (gpt-5.4)
    });
  });

  it("passes fallback provider/model when different from primary", async () => {
    const run = {
      sessionId: "session-456",
      sessionKey: "agent:main:slack:channel:test",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/workspace",
      messageProvider: "slack",
      provider: "anthropic", // Primary provider
      authProfileId: "profile-xyz",
    };

    // Fallback to different provider (e.g., primary was rate-limited)
    const innerProvider = "openai";
    const innerModel = "gpt-5.4";

    const triggerCompaction = buildTriggerCompactionClosure(innerProvider, innerModel, run);
    await triggerCompaction();

    expect(capturedCompactCalls[0]).toMatchObject({
      provider: "openai", // Fallback provider, not primary
      model: "gpt-5.4", // Fallback model
    });
  });

  it("threads Google provider when selected", async () => {
    const run = {
      sessionId: "session-789",
      sessionKey: "agent:main:telegram:channel:test",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/workspace",
      provider: "google",
      authProfileId: "google-profile",
    };

    const innerProvider = "google";
    const innerModel = "gemini-2.5-flash";

    const triggerCompaction = buildTriggerCompactionClosure(innerProvider, innerModel, run);
    await triggerCompaction();

    expect(capturedCompactCalls[0]).toMatchObject({
      provider: "google",
      model: "gemini-2.5-flash",
    });
  });

  it("threads all session context fields", async () => {
    const run = {
      sessionId: "session-full",
      sessionKey: "agent:main:matrix:channel:room",
      sessionFile: "/data/sessions/full.jsonl",
      workspaceDir: "/home/user/workspace",
      messageProvider: "matrix",
      provider: "anthropic",
      authProfileId: "profile-full",
    };

    const triggerCompaction = buildTriggerCompactionClosure("anthropic", "claude-opus-4", run);
    await triggerCompaction();

    expect(capturedCompactCalls[0]).toEqual({
      sessionId: "session-full",
      sessionKey: "agent:main:matrix:channel:room",
      sessionFile: "/data/sessions/full.jsonl",
      workspaceDir: "/home/user/workspace",
      messageProvider: "matrix",
      provider: "anthropic",
      model: "claude-opus-4",
      authProfileId: "profile-full",
      customInstructions: undefined,
    });
  });

  it("passes request focus through to compact customInstructions", async () => {
    const run = {
      sessionId: "session-focus",
      sessionKey: "agent:main:matrix:channel:room",
      sessionFile: "/data/sessions/focus.jsonl",
      workspaceDir: "/home/user/workspace",
      messageProvider: "matrix",
      provider: "anthropic",
      authProfileId: "profile-focus",
    };

    const triggerCompaction = buildTriggerCompactionClosure("anthropic", "claude-opus-4", run);
    await triggerCompaction({
      customInstructions: "preserve the b683 fix-spec and the open path-b question",
    });

    expect(capturedCompactCalls[0]).toMatchObject({
      sessionId: "session-focus",
      customInstructions: "preserve the b683 fix-spec and the open path-b question",
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: authProfileId fallback-drop
// ---------------------------------------------------------------------------

describe("call-site threading: authProfileId fallback-drop", () => {
  beforeEach(() => {
    capturedCompactCalls.length = 0;
    compactEmbeddedAgentSessionMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes authProfileId when inner provider matches persisted primary", async () => {
    const run = {
      sessionId: "session-same",
      sessionKey: "agent:main:discord:channel:test",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/workspace",
      provider: "anthropic", // Primary
      authProfileId: "profile-anthro",
    };

    // Same provider as primary
    const triggerCompaction = buildTriggerCompactionClosure("anthropic", "claude-sonnet-4-6", run);
    await triggerCompaction();

    expect(capturedCompactCalls[0]?.authProfileId).toBe("profile-anthro");
  });

  it("drops authProfileId (undefined) when inner provider differs from primary", async () => {
    const run = {
      sessionId: "session-fallback",
      sessionKey: "agent:main:discord:channel:test",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/workspace",
      provider: "anthropic", // Primary provider
      authProfileId: "profile-anthro", // Profile keyed to primary
    };

    // Fallback to different provider
    const triggerCompaction = buildTriggerCompactionClosure("openai", "gpt-5.4", run);
    await triggerCompaction();

    expect(capturedCompactCalls[0]?.authProfileId).toBeUndefined();
  });

  it("drops authProfileId when falling back from openai to anthropic", async () => {
    const run = {
      sessionId: "session-reverse",
      sessionKey: "agent:main:slack:channel:test",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/workspace",
      provider: "openai", // Primary
      authProfileId: "profile-openai",
    };

    // Fallback to anthropic
    const triggerCompaction = buildTriggerCompactionClosure("anthropic", "claude-haiku-4", run);
    await triggerCompaction();

    expect(capturedCompactCalls[0]?.authProfileId).toBeUndefined();
  });

  it("handles undefined authProfileId in run (no profile to drop)", async () => {
    const run = {
      sessionId: "session-no-profile",
      sessionKey: "agent:main:web:channel:test",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/workspace",
      provider: "anthropic",
      authProfileId: undefined, // No profile
    };

    const triggerCompaction = buildTriggerCompactionClosure("anthropic", "claude-sonnet-4-6", run);
    await triggerCompaction();

    expect(capturedCompactCalls[0]?.authProfileId).toBeUndefined();
  });

  it("handles undefined authProfileId with fallback (no profile to drop)", async () => {
    const run = {
      sessionId: "session-no-profile-fallback",
      sessionKey: "agent:main:signal:channel:test",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/workspace",
      provider: "anthropic",
      authProfileId: undefined,
    };

    // Fallback to different provider
    const triggerCompaction = buildTriggerCompactionClosure("google", "gemini-2.5-pro", run);
    await triggerCompaction();

    expect(capturedCompactCalls[0]?.authProfileId).toBeUndefined();
  });

  it("preserves authProfileId when provider names match exactly (case-sensitive)", async () => {
    const run = {
      sessionId: "session-case",
      sessionKey: "agent:main:discord:channel:test",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/workspace",
      provider: "Anthropic", // Uppercase A
      authProfileId: "profile-case",
    };

    // Lowercase - should NOT match (providers are case-sensitive)
    const triggerCompaction = buildTriggerCompactionClosure("anthropic", "claude-sonnet-4-6", run);
    await triggerCompaction();

    // Different case = different provider = authProfileId dropped
    expect(capturedCompactCalls[0]?.authProfileId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: Error handling in triggerCompaction closure
// ---------------------------------------------------------------------------

describe("call-site threading: error handling", () => {
  beforeEach(() => {
    capturedCompactCalls.length = 0;
    compactEmbeddedAgentSessionMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns failure result when compactEmbeddedAgentSession throws", async () => {
    compactEmbeddedAgentSessionMock.mockRejectedValueOnce(new Error("Network timeout"));

    const run = {
      sessionId: "session-error",
      sessionKey: "agent:main:test:channel:test",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/workspace",
      provider: "anthropic",
    };

    const triggerCompaction = buildTriggerCompactionClosure("anthropic", "claude-sonnet-4-6", run);
    const result = await triggerCompaction();

    expect(result).toEqual({
      ok: false,
      compacted: false,
      reason: "Network timeout",
    });
  });

  it("returns failure result for non-Error throws", async () => {
    compactEmbeddedAgentSessionMock.mockRejectedValueOnce("String error");

    const run = {
      sessionId: "session-string-error",
      sessionKey: "agent:main:test:channel:test",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/workspace",
      provider: "anthropic",
    };

    const triggerCompaction = buildTriggerCompactionClosure("anthropic", "claude-sonnet-4-6", run);
    const result = await triggerCompaction();

    expect(result).toEqual({
      ok: false,
      compacted: false,
      reason: "String error",
    });
  });

  it("passes through successful result from compactEmbeddedAgentSession", async () => {
    compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      reason: undefined,
    });

    const run = {
      sessionId: "session-success",
      sessionKey: "agent:main:test:channel:test",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/workspace",
      provider: "anthropic",
    };

    const triggerCompaction = buildTriggerCompactionClosure("anthropic", "claude-sonnet-4-6", run);
    const result = await triggerCompaction();

    expect(result).toEqual({
      ok: true,
      compacted: true,
      reason: undefined,
    });
  });

  it("passes through skip result from compactEmbeddedAgentSession", async () => {
    compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: false,
      reason: "Nothing to compact",
    });

    const run = {
      sessionId: "session-skip",
      sessionKey: "agent:main:test:channel:test",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/workspace",
      provider: "anthropic",
    };

    const triggerCompaction = buildTriggerCompactionClosure("anthropic", "claude-sonnet-4-6", run);
    const result = await triggerCompaction();

    expect(result).toEqual({
      ok: true,
      compacted: false,
      reason: "Nothing to compact",
    });
  });
});

describe("request_compaction traceparent auto-pickup", () => {
  beforeEach(() => {
    _resetGuardState();
    _resetVolitionalCounts();
  });

  afterEach(() => {
    _resetGuardState();
    _resetVolitionalCounts();
    resetDiagnosticTraceContextForTest();
  });

  it("auto-picks the active runtime trace context when traceparent is omitted", async () => {
    const triggerCompaction = vi.fn<RequestCompactionToolOpts["triggerCompaction"]>(async () => ({
      ok: true,
      compacted: true,
    }));

    const result = await runWithDiagnosticTraceContext(ACTIVE_TRACE_CONTEXT, () =>
      executeRequestCompactionTool(buildRequestCompactionOpts({ triggerCompaction })),
    );
    await drainRequestCompactionMicrotasks();

    expect(triggerCompaction).toHaveBeenCalledTimes(1);
    expect(triggerCompaction.mock.calls[0]?.[0]).toMatchObject({
      traceparent: ACTIVE_TRACEPARENT,
    });
    expect(result).toMatchObject({
      status: "compaction_requested",
    });
    expect(result).not.toHaveProperty("traceparent");
  });

  it("keeps traceparent absent when no runtime trace context is active", async () => {
    const triggerCompaction = vi.fn<RequestCompactionToolOpts["triggerCompaction"]>(async () => ({
      ok: true,
      compacted: true,
    }));

    const result = await executeRequestCompactionTool(
      buildRequestCompactionOpts({ triggerCompaction }),
    );
    await drainRequestCompactionMicrotasks();

    expect(triggerCompaction).toHaveBeenCalledTimes(1);
    expect(triggerCompaction.mock.calls[0]?.[0]).not.toHaveProperty("traceparent");
    expect(result).not.toHaveProperty("traceparent");
  });
});

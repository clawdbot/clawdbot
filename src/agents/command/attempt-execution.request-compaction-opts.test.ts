/**
 * Regression coverage for spawn-init requestCompactionOpts wiring.
 *
 * `runAgentAttempt` constructs and forwards a `requestCompactionOpts` closure
 * to `runEmbeddedAgent` whenever continuation is enabled. Without this wiring,
 * `createOpenClawTools` sees no request-compaction callbacks on turn 1, so the
 * `request_compaction` tool never registers for newly spawned subagents.
 *
 * The sibling `continueWorkOpts` closure already uses the same spawn-init path.
 * These tests keep request-compaction plumbing aligned with it so subagents can
 * both schedule a next turn and reclaim context when pressure rises.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createTestPreparedRunAdmission } from "../admitted-run-context.test-support.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import { runAgentAttempt } from "./attempt-execution.js";

const runEmbeddedAgentMock = vi.hoisted(() => vi.fn());
const runCliAgentMock = vi.hoisted(() => vi.fn());
const releaseQueuedCompactionTolerantMock = vi.hoisted(() => vi.fn());
const compactEmbeddedAgentSessionMock = vi.hoisted(() => vi.fn());

vi.mock("../cli-runner.js", () => ({
  runCliAgent: runCliAgentMock,
}));

// Spy on the post-compaction release while keeping the rest of the module real
// (computeRequestCompactionContextUsage is used by the closure under test).
vi.mock("../../auto-reply/reply/agent-runner-post-compaction-release.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../auto-reply/reply/agent-runner-post-compaction-release.js")
  >("../../auto-reply/reply/agent-runner-post-compaction-release.js");
  return {
    ...actual,
    releaseQueuedCompactionTolerant: releaseQueuedCompactionTolerantMock,
  };
});

// Intercept the dynamic import inside triggerCompaction so the closure can be
// driven without performing a real compaction.
vi.mock("../embedded-agent-runner/compact.queued.js", () => ({
  compactEmbeddedAgentSession: compactEmbeddedAgentSessionMock,
}));

vi.mock("../model-selection.js", () => ({
  isCliProvider: (provider: string) =>
    provider.trim().toLowerCase() === "claude-cli" || provider.trim().toLowerCase() === "codex-cli",
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

vi.mock("../provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: () => ({}),
  resolveProviderIdForAuth: (provider: string) => provider.trim().toLowerCase(),
}));

vi.mock("../model-runtime-aliases.js", async () => {
  const actual = await vi.importActual<typeof import("../model-runtime-aliases.js")>(
    "../model-runtime-aliases.js",
  );
  return {
    ...actual,
    resolveCliRuntimeExecutionProvider: ({ provider }: { provider?: string }) => provider,
  };
});

vi.mock("../embedded-agent.js", () => ({
  runEmbeddedAgent: runEmbeddedAgentMock,
}));

function makeEmbeddedResult(): EmbeddedAgentRunResult {
  return {
    payloads: [{ text: "ok" }],
    meta: {
      durationMs: 1,
      finalAssistantVisibleText: "ok",
      agentMeta: {
        sessionId: "session-embedded",
        provider: "anthropic",
        model: "claude-sonnet-4.7",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          total: 2,
        },
      },
    },
  };
}

function makeContinuationEnabledConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        continuation: {
          enabled: true,
          maxChainLength: 200,
          defaultDelayMs: 15000,
          minDelayMs: 5000,
          maxDelayMs: 86400000,
          costCapTokens: 50000000,
          maxDelegatesPerTurn: 500,
        },
      },
    },
  } as unknown as OpenClawConfig;
}

function makeContinuationDisabledConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {},
    },
  } as unknown as OpenClawConfig;
}

describe("runAgentAttempt spawn-init requestCompactionOpts plumbing", () => {
  let tmpDir: string;
  let sessionEntry: SessionEntry;
  let sessionStore: Record<string, SessionEntry>;
  let storePath: string;
  const sessionKey = "agent:main:subagent:917-trap";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-917-trap-"));
    storePath = path.join(tmpDir, "sessions.json");
    runEmbeddedAgentMock.mockReset();
    runCliAgentMock.mockReset();
    runEmbeddedAgentMock.mockResolvedValue(makeEmbeddedResult());
    sessionEntry = {
      sessionId: "session-embedded",
      updatedAt: Date.now(),
    } as SessionEntry;
    sessionStore = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function runEmbeddedAttempt(cfg: OpenClawConfig) {
    await runAgentAttempt({
      preparedRunAdmission: createTestPreparedRunAdmission("run-test"),
      providerOverride: "anthropic",
      originalProvider: "anthropic",
      modelOverride: "claude-sonnet-4.7",
      cfg,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      lifecycleGeneration: "test-generation",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "trap-test prompt",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-917-trap",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "anthropic",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });
  }

  it("forwards requestCompactionOpts to runEmbeddedAgent when continuation.enabled=true (spawn-init / turn-1)", async () => {
    await runEmbeddedAttempt(makeContinuationEnabledConfig());

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const callArgs = runEmbeddedAgentMock.mock.calls[0]?.[0] as
      | {
          requestCompactionOpts?: {
            sessionId?: string;
            getContextUsage?: unknown;
            triggerCompaction?: unknown;
          };
        }
      | undefined;
    expect(callArgs).toBeDefined();
    // If this is undefined, request_compaction never registers in the
    // subagent's turn-1 tool list even though continuation is enabled.
    expect(callArgs?.requestCompactionOpts).toBeDefined();
    expect(typeof callArgs?.requestCompactionOpts?.getContextUsage).toBe("function");
    expect(typeof callArgs?.requestCompactionOpts?.triggerCompaction).toBe("function");
    expect(callArgs?.requestCompactionOpts?.sessionId).toBe(sessionEntry.sessionId);
  });

  it("does NOT forward requestCompactionOpts when continuation is disabled", async () => {
    await runEmbeddedAttempt(makeContinuationDisabledConfig());

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const callArgs = runEmbeddedAgentMock.mock.calls[0]?.[0] as
      | { requestCompactionOpts?: unknown }
      | undefined;
    expect(callArgs?.requestCompactionOpts).toBeUndefined();
  });

  // The request_compaction factory requires a synchronous number-or-null
  // context-usage callback. A stub-shaped closure could still register the
  // tool but produce incorrect rejection behavior at call time.
  it("requestCompactionOpts.getContextUsage returns sync number-or-null", async () => {
    await runEmbeddedAttempt(makeContinuationEnabledConfig());

    const callArgs = runEmbeddedAgentMock.mock.calls[0]?.[0] as
      | { requestCompactionOpts?: { getContextUsage: () => number | null } }
      | undefined;
    expect(callArgs?.requestCompactionOpts).toBeDefined();

    // Should be invocable without throwing and return number | null
    // (synchronous, matching computeRequestCompactionContextUsage).
    const result = callArgs?.requestCompactionOpts?.getContextUsage();
    expect(result === null || typeof result === "number").toBe(true);
  });

  // A successful turn-1 volitional compaction must run the same
  // `releaseQueuedCompactionTolerant` step used by followup turns so staged
  // `continue_delegate(mode="post-compaction")` work is dispatched.
  it("triggerCompaction releases queued post-compaction delegates after a successful compaction", async () => {
    releaseQueuedCompactionTolerantMock.mockReset();
    compactEmbeddedAgentSessionMock.mockReset();
    const compactionResult = { ok: true, compacted: true, reason: undefined };
    compactEmbeddedAgentSessionMock.mockResolvedValue(compactionResult);

    await runEmbeddedAttempt(makeContinuationEnabledConfig());
    const triggerCompaction = (
      runEmbeddedAgentMock.mock.calls[0]?.[0] as {
        requestCompactionOpts?: {
          triggerCompaction: (req: { trigger: string; runId?: string }) => Promise<unknown>;
        };
      }
    )?.requestCompactionOpts?.triggerCompaction;
    expect(typeof triggerCompaction).toBe("function");

    const result = await triggerCompaction!({ trigger: "volitional", runId: "run-917-trap" });
    expect(result).toEqual({ ok: true, compacted: true, reason: undefined });

    expect(releaseQueuedCompactionTolerantMock).toHaveBeenCalledTimes(1);
    const releaseArgs = releaseQueuedCompactionTolerantMock.mock.calls[0]?.[0] as {
      compactionResult?: unknown;
      sessionKey?: string;
      storePath?: string;
      followupRun?: { run?: { config?: unknown; sessionId?: string; workspaceDir?: string } };
    };
    expect(releaseArgs.compactionResult).toBe(compactionResult);
    expect(releaseArgs.sessionKey).toBe(sessionKey);
    expect(releaseArgs.storePath).toBe(storePath);
    // The synthesized FollowupRun carries the fields the dispatch path reads.
    expect(releaseArgs.followupRun?.run?.config).toBeDefined();
    expect(releaseArgs.followupRun?.run?.sessionId).toBe(sessionEntry.sessionId);
    expect(releaseArgs.followupRun?.run?.workspaceDir).toBe(tmpDir);
  });

  it("triggerCompaction does NOT release when compaction did not apply", async () => {
    releaseQueuedCompactionTolerantMock.mockReset();
    compactEmbeddedAgentSessionMock.mockReset();
    compactEmbeddedAgentSessionMock.mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "below-threshold",
    });

    await runEmbeddedAttempt(makeContinuationEnabledConfig());
    const triggerCompaction = (
      runEmbeddedAgentMock.mock.calls[0]?.[0] as {
        requestCompactionOpts?: {
          triggerCompaction: (req: { trigger: string }) => Promise<unknown>;
        };
      }
    )?.requestCompactionOpts?.triggerCompaction;

    await triggerCompaction!({ trigger: "volitional" });
    expect(releaseQueuedCompactionTolerantMock).not.toHaveBeenCalled();
  });
});

// Cross-layer spawn-init plumbing sentinel:
//   - turn-2+ followup-runner continueWorkOpts coverage
//   - turn-1 runAgentAttempt continueWorkOpts coverage
//   - turn-1 runAgentAttempt requestCompactionOpts coverage in this file
// Together these prevent one continuation tool from being wired while its
// sibling remains unavailable on the same code path.
describe("spawn-init continuation tool plumbing parity", () => {
  it("documents both sibling spawn-init continuation tool sites (sentinel only)", () => {
    // Intentional no-op assertion; the real coverage lives in the two
    // file-specific tests. Keeping the sibling sites named together makes
    // asymmetric plumbing regressions easier to spot.
    expect(true).toBe(true);
  });
});

/**
 * Regression-pin tests for `surface spawnResult.error in subagent-announce
 * sister rejection paths` cure (PR #889 / Closes #871 followup).
 *
 * Pins observability contracts at two rejection sites in
 * `src/agents/subagent-announce.ts`:
 *
 *   1. Chain-delegate (bracket) rejection-path (~line 1079)
 *      - log line includes `reason=<text>` with `spawnResult.error` when present
 *      - log line falls back to `reason=no reason given` when absent
 *
 *   2. Tool-delegate sister rejection-path (~line 1244)
 *      - log line includes `reason=<text>` with `spawnResult.error` when present
 *      - `markPendingDelegateFailed` summary surfaces real reason text
 *      - Both fall back to `delegation was not accepted.` when error absent
 *
 * Without these contracts pinned, a regression that reverts the rejection-
 * obs cure would re-introduce opaque `Spawn rejected (forbidden)` /
 * `Tool delegate spawn rejected (forbidden)` log lines + the hard-coded
 * `delegation was not accepted.` system-event text — leaving observers
 * unable to disambiguate which forbidden-shape fired (cap, depth, agent-id
 * policy, sandbox policy, allowAgents target-policy, cwd policy, capability
 * gate, etc).
 */
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks that DO intercept the SUT (non-barrel modules) ---

vi.mock("./subagent-announce.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readSessionMessagesAsync: vi.fn(async () => []),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (request: Record<string, unknown>) => {
    if (request.method === "chat.history") {
      return { messages: [] };
    }
    return {};
  }),
}));

vi.mock("./subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 1,
}));

vi.mock("./embedded-agent.js", () => ({
  isEmbeddedAgentRunActive: () => false,
  queueEmbeddedAgentMessage: () => false,
  waitForEmbeddedAgentRunEnd: async () => true,
}));

vi.mock("./subagent-announce.registry.runtime.js", () => ({
  countActiveDescendantRuns: () => 0,
  countPendingDescendantRuns: () => 0,
  countPendingDescendantRunsExcludingRun: () => 0,
  isSubagentSessionRunActive: () => true,
  listSubagentRunsForRequester: () => [],
  replaceSubagentRunAfterSteer: () => true,
  resolveRequesterForChildSession: () => null,
  shouldIgnorePostCompletionAnnounceForSession: () => false,
}));

vi.mock("../auto-reply/continuation/state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auto-reply/continuation/state.js")>()),
  registerContinuationTimerHandle: vi.fn(),
  retainContinuationTimerRef: vi.fn(),
  releaseContinuationTimerRef: vi.fn(),
  unregisterContinuationTimerHandle: vi.fn(),
}));

vi.mock("../auto-reply/continuation-delegate-store.js", () => ({
  consumePendingDelegates: vi.fn(() => []),
  markPendingDelegateFailed: vi.fn(),
}));

import {
  consumePendingDelegates,
  markPendingDelegateFailed,
} from "../auto-reply/continuation-delegate-store.js";
import { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } from "../config/config.js";
import { resolveStorePath } from "../config/sessions.js";
import { defaultRuntime } from "../runtime.js";
import { runSubagentAnnounceFlow } from "./subagent-announce.js";
import * as subagentSpawn from "./subagent-spawn.js";

type AnnounceFlowParams = Parameters<typeof runSubagentAnnounceFlow>[0];

function makeConfig() {
  return {
    session: { mainKey: "main", scope: "per-sender" as const },
    agents: {
      defaults: {
        continuation: {
          enabled: true,
          maxChainLength: 10,
          costCapTokens: 500_000,
          minDelayMs: 0,
          maxDelayMs: 0,
          crossSessionTargeting: "disabled" as const,
        },
      },
    },
  };
}

function writeSessionStore(data: Record<string, unknown>) {
  const storePath = resolveStorePath(undefined, { agentId: "main" });
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(data), "utf8");
}

function buildChainDelegateParams(): AnnounceFlowParams {
  return {
    childSessionKey: "agent:main:subagent:shard-reject-chain",
    childRunId: "run-reject-chain",
    requesterSessionKey: "agent:main:discord:dm:test-reject",
    requesterDisplayKey: "test-reject",
    task: "[continuation:chain-hop:1] Delegated task: do research",
    roundOneReply: "Research result.\n[[CONTINUE_DELEGATE: continue next step]]",
    timeoutMs: 30_000,
    cleanup: "delete",
    outcome: { status: "ok" as const },
    silentAnnounce: true,
    wakeOnReturn: true,
  };
}

function buildToolDelegateParams(): AnnounceFlowParams {
  return {
    childSessionKey: "agent:main:subagent:shard-reject-tool",
    childRunId: "run-reject-tool",
    requesterSessionKey: "agent:main:discord:dm:test-reject-tool",
    requesterDisplayKey: "test-reject-tool",
    task: "[continuation:chain-hop:1] Tool-delegated from sub-agent (depth 1): do research",
    roundOneReply: "Research complete.",
    timeoutMs: 30_000,
    cleanup: "delete",
    outcome: { status: "ok" as const },
    silentAnnounce: true,
    wakeOnReturn: true,
  };
}

const mockedConsumePendingDelegates = vi.mocked(consumePendingDelegates);
const mockedMarkPendingDelegateFailed = vi.mocked(markPendingDelegateFailed);

describe("subagent-announce chain-delegate rejection observability (PR #889 / #871 followup)", () => {
  let spawnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSessionStore({});
    setRuntimeConfigSnapshot(makeConfig() as any);
    spawnSpy = vi.spyOn(subagentSpawn, "spawnSubagentDirect");
    logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    mockedConsumePendingDelegates.mockReturnValue([]);
    mockedMarkPendingDelegateFailed.mockClear();
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    logSpy.mockRestore();
    clearRuntimeConfigSnapshot();
  });

  it("surfaces spawnResult.error in `reason=...` log line when error present", async () => {
    const REASON = "child cap exceeded for sandbox policy";
    spawnSpy.mockResolvedValue({ status: "forbidden", error: REASON });

    await runSubagentAnnounceFlow(buildChainDelegateParams());
    await new Promise((r) => {
      setTimeout(r, 50);
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const rejectionLogs = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((m: string) => m.includes("[subagent-chain-hop] Spawn rejected"));
    expect(rejectionLogs).toHaveLength(1);
    expect(rejectionLogs[0]).toContain("reason=" + REASON);
    expect(rejectionLogs[0]).toContain("(forbidden)");
  });

  it("falls back to `reason=no reason given` when spawnResult.error is absent", async () => {
    spawnSpy.mockResolvedValue({ status: "forbidden" });

    await runSubagentAnnounceFlow(buildChainDelegateParams());
    await new Promise((r) => {
      setTimeout(r, 50);
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const rejectionLogs = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((m: string) => m.includes("[subagent-chain-hop] Spawn rejected"));
    expect(rejectionLogs).toHaveLength(1);
    expect(rejectionLogs[0]).toContain("reason=no reason given");
  });
});

describe("subagent-announce tool-delegate rejection observability (PR #889 / #871 followup)", () => {
  let spawnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSessionStore({});
    setRuntimeConfigSnapshot(makeConfig() as any);
    spawnSpy = vi.spyOn(subagentSpawn, "spawnSubagentDirect");
    logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    mockedConsumePendingDelegates.mockReset().mockReturnValue([]);
    mockedMarkPendingDelegateFailed.mockClear();
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    logSpy.mockRestore();
    mockedConsumePendingDelegates.mockReturnValue([]);
    mockedMarkPendingDelegateFailed.mockClear();
    clearRuntimeConfigSnapshot();
  });

  it("surfaces spawnResult.error in `reason=...` log + markPendingDelegateFailed summary when present", async () => {
    const REASON = "tool-delegate depth cap exceeded";
    mockedConsumePendingDelegates.mockReturnValue([{ task: "tool task to reject" }]);
    spawnSpy.mockResolvedValue({ status: "forbidden", error: REASON });

    await runSubagentAnnounceFlow(buildToolDelegateParams());
    await new Promise((r) => {
      setTimeout(r, 50);
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);

    const rejectionLogs = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((m: string) => m.includes("[subagent-chain-hop] Tool delegate spawn rejected"));
    expect(rejectionLogs).toHaveLength(1);
    expect(rejectionLogs[0]).toContain("reason=" + REASON);
    expect(rejectionLogs[0]).toContain("(forbidden)");

    expect(mockedMarkPendingDelegateFailed).toHaveBeenCalledTimes(1);
    const summaryArg = expectDefined(
      mockedMarkPendingDelegateFailed.mock.calls.at(0)?.at(1),
      "delegate failure summary",
    );
    expect(summaryArg).toContain(REASON);
    expect(summaryArg).toContain("forbidden");
    // Reason text must replace the canned "delegation was not accepted." string
    expect(summaryArg).not.toContain("delegation was not accepted.");
    expect(
      expectDefined(
        mockedMarkPendingDelegateFailed.mock.calls.at(0)?.at(2),
        "delegate failure title",
      ),
    ).toBe("Delegate rejected");
  });

  it("falls back to `delegation was not accepted.` when spawnResult.error is absent", async () => {
    mockedConsumePendingDelegates.mockReturnValue([{ task: "tool task no reason" }]);
    spawnSpy.mockResolvedValue({ status: "forbidden" });

    await runSubagentAnnounceFlow(buildToolDelegateParams());
    await new Promise((r) => {
      setTimeout(r, 50);
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);

    const rejectionLogs = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((m: string) => m.includes("[subagent-chain-hop] Tool delegate spawn rejected"));
    expect(rejectionLogs).toHaveLength(1);
    expect(rejectionLogs[0]).toContain("reason=delegation was not accepted.");

    expect(mockedMarkPendingDelegateFailed).toHaveBeenCalledTimes(1);
    const summaryArg = expectDefined(
      mockedMarkPendingDelegateFailed.mock.calls.at(0)?.at(1),
      "delegate failure summary",
    );
    expect(summaryArg).toContain("delegation was not accepted.");
    expect(
      expectDefined(
        mockedMarkPendingDelegateFailed.mock.calls.at(0)?.at(2),
        "delegate failure title",
      ),
    ).toBe("Delegate rejected");
  });
});

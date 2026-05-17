import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnvAsync } from "../../test-utils/env.js";

vi.mock("../../config/config.js", () => {
  return {
    getRuntimeConfig: vi.fn(() => ({
      agents: {
        list: [{ id: "main" }, { id: "opus" }],
      },
      session: {},
    })),
  };
});

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadCombinedSessionStoreForGateway: vi.fn(() => ({ storePath: "(multiple)", store: {} })),
  };
});

vi.mock("../../infra/session-cost-usage.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  );
  return {
    ...actual,
    discoverAllSessions: vi.fn(async (params?: { agentId?: string }) => {
      if (params?.agentId === "main") {
        return [
          {
            sessionId: "s-main",
            sessionFile: "/tmp/agents/main/sessions/s-main.jsonl",
            mtime: 100,
            firstUserMessage: "hello",
          },
        ];
      }
      if (params?.agentId === "opus") {
        return [
          {
            sessionId: "s-opus",
            sessionFile: "/tmp/agents/opus/sessions/s-opus.jsonl",
            mtime: 200,
            firstUserMessage: "hi",
          },
        ];
      }
      if (params?.agentId === "codex") {
        return [
          {
            sessionId: "s-codex",
            sessionFile: "/tmp/agents/codex/sessions/s-codex.jsonl",
            mtime: 300,
            firstUserMessage: "disk",
          },
        ];
      }
      return [];
    }),
    loadSessionCostSummaryFromCache: vi.fn(async () => ({
      summary: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        totalCost: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 0,
      },
      cacheStatus: {
        status: "fresh",
        cachedFiles: 1,
        pendingFiles: 0,
        staleFiles: 0,
      },
    })),
    loadSessionUsageTimeSeries: vi.fn(async () => ({
      sessionId: "s-opus",
      points: [],
    })),
    loadSessionLogs: vi.fn(async () => []),
  };
});

import {
  discoverAllSessions,
  loadSessionCostSummaryFromCache,
  loadSessionLogs,
  loadSessionUsageTimeSeries,
} from "../../infra/session-cost-usage.js";
import { loadCombinedSessionStoreForGateway } from "../session-utils.js";
import { usageHandlers } from "./usage.js";

const TEST_RUNTIME_CONFIG = {
  agents: {
    list: [{ id: "main" }, { id: "opus" }],
  },
  session: {},
};

async function runSessionsUsage(
  params: Record<string, unknown>,
  config: OpenClawConfig = TEST_RUNTIME_CONFIG,
) {
  const respond = vi.fn();
  await usageHandlers["sessions.usage"]({
    respond,
    params,
    context: { getRuntimeConfig: () => config },
  } as unknown as Parameters<(typeof usageHandlers)["sessions.usage"]>[0]);
  return respond;
}

async function runSessionsUsageTimeseries(params: Record<string, unknown>) {
  const respond = vi.fn();
  await usageHandlers["sessions.usage.timeseries"]({
    respond,
    params,
    context: { getRuntimeConfig: () => TEST_RUNTIME_CONFIG },
  } as unknown as Parameters<(typeof usageHandlers)["sessions.usage.timeseries"]>[0]);
  return respond;
}

async function runSessionsUsageLogs(params: Record<string, unknown>) {
  const respond = vi.fn();
  await usageHandlers["sessions.usage.logs"]({
    respond,
    params,
    context: { getRuntimeConfig: () => TEST_RUNTIME_CONFIG },
  } as unknown as Parameters<(typeof usageHandlers)["sessions.usage.logs"]>[0]);
  return respond;
}

const BASE_USAGE_RANGE = {
  startDate: "2026-02-01",
  endDate: "2026-02-02",
  limit: 10,
} as const;

function mockCall(mockFn: ReturnType<typeof vi.fn>, callIndex = 0): ReadonlyArray<unknown> {
  const call = mockFn.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call ${callIndex + 1}`);
  }
  return call;
}

function mockArg(mockFn: ReturnType<typeof vi.fn>, callIndex: number, argIndex: number) {
  return mockCall(mockFn, callIndex)[argIndex];
}

function expectSuccessfulSessionsUsage(
  respond: ReturnType<typeof vi.fn>,
): Array<{ key: string; agentId: string }> {
  expect(respond).toHaveBeenCalledTimes(1);
  expect(mockArg(respond, 0, 0)).toBe(true);
  const result = mockArg(respond, 0, 1) as {
    sessions: Array<{ key: string; agentId: string }>;
  };
  return result.sessions;
}

describe("sessions.usage", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("defaults list-style usage queries without agentId to the default agent", async () => {
    const respond = await runSessionsUsage(BASE_USAGE_RANGE);

    expect(vi.mocked(loadCombinedSessionStoreForGateway)).toHaveBeenCalledWith(
      TEST_RUNTIME_CONFIG,
      { agentId: "main" },
    );
    expect(vi.mocked(discoverAllSessions)).toHaveBeenCalledTimes(1);
    expect((mockArg(vi.mocked(discoverAllSessions), 0, 0) as { agentId?: string }).agentId).toBe(
      "main",
    );

    const sessions = expectSuccessfulSessionsUsage(respond);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].key).toBe("agent:main:s-main");
    expect(sessions[0].agentId).toBe("main");
  });

  it("uses the requested agent for list-style usage queries", async () => {
    const respond = await runSessionsUsage({ ...BASE_USAGE_RANGE, agentId: "opus" });

    expect(vi.mocked(loadCombinedSessionStoreForGateway)).toHaveBeenCalledWith(
      TEST_RUNTIME_CONFIG,
      { agentId: "opus" },
    );
    expect(vi.mocked(discoverAllSessions)).toHaveBeenCalledTimes(1);
    expect((mockArg(vi.mocked(discoverAllSessions), 0, 0) as { agentId?: string }).agentId).toBe(
      "opus",
    );

    const sessions = expectSuccessfulSessionsUsage(respond);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].key).toBe("agent:opus:s-opus");
    expect(sessions[0].agentId).toBe("opus");
  });

  it("loads selected session summaries concurrently and reports cache refresh status", async () => {
    vi.mocked(discoverAllSessions).mockResolvedValueOnce([
      {
        sessionId: "s-a",
        sessionFile: "/tmp/agents/main/sessions/s-a.jsonl",
        mtime: 300,
      },
      {
        sessionId: "s-b",
        sessionFile: "/tmp/agents/main/sessions/s-b.jsonl",
        mtime: 200,
      },
      {
        sessionId: "s-c",
        sessionFile: "/tmp/agents/main/sessions/s-c.jsonl",
        mtime: 100,
      },
    ]);
    const pending: Array<{
      sessionId?: string;
      resolve: (value: Awaited<ReturnType<typeof loadSessionCostSummaryFromCache>>) => void;
    }> = [];
    for (let i = 0; i < 3; i += 1) {
      vi.mocked(loadSessionCostSummaryFromCache).mockImplementationOnce(
        async ({ sessionId }) =>
          await new Promise<Awaited<ReturnType<typeof loadSessionCostSummaryFromCache>>>(
            (resolve) => {
              pending.push({ sessionId, resolve });
            },
          ),
      );
    }

    const respondPromise = runSessionsUsage({ ...BASE_USAGE_RANGE, limit: 3 });
    await vi.waitFor(() =>
      expect(vi.mocked(loadSessionCostSummaryFromCache)).toHaveBeenCalledTimes(3),
    );
    for (const item of pending) {
      const tokens = item.sessionId === "s-a" ? 10 : item.sessionId === "s-b" ? 20 : 30;
      item.resolve({
        summary: {
          input: tokens,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: tokens,
          totalCost: tokens / 1000,
          inputCost: tokens / 1000,
          outputCost: 0,
          cacheReadCost: 0,
          cacheWriteCost: 0,
          missingCostEntries: 0,
        },
        cacheStatus: {
          status: item.sessionId === "s-b" ? "refreshing" : "fresh",
          cachedFiles: item.sessionId === "s-b" ? 0 : 1,
          pendingFiles: item.sessionId === "s-b" ? 1 : 0,
          staleFiles: item.sessionId === "s-b" ? 1 : 0,
        },
      });
    }

    const respond = await respondPromise;
    expect(respond).toHaveBeenCalledTimes(1);
    const result = mockArg(respond, 0, 1) as {
      cacheStatus?: { status: string };
      sessions: Array<{ sessionId: string; usage?: { totalTokens: number } | null }>;
      totals: { totalTokens: number };
    };
    expect(result.cacheStatus?.status).toBe("refreshing");
    expect(result.sessions.map((session) => session.sessionId)).toEqual(["s-a", "s-b", "s-c"]);
    expect(result.totals.totalTokens).toBe(60);
  });

  it("discovers usage for requested disk-only agents not listed in config", async () => {
    const respond = await runSessionsUsage({ ...BASE_USAGE_RANGE, agentId: "codex" });

    expect(vi.mocked(loadCombinedSessionStoreForGateway)).toHaveBeenCalledWith(
      TEST_RUNTIME_CONFIG,
      { agentId: "codex" },
    );
    expect(vi.mocked(discoverAllSessions)).toHaveBeenCalledTimes(1);
    expect((mockArg(vi.mocked(discoverAllSessions), 0, 0) as { agentId?: string }).agentId).toBe(
      "codex",
    );

    const sessions = expectSuccessfulSessionsUsage(respond);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].key).toBe("agent:codex:s-codex");
    expect(sessions[0].agentId).toBe("codex");
  });

  it("does not attach out-of-scope store entries to list-style usage results", async () => {
    vi.mocked(loadCombinedSessionStoreForGateway).mockReturnValue({
      storePath: "(multiple)",
      store: {
        "agent:main:s-opus": {
          sessionId: "s-opus",
          sessionFile: "s-opus.jsonl",
          label: "Main session",
          updatedAt: 999,
        },
      },
    });

    const respond = await runSessionsUsage({ ...BASE_USAGE_RANGE, agentId: "opus" });

    const sessions = expectSuccessfulSessionsUsage(respond);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.key).toBe("agent:opus:s-opus");
    expect(sessions[0]?.agentId).toBe("opus");
    expect(vi.mocked(loadSessionCostSummaryFromCache)).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "opus",
        sessionId: "s-opus",
      }),
    );
  });

  it("uses the requested agent for legacy specific session keys", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-usage-test-"));

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentSessionsDir = path.join(stateDir, "agents", "opus", "sessions");
        fs.mkdirSync(agentSessionsDir, { recursive: true });
        const sessionFile = path.join(agentSessionsDir, "main.jsonl");
        fs.writeFileSync(sessionFile, "", "utf-8");

        vi.mocked(loadCombinedSessionStoreForGateway).mockReturnValue({
          storePath: "(multiple)",
          store: {
            "agent:opus:main": {
              sessionId: "main",
              sessionFile: "main.jsonl",
              label: "Opus main",
              updatedAt: 999,
            },
          },
        });

        const respond = await runSessionsUsage({
          ...BASE_USAGE_RANGE,
          key: "main",
          agentId: "opus",
        });

        const sessions = expectSuccessfulSessionsUsage(respond);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.key).toBe("agent:opus:main");
        expect(vi.mocked(loadSessionCostSummaryFromCache)).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: "opus",
            sessionFile: fs.realpathSync(sessionFile),
            sessionId: "main",
          }),
        );
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps global session entries in requested-agent usage lookups", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-usage-test-"));
    const config: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "opus" }],
      },
      session: { scope: "global" },
    };

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentSessionsDir = path.join(stateDir, "agents", "opus", "sessions");
        fs.mkdirSync(agentSessionsDir, { recursive: true });
        const sessionFile = path.join(agentSessionsDir, "current.jsonl");
        fs.writeFileSync(sessionFile, "", "utf-8");

        const sessionEntry = {
          sessionId: "current",
          sessionFile: "current.jsonl",
          label: "Opus global",
          updatedAt: 999,
        };
        vi.mocked(loadCombinedSessionStoreForGateway).mockReturnValue({
          storePath: "(multiple)",
          store: {
            global: sessionEntry,
          },
        });

        const respond = await runSessionsUsage(
          {
            ...BASE_USAGE_RANGE,
            key: "global",
            agentId: "opus",
          },
          config,
        );

        const sessions = expectSuccessfulSessionsUsage(respond);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.key).toBe("global");
        expect(sessions[0]?.agentId).toBe("opus");
        expect(vi.mocked(loadSessionCostSummaryFromCache)).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: "opus",
            sessionEntry,
            sessionFile: fs.realpathSync(sessionFile),
            sessionId: "current",
          }),
        );
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not resolve specific usage keys through out-of-scope sessionId matches", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-usage-test-"));

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentSessionsDir = path.join(stateDir, "agents", "opus", "sessions");
        fs.mkdirSync(agentSessionsDir, { recursive: true });
        const sessionFile = path.join(agentSessionsDir, "shared.jsonl");
        fs.writeFileSync(sessionFile, "", "utf-8");

        vi.mocked(loadCombinedSessionStoreForGateway).mockReturnValue({
          storePath: "(multiple)",
          store: {
            "agent:main:shared": {
              sessionId: "shared",
              sessionFile: "shared.jsonl",
              label: "Main shared",
              updatedAt: 999,
            },
          },
        });

        const respond = await runSessionsUsage({
          ...BASE_USAGE_RANGE,
          key: "shared",
          agentId: "opus",
        });

        const sessions = expectSuccessfulSessionsUsage(respond);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.key).toBe("agent:opus:shared");
        expect(sessions[0]?.agentId).toBe("opus");
        expect(vi.mocked(loadSessionCostSummaryFromCache)).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: "opus",
            sessionEntry: undefined,
            sessionFile: fs.realpathSync(sessionFile),
            sessionId: "shared",
          }),
        );
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("resolves store entries by sessionId when queried via discovered agent-prefixed key", async () => {
    const storeKey = "agent:opus:slack:dm:u123";
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-usage-test-"));

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentSessionsDir = path.join(stateDir, "agents", "opus", "sessions");
        fs.mkdirSync(agentSessionsDir, { recursive: true });
        const sessionFile = path.join(agentSessionsDir, "s-opus.jsonl");
        fs.writeFileSync(sessionFile, "", "utf-8");

        // Swap the store mock for this test: the canonical key differs from the discovered key
        // but points at the same sessionId.
        vi.mocked(loadCombinedSessionStoreForGateway).mockReturnValue({
          storePath: "(multiple)",
          store: {
            [storeKey]: {
              sessionId: "s-opus",
              sessionFile: "s-opus.jsonl",
              label: "Named session",
              updatedAt: 999,
            },
          },
        });

        // Query via discovered key: agent:<id>:<sessionId>
        const respond = await runSessionsUsage({ ...BASE_USAGE_RANGE, key: "agent:opus:s-opus" });
        const sessions = expectSuccessfulSessionsUsage(respond);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.key).toBe(storeKey);
        expect(vi.mocked(loadSessionCostSummaryFromCache)).toHaveBeenCalled();
        expect(
          vi
            .mocked(loadSessionCostSummaryFromCache)
            .mock.calls.some((call) => call[0]?.agentId === "opus"),
        ).toBe(true);
        expect(
          vi
            .mocked(loadSessionCostSummaryFromCache)
            .mock.calls.every((call) => call[0]?.refreshMode === "background"),
        ).toBe(true);
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rolls up known session family ids when historical usage is requested", async () => {
    const storeKey = "agent:opus:main";
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-usage-test-"));

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentSessionsDir = path.join(stateDir, "agents", "opus", "sessions");
        fs.mkdirSync(agentSessionsDir, { recursive: true });
        fs.writeFileSync(path.join(agentSessionsDir, "current.jsonl"), "", "utf-8");
        fs.writeFileSync(
          path.join(agentSessionsDir, "old.jsonl.reset.2026-02-01T00-00-00.000Z"),
          "",
          "utf-8",
        );

        vi.mocked(loadCombinedSessionStoreForGateway).mockReturnValue({
          storePath: "(multiple)",
          store: {
            [storeKey]: {
              sessionId: "current",
              sessionFile: "current.jsonl",
              updatedAt: 1_000,
              usageFamilyKey: storeKey,
              usageFamilySessionIds: ["old", "current"],
            },
          },
        });
        vi.mocked(loadSessionCostSummaryFromCache).mockImplementation(async ({ sessionId }) => ({
          summary: {
            input: sessionId === "old" ? 10 : 20,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: sessionId === "old" ? 10 : 20,
            totalCost: sessionId === "old" ? 0.01 : 0.02,
            inputCost: sessionId === "old" ? 0.01 : 0.02,
            outputCost: 0,
            cacheReadCost: 0,
            cacheWriteCost: 0,
            missingCostEntries: 0,
            messageCounts: {
              total: 1,
              user: 1,
              assistant: 0,
              toolCalls: 0,
              toolResults: 0,
              errors: 0,
            },
          },
          cacheStatus: {
            status: "fresh",
            cachedFiles: 1,
            pendingFiles: 0,
            staleFiles: 0,
          },
        }));

        const respond = await runSessionsUsage({
          ...BASE_USAGE_RANGE,
          key: storeKey,
          groupBy: "family",
          includeHistorical: true,
        });

        expect(respond).toHaveBeenCalledTimes(1);
        expect(mockArg(respond, 0, 0)).toBe(true);
        const result = mockArg(respond, 0, 1) as {
          sessions: Array<{
            key: string;
            scope?: string;
            includedSessionIds?: string[];
            usage?: { totalTokens: number; totalCost: number; messageCounts?: { total: number } };
          }>;
          totals: { totalTokens: number; totalCost: number };
        };
        expect(result.sessions).toHaveLength(1);
        expect(result.sessions[0]?.key).toBe(storeKey);
        expect(result.sessions[0]?.scope).toBe("family");
        expect(result.sessions[0]?.includedSessionIds).toEqual(["current", "old"]);
        expect(result.sessions[0]?.usage?.totalTokens).toBe(30);
        expect(result.sessions[0]?.usage?.totalCost).toBeCloseTo(0.03);
        expect(result.sessions[0]?.usage?.messageCounts?.total).toBe(2);
        expect(result.totals.totalTokens).toBe(30);
        expect(result.totals.totalCost).toBeCloseTo(0.03);
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("prefers the deterministic store key when duplicate sessionIds exist", async () => {
    const preferredKey = "agent:opus:acp:run-dup";
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-usage-test-"));

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentSessionsDir = path.join(stateDir, "agents", "opus", "sessions");
        fs.mkdirSync(agentSessionsDir, { recursive: true });
        const sessionFile = path.join(agentSessionsDir, "run-dup.jsonl");
        fs.writeFileSync(sessionFile, "", "utf-8");

        vi.mocked(loadCombinedSessionStoreForGateway).mockReturnValue({
          storePath: "(multiple)",
          store: {
            [preferredKey]: {
              sessionId: "run-dup",
              sessionFile: "run-dup.jsonl",
              updatedAt: 1_000,
            },
            "agent:other:main": {
              sessionId: "run-dup",
              sessionFile: "run-dup.jsonl",
              updatedAt: 2_000,
            },
          },
        });

        const respond = await runSessionsUsage({
          ...BASE_USAGE_RANGE,
          key: "agent:opus:run-dup",
        });
        const sessions = expectSuccessfulSessionsUsage(respond);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.key).toBe(preferredKey);
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects traversal-style keys in specific session usage lookups", async () => {
    const respond = await runSessionsUsage({
      ...BASE_USAGE_RANGE,
      key: "agent:opus:../../etc/passwd",
    });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(mockArg(respond, 0, 0)).toBe(false);
    const error = mockArg(respond, 0, 2) as { message?: string } | undefined;
    expect(error?.message).toContain("Invalid session reference");
  });

  it("passes parsed agentId into sessions.usage.timeseries", async () => {
    await runSessionsUsageTimeseries({
      key: "agent:opus:s-opus",
    });

    expect(vi.mocked(loadSessionUsageTimeSeries)).toHaveBeenCalled();
    expect(
      (mockArg(vi.mocked(loadSessionUsageTimeSeries), 0, 0) as { agentId?: string }).agentId,
    ).toBe("opus");
  });

  it("passes parsed agentId into sessions.usage.logs", async () => {
    await runSessionsUsageLogs({
      key: "agent:opus:s-opus",
    });

    expect(vi.mocked(loadSessionLogs)).toHaveBeenCalled();
    expect((mockArg(vi.mocked(loadSessionLogs), 0, 0) as { agentId?: string }).agentId).toBe(
      "opus",
    );
  });

  it("rejects traversal-style keys in timeseries/log lookups", async () => {
    const timeseriesRespond = await runSessionsUsageTimeseries({
      key: "agent:opus:../../etc/passwd",
    });
    expect(timeseriesRespond.mock.calls).toEqual([
      [
        false,
        undefined,
        {
          code: "INVALID_REQUEST",
          message: "Invalid session key: agent:opus:../../etc/passwd",
        },
      ],
    ]);

    const logsRespond = await runSessionsUsageLogs({
      key: "agent:opus:../../etc/passwd",
    });
    expect(logsRespond.mock.calls).toEqual([
      [
        false,
        undefined,
        {
          code: "INVALID_REQUEST",
          message: "Invalid session key: agent:opus:../../etc/passwd",
        },
      ],
    ]);
  });
});

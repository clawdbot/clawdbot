// Session usage tests cover aggregate cost/token usage across configured and
// discovered agent session logs.
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

vi.mock("../../config/config.js", () => {
  return {
    getRuntimeConfig: vi.fn(() => ({
      agents: {
        list: [{ id: "main", default: true }, { id: "opus" }],
      },
      session: {},
    })),
  };
});

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadGatewaySessionEntryReadOnly: vi.fn(actual.loadGatewaySessionEntryReadOnly),
    loadCombinedSessionStoreForGatewayCore: vi.fn(() => ({
      agentIdBySessionKey: new Map(),
      durableTargets: [],
      storePath: "(multiple)",
      store: {},
    })),
  };
});

vi.mock("../../infra/session-cost-usage.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  );
  return {
    ...actual,
    resolveExistingUsageSessionFile: vi.fn(actual.resolveExistingUsageSessionFile),
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
    loadSessionCostSummariesFromCache: vi.fn(async (params: { sessions: unknown[] }) => ({
      summaries: params.sessions.map(() => ({
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
      })),
      cacheStatus: {
        status: "fresh",
        cachedFiles: params.sessions.length,
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
  loadSessionCostSummariesFromCache,
  loadSessionLogs,
  loadSessionUsageTimeSeries,
  resolveExistingUsageSessionFile,
} from "../../infra/session-cost-usage.js";
import {
  loadCombinedSessionStoreForGatewayCore,
  loadGatewaySessionEntryReadOnly,
} from "../session-utils.js";
import { testApi, usageHandlers } from "./usage.js";

const TEST_RUNTIME_CONFIG = {
  agents: {
    list: [{ id: "main", default: true }, { id: "opus" }],
  },
  session: {},
};

async function runSessionsUsage(
  params: Record<string, unknown>,
  config: OpenClawConfig = TEST_RUNTIME_CONFIG,
) {
  const respond = vi.fn();
  await expectDefined(
    usageHandlers["sessions.usage"],
    'usageHandlers["sessions.usage"] test invariant',
  )({
    respond,
    params,
    context: { getRuntimeConfig: () => config },
  } as unknown as Parameters<(typeof usageHandlers)["sessions.usage"]>[0]);
  return respond;
}

async function runSessionsUsageTimeseries(
  params: Record<string, unknown>,
  config: OpenClawConfig = TEST_RUNTIME_CONFIG,
) {
  const respond = vi.fn();
  await expectDefined(
    usageHandlers["sessions.usage.timeseries"],
    'usageHandlers["sessions.usage.timeseries"] test invariant',
  )({
    respond,
    params,
    context: { getRuntimeConfig: () => config },
  } as unknown as Parameters<(typeof usageHandlers)["sessions.usage.timeseries"]>[0]);
  return respond;
}

async function runSessionsUsageLogs(
  params: Record<string, unknown>,
  config: OpenClawConfig = TEST_RUNTIME_CONFIG,
) {
  const respond = vi.fn();
  await expectDefined(
    usageHandlers["sessions.usage.logs"],
    'usageHandlers["sessions.usage.logs"] test invariant',
  )({
    respond,
    params,
    context: { getRuntimeConfig: () => config },
  } as unknown as Parameters<(typeof usageHandlers)["sessions.usage.logs"]>[0]);
  return respond;
}

const BASE_USAGE_RANGE = {
  startDate: "2026-02-01",
  endDate: "2026-02-02",
  limit: 10,
} as const;

function mockArg(mockFn: ReturnType<typeof vi.fn>, callIndex: number, argIndex: number): unknown {
  return expectDefined(mockFn.mock.calls[callIndex], `mock call ${callIndex + 1}`)[argIndex];
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

function mockStoredSession(
  key: string,
  sessionId: string,
  options: { resolution?: "valid" | "missing" } = {},
) {
  const entry = { sessionId, updatedAt: 1_000 };
  const storePath = "/tmp/agents/opus/agent/openclaw-agent.sqlite";
  vi.mocked(loadGatewaySessionEntryReadOnly).mockReturnValueOnce({
    cfg: TEST_RUNTIME_CONFIG,
    agentId: "opus",
    canonicalKey: key,
    entry,
    legacyKey: undefined,
    store: { [key]: entry },
    storeKeys: [key],
    storePath,
  });
  vi.mocked(resolveExistingUsageSessionFile).mockReturnValueOnce(
    options.resolution === "missing" ? undefined : `sqlite:opus:${sessionId}:${storePath}`,
  );
  return entry;
}

async function withUsageState(
  run: (writeSessionFile: (fileName: string) => string) => Promise<void>,
) {
  await withOpenClawTestState({ label: "usage" }, async (state) => {
    const agentSessionsDir = state.sessionsDir("opus");
    fs.mkdirSync(agentSessionsDir, { recursive: true });
    await run((fileName) => {
      const sessionFile = path.join(agentSessionsDir, fileName);
      fs.writeFileSync(sessionFile, "", "utf-8");
      return sessionFile;
    });
  });
}

describe("sessions.usage", () => {
  beforeEach(() => {
    testApi.sessionsUsageCache.clear();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("defaults list-style usage queries without agentId to the default agent", async () => {
    const respond = await runSessionsUsage(BASE_USAGE_RANGE);

    expect(vi.mocked(loadCombinedSessionStoreForGatewayCore)).toHaveBeenCalledWith(
      TEST_RUNTIME_CONFIG,
      { agentId: "main" },
    );
    expect(vi.mocked(discoverAllSessions)).toHaveBeenCalledTimes(1);
    expect((mockArg(vi.mocked(discoverAllSessions), 0, 0) as { agentId?: string }).agentId).toBe(
      "main",
    );

    const sessions = expectSuccessfulSessionsUsage(respond);
    expect(sessions).toHaveLength(1);
    expect(expectDefined(sessions[0], "sessions[0] test invariant").key).toBe("agent:main:s-main");
    expect(expectDefined(sessions[0], "sessions[0] test invariant").agentId).toBe("main");
  });

  it("uses explicit all-agent scope for list-style usage queries", async () => {
    const respond = await runSessionsUsage({ ...BASE_USAGE_RANGE, agentScope: "all" });

    expect(vi.mocked(loadCombinedSessionStoreForGatewayCore)).toHaveBeenCalledWith(
      TEST_RUNTIME_CONFIG,
      {},
    );
    expect(vi.mocked(discoverAllSessions)).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(discoverAllSessions)
        .mock.calls.map((call) => (call[0] as { agentId?: string }).agentId),
    ).toEqual(["main", "opus"]);

    const sessions = expectSuccessfulSessionsUsage(respond);
    expect(sessions.map((session) => session.key)).toEqual([
      "agent:opus:s-opus",
      "agent:main:s-main",
    ]);
    expect(sessions.map((session) => session.agentId)).toEqual(["opus", "main"]);
  });

  it("rejects all-agent scope with a specific agent or key", async () => {
    const withAgent = await runSessionsUsage({
      ...BASE_USAGE_RANGE,
      agentId: "opus",
      agentScope: "all",
    });
    const withKey = await runSessionsUsage({
      ...BASE_USAGE_RANGE,
      key: "agent:opus:s-opus",
      agentScope: "all",
    });

    expect(mockArg(withAgent, 0, 0)).toBe(false);
    expect(mockArg(withKey, 0, 0)).toBe(false);
    expect(vi.mocked(discoverAllSessions)).not.toHaveBeenCalled();
  });

  it("uses the requested agent for list-style usage queries", async () => {
    const respond = await runSessionsUsage({ ...BASE_USAGE_RANGE, agentId: "opus" });

    expect(vi.mocked(loadCombinedSessionStoreForGatewayCore)).toHaveBeenCalledWith(
      TEST_RUNTIME_CONFIG,
      { agentId: "opus" },
    );
    expect(vi.mocked(discoverAllSessions)).toHaveBeenCalledTimes(1);
    expect((mockArg(vi.mocked(discoverAllSessions), 0, 0) as { agentId?: string }).agentId).toBe(
      "opus",
    );

    const sessions = expectSuccessfulSessionsUsage(respond);
    expect(sessions).toHaveLength(1);
    expect(expectDefined(sessions[0], "sessions[0] test invariant").key).toBe("agent:opus:s-opus");
    expect(expectDefined(sessions[0], "sessions[0] test invariant").agentId).toBe("opus");
  });

  it("returns pending cache rows with null usage while refresh runs", async () => {
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
    vi.mocked(loadSessionCostSummariesFromCache).mockImplementation(async ({ sessions }) => ({
      summaries: sessions.map((session) => {
        if (session.sessionId === "s-c") {
          return null;
        }
        const tokens = session.sessionId === "s-a" ? 10 : 20;
        return {
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
        };
      }),
      cacheStatus: {
        status: "refreshing",
        cachedFiles: 2,
        pendingFiles: 1,
        staleFiles: 1,
      },
    }));

    const respond = await runSessionsUsage({ ...BASE_USAGE_RANGE, limit: 3 });

    // All three sessions belong to one agent, so the whole cache is read exactly once.
    expect(vi.mocked(loadSessionCostSummariesFromCache)).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(1);
    const result = mockArg(respond, 0, 1) as {
      cacheStatus?: { status: string };
      sessions: Array<{ sessionId: string; usage?: { totalTokens: number } | null }>;
      totals: { totalTokens: number };
    };
    expect(result.cacheStatus?.status).toBe("refreshing");
    expect(result.sessions.map((session) => session.sessionId)).toEqual(["s-a", "s-b", "s-c"]);
    expect(result.sessions.map((session) => session.usage?.totalTokens ?? null)).toEqual([
      10,
      20,
      null,
    ]);
    expect(result.totals.totalTokens).toBe(30);
  });

  it("passes the requested timezone offset to session daily summaries", async () => {
    await runSessionsUsage({
      ...BASE_USAGE_RANGE,
      mode: "specific",
      utcOffset: "UTC-5",
    });

    expect(vi.mocked(loadSessionCostSummariesFromCache)).toHaveBeenCalledWith(
      expect.objectContaining({
        dayBucket: { mode: "utc-offset", utcOffsetMinutes: -300 },
      }),
    );
  });

  it("includes untimestamped entries only for the all-time range", async () => {
    await runSessionsUsage({ range: "all", limit: 10 });
    await runSessionsUsage({ ...BASE_USAGE_RANGE, limit: 10 });
    await runSessionsUsage({ startDate: "1970-01-01", endDate: "2026-02-02", limit: 10 });

    expect(vi.mocked(loadSessionCostSummariesFromCache)).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ includeUntimestamped: true }),
    );
    expect(vi.mocked(loadSessionCostSummariesFromCache)).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ includeUntimestamped: undefined }),
    );
    expect(vi.mocked(loadSessionCostSummariesFromCache)).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ includeUntimestamped: undefined, startMs: 0 }),
    );
  });

  it("falls back to the legacy offset when Gateway ICU does not recognize the browser timezone", async () => {
    await runSessionsUsage({
      ...BASE_USAGE_RANGE,
      mode: "specific",
      timeZone: "Newer/BrowserZone",
      utcOffset: "UTC-5",
    });

    expect(vi.mocked(loadSessionCostSummariesFromCache)).toHaveBeenCalledWith(
      expect.objectContaining({
        dayBucket: { mode: "utc-offset", utcOffsetMinutes: -300 },
      }),
    );
  });

  it("uses an IANA timezone for session range boundaries, labels, and daily summaries", async () => {
    const respond = await runSessionsUsage({
      ...BASE_USAGE_RANGE,
      startDate: "2026-10-25",
      endDate: "2026-10-25",
      mode: "specific",
      timeZone: "Europe/Vienna",
      // The zone takes precedence and changes offset during this local day.
      utcOffset: "UTC+2",
    });

    expect(vi.mocked(loadSessionCostSummariesFromCache)).toHaveBeenCalledWith(
      expect.objectContaining({
        startMs: Date.UTC(2026, 9, 24, 22),
        endMs: Date.UTC(2026, 9, 25, 23) - 1,
        dayBucket: { mode: "time-zone", timeZone: "Europe/Vienna" },
      }),
    );
    const result = mockArg(respond, 0, 1) as { startDate: string; endDate: string };
    expect(result.startDate).toBe("2026-10-25");
    expect(result.endDate).toBe("2026-10-25");
  });

  it("formats response date labels in the requested timezone offset", async () => {
    const respond = await runSessionsUsage({
      ...BASE_USAGE_RANGE,
      startDate: "2026-07-06",
      endDate: "2026-07-06",
      mode: "specific",
      utcOffset: "UTC+8",
    });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(mockArg(respond, 0, 0)).toBe(true);
    const result = mockArg(respond, 0, 1) as { startDate: string; endDate: string };
    expect(result.startDate).toBe("2026-07-06");
    expect(result.endDate).toBe("2026-07-06");
  });

  it("keeps explicit gateway response date labels on DST-short days", async () => {
    await withEnvAsync({ TZ: "America/New_York" }, async () => {
      expect(new Date("2026-03-08T05:00:00.000Z").getTimezoneOffset()).toBe(300);
      expect(new Date("2026-03-09T04:00:00.000Z").getTimezoneOffset()).toBe(240);
      const respond = await runSessionsUsage({
        ...BASE_USAGE_RANGE,
        startDate: "2026-03-08",
        endDate: "2026-03-08",
        mode: "gateway",
      });

      expect(respond).toHaveBeenCalledTimes(1);
      expect(mockArg(respond, 0, 0)).toBe(true);
      expect(vi.mocked(loadSessionCostSummariesFromCache)).toHaveBeenCalledWith(
        expect.objectContaining({
          startMs: Date.parse("2026-03-08T05:00:00.000Z"),
          endMs: Date.parse("2026-03-09T04:00:00.000Z") - 1,
          dayBucket: undefined,
        }),
      );
      const result = mockArg(respond, 0, 1) as { startDate: string; endDate: string };
      expect(result.startDate).toBe("2026-03-08");
      expect(result.endDate).toBe("2026-03-08");
    });
  });

  it("discovers usage for requested disk-only agents not listed in config", async () => {
    const respond = await runSessionsUsage({ ...BASE_USAGE_RANGE, agentId: "codex" });

    expect(vi.mocked(loadCombinedSessionStoreForGatewayCore)).toHaveBeenCalledWith(
      TEST_RUNTIME_CONFIG,
      { agentId: "codex" },
    );
    expect(vi.mocked(discoverAllSessions)).toHaveBeenCalledTimes(1);
    expect((mockArg(vi.mocked(discoverAllSessions), 0, 0) as { agentId?: string }).agentId).toBe(
      "codex",
    );

    const sessions = expectSuccessfulSessionsUsage(respond);
    expect(sessions).toHaveLength(1);
    expect(expectDefined(sessions[0], "sessions[0] test invariant").key).toBe(
      "agent:codex:s-codex",
    );
    expect(expectDefined(sessions[0], "sessions[0] test invariant").agentId).toBe("codex");
  });

  it("does not attach out-of-scope store entries to list-style usage results", async () => {
    vi.mocked(loadCombinedSessionStoreForGatewayCore).mockReturnValue({
      agentIdBySessionKey: new Map([["agent:main:s-opus", "main"]]),
      durableTargets: [],
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
    expect(vi.mocked(loadSessionCostSummariesFromCache)).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "opus",
        sessions: expect.arrayContaining([expect.objectContaining({ sessionId: "s-opus" })]),
      }),
    );
  });

  it("uses the requested agent for legacy specific session keys", async () => {
    await withUsageState(async (writeSessionFile) => {
      writeSessionFile("main.jsonl");
      mockStoredSession("agent:opus:main", "main");

      vi.mocked(loadCombinedSessionStoreForGatewayCore).mockReturnValue({
        agentIdBySessionKey: new Map([["agent:opus:main", "opus"]]),
        durableTargets: [],
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
      expect(vi.mocked(loadSessionCostSummariesFromCache)).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "opus",
          sessions: expect.arrayContaining([
            expect.objectContaining({
              sessionFile: expect.stringMatching(/^sqlite:/),
              sessionId: "main",
            }),
          ]),
        }),
      );
    });
  });

  it("keeps legacy global session entries in explicitly scoped agent usage lookups", async () => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        list: [{ id: "main" }, { id: "opus" }],
      },
      session: {},
    };

    await withUsageState(async (writeSessionFile) => {
      writeSessionFile("current.jsonl");
      mockStoredSession("global", "current");

      const sessionEntry = {
        sessionId: "current",
        sessionFile: "current.jsonl",
        label: "Opus global",
        updatedAt: 999,
      };
      vi.mocked(loadCombinedSessionStoreForGatewayCore).mockReturnValue({
        agentIdBySessionKey: new Map([["global", "opus"]]),
        durableTargets: [],
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
      expect(vi.mocked(loadSessionCostSummariesFromCache)).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "opus",
          sessions: expect.arrayContaining([
            expect.objectContaining({
              sessionFile: expect.stringMatching(/^sqlite:/),
              sessionId: "current",
            }),
          ]),
        }),
      );
    });
  });

  it("does not resolve specific usage keys through out-of-scope sessionId matches", async () => {
    await withUsageState(async (writeSessionFile) => {
      const sessionFile = writeSessionFile("shared.jsonl");

      vi.mocked(loadCombinedSessionStoreForGatewayCore).mockReturnValue({
        agentIdBySessionKey: new Map([["agent:main:shared", "main"]]),
        durableTargets: [],
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
      expect(vi.mocked(loadSessionCostSummariesFromCache)).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "opus",
          sessions: expect.arrayContaining([
            expect.objectContaining({
              sessionFile: fs.realpathSync(sessionFile),
              sessionId: "shared",
            }),
          ]),
        }),
      );
    });
  });

  it("resolves store entries by sessionId when queried via discovered agent-prefixed key", async () => {
    const storeKey = "agent:opus:slack:dm:u123";

    await withUsageState(async (writeSessionFile) => {
      writeSessionFile("s-opus.jsonl");
      mockStoredSession(storeKey, "s-opus");

      // Swap the store mock for this test: the canonical key differs from the discovered key
      // but points at the same sessionId.
      vi.mocked(loadCombinedSessionStoreForGatewayCore).mockReturnValue({
        agentIdBySessionKey: new Map([[storeKey, "opus"]]),
        durableTargets: [],
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
      expect(vi.mocked(loadSessionCostSummariesFromCache)).toHaveBeenCalled();
      expect(
        vi
          .mocked(loadSessionCostSummariesFromCache)
          .mock.calls.some((call) => call[0]?.agentId === "opus"),
      ).toBe(true);
    });
  });

  it("rolls up known session family ids when historical usage is requested", async () => {
    const storeKey = "agent:opus:main";

    await withUsageState(async (writeSessionFile) => {
      const oldSessionFile = writeSessionFile("old.jsonl.reset.2026-02-01T00-00-00.000Z");
      mockStoredSession(storeKey, "current");
      vi.mocked(discoverAllSessions).mockResolvedValueOnce([
        { sessionId: "old", sessionFile: oldSessionFile, mtime: 1_000 },
      ]);

      vi.mocked(loadCombinedSessionStoreForGatewayCore).mockReturnValue({
        agentIdBySessionKey: new Map([[storeKey, "opus"]]),
        durableTargets: [],
        storePath: "(multiple)",
        store: {
          [storeKey]: {
            sessionId: "current",
            updatedAt: 1_000,
            usageFamilyKey: storeKey,
            usageFamilySessionIds: ["old", "current"],
          },
        },
      });
      vi.mocked(loadSessionCostSummariesFromCache).mockImplementation(async ({ sessions }) => ({
        summaries: sessions.map((session) => {
          const historical = session.sessionId === "old";
          const totalTokens = historical ? 10 : 20;
          const totalCost = historical ? 0.02 : 0.01;
          const totals = {
            input: totalTokens,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens,
            totalCost,
            inputCost: totalCost,
            outputCost: 0,
            cacheReadCost: 0,
            cacheWriteCost: 0,
            missingCostEntries: 0,
          };
          return {
            ...totals,
            messageCounts: {
              total: 1,
              user: 1,
              assistant: 0,
              toolCalls: 0,
              toolResults: 0,
              errors: 0,
            },
            modelUsage: [
              {
                provider: historical ? "fixture::bedrock" : "fixture",
                model: historical ? "arn" : "bedrock::arn",
                count: 1,
                totals,
              },
            ],
            toolUsage: {
              totalCalls: 1,
              uniqueTools: 1,
              tools: [{ name: historical ? "a-second" : "z-first", count: 1 }],
            },
            dailyModelUsage: [
              {
                date: "2026-02-01",
                provider: historical ? "fixture:bedrock" : "fixture",
                model: historical ? "arn" : "bedrock:arn",
                tokens: totalTokens,
                cost: totalCost,
                count: 1,
              },
            ],
          };
        }),
        cacheStatus: {
          status: "fresh",
          cachedFiles: sessions.length,
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
          usage?: {
            totalTokens: number;
            totalCost: number;
            messageCounts?: { total: number };
            modelUsage?: Array<{ provider?: string; model?: string }>;
            dailyModelUsage?: Array<{ provider?: string; model?: string }>;
            toolUsage?: { tools: Array<{ name: string }> };
          };
        }>;
        totals: { totalTokens: number; totalCost: number };
        aggregates: {
          byModel: Array<{ provider?: string; model?: string }>;
          modelDaily: Array<{ provider?: string; model?: string }>;
        };
      };
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]?.key).toBe(storeKey);
      expect(result.sessions[0]?.scope).toBe("family");
      expect(result.sessions[0]?.includedSessionIds).toEqual(["current", "old"]);
      expect(result.sessions[0]?.usage?.totalTokens).toBe(30);
      expect(result.sessions[0]?.usage?.totalCost).toBeCloseTo(0.03);
      expect(result.sessions[0]?.usage?.messageCounts?.total).toBe(2);
      expect(result.sessions[0]?.usage?.toolUsage?.tools.map((tool) => tool.name)).toEqual([
        "z-first",
        "a-second",
      ]);
      expect(result.sessions[0]?.usage?.modelUsage).toMatchObject([
        { provider: "fixture", model: "bedrock::arn" },
        { provider: "fixture::bedrock", model: "arn" },
      ]);
      expect(result.sessions[0]?.usage?.dailyModelUsage).toMatchObject([
        { provider: "fixture", model: "bedrock:arn" },
        { provider: "fixture:bedrock", model: "arn" },
      ]);
      expect(result.aggregates.byModel).toMatchObject([
        { provider: "fixture::bedrock", model: "arn" },
        { provider: "fixture", model: "bedrock::arn" },
      ]);
      expect(result.aggregates.modelDaily).toMatchObject([
        { provider: "fixture:bedrock", model: "arn" },
        { provider: "fixture", model: "bedrock:arn" },
      ]);
      expect(result.totals.totalTokens).toBe(30);
      expect(result.totals.totalCost).toBeCloseTo(0.03);
    });
  });

  it("prefers the deterministic store key when duplicate sessionIds exist", async () => {
    const preferredKey = "agent:opus:acp:run-dup";

    await withUsageState(async (writeSessionFile) => {
      writeSessionFile("run-dup.jsonl");
      mockStoredSession(preferredKey, "run-dup");

      vi.mocked(loadCombinedSessionStoreForGatewayCore).mockReturnValue({
        agentIdBySessionKey: new Map([
          [preferredKey, "opus"],
          ["agent:other:main", "other"],
        ]),
        durableTargets: [],
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
      expect(vi.mocked(loadSessionCostSummariesFromCache)).toHaveBeenCalledWith(
        expect.objectContaining({
          sessions: expect.arrayContaining([
            expect.objectContaining({ sessionFile: expect.stringMatching(/^sqlite:/) }),
          ]),
        }),
      );
    });
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

  it("passes a canonical SQLite target into sessions.usage.timeseries", async () => {
    mockStoredSession("agent:opus:s-opus", "s-opus");
    await runSessionsUsageTimeseries({ key: "agent:opus:s-opus" });

    expect(vi.mocked(loadSessionUsageTimeSeries)).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "opus", sessionFile: expect.stringMatching(/^sqlite:/) }),
    );
  });

  it("passes a canonical SQLite target into sessions.usage.logs", async () => {
    mockStoredSession("agent:opus:s-opus", "s-opus");
    await runSessionsUsageLogs({ key: "agent:opus:s-opus" });

    expect(vi.mocked(loadSessionLogs)).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "opus", sessionFile: expect.stringMatching(/^sqlite:/) }),
    );
  });

  it("loads bare-key usage details through the persisted fixed-store owner", async () => {
    await withOpenClawTestState({ label: "usage-fixed-store-owner" }, async (state) => {
      const storePath = state.statePath("shared-sessions.sqlite");
      const config: OpenClawConfig = {
        session: { store: storePath, scope: "global" },
        agents: {
          ownership: "explicit",
          list: [{ id: "ops" }, { id: "research" }],
          defaults: { sessionStore: { agentId: "ops" } },
        },
      };
      const entry = { sessionId: "s-ops", updatedAt: 1_000 };
      vi.mocked(loadGatewaySessionEntryReadOnly).mockReturnValueOnce({
        cfg: config,
        agentId: "ops",
        canonicalKey: "global",
        entry,
        legacyKey: undefined,
        store: { global: entry },
        storeKeys: ["global"],
        storePath,
      });

      const respond = await runSessionsUsageTimeseries({ key: "global" }, config);

      expect(mockArg(respond, 0, 0)).toBe(true);
      expect(vi.mocked(loadGatewaySessionEntryReadOnly)).toHaveBeenCalledWith("global", {
        agentId: "ops",
      });
      expect(vi.mocked(loadSessionUsageTimeSeries)).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "ops" }),
      );
    });
  });

  it("preserves JSONL detail lookup for storeless sessions", async () => {
    await withUsageState(async (writeSessionFile) => {
      const sessionFile = writeSessionFile("storeless.jsonl");
      const canonicalSessionFile = fs.realpathSync(sessionFile);
      await runSessionsUsageTimeseries({ key: "agent:opus:storeless" });
      expect(vi.mocked(loadSessionUsageTimeSeries)).toHaveBeenCalledWith(
        expect.objectContaining({ sessionFile: canonicalSessionFile, sessionEntry: undefined }),
      );
    });
  });

  it("fails closed when a canonical stored target no longer matches", async () => {
    const key = "agent:opus:stale";
    mockStoredSession(key, "stale", { resolution: "missing" });
    const respond = await runSessionsUsageTimeseries({ key });
    expect(mockArg(respond, 0, 0)).toBe(false);
    expect(vi.mocked(loadSessionUsageTimeSeries)).not.toHaveBeenCalled();
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

  it("aggregate totals include all sessions even when limit restricts the page (#76496)", async () => {
    // Override discoverAllSessions to return 3 sessions with distinct costs
    vi.mocked(discoverAllSessions)
      .mockResolvedValueOnce([
        { sessionId: "s-a", sessionFile: "/tmp/agents/main/sessions/s-a.jsonl", mtime: 300 },
        { sessionId: "s-b", sessionFile: "/tmp/agents/main/sessions/s-b.jsonl", mtime: 200 },
        { sessionId: "s-c", sessionFile: "/tmp/agents/main/sessions/s-c.jsonl", mtime: 100 },
        // Discovered because its mtime is past range start, but all of its
        // activity got filtered out of the requested window.
        { sessionId: "s-late", sessionFile: "/tmp/agents/main/sessions/s-late.jsonl", mtime: 50 },
      ])
      .mockResolvedValueOnce([]); // second agent (opus) — no extra sessions

    const buildUsage = (sessionId?: string) => {
      const emptyUsage = {
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
      };
      if (sessionId === "s-late") {
        // Range-filtered summary with no in-range entries: zero counts, no
        // first/last activity. Must not count as an active session.
        return emptyUsage;
      }
      const cost = sessionId === "s-a" ? 0.08 : sessionId === "s-b" ? 0.04 : 0.02;
      const tokens = sessionId === "s-a" ? 15 : sessionId === "s-b" ? 10 : 5;
      // Longest span lives on the oldest active session (s-c), which the limit
      // hides from the page, so the aggregate must not depend on visible rows.
      // durationMs is derived from first/last activity during summary merge.
      const lastActivity = sessionId === "s-c" ? 90_000 : 5_000;
      return {
        ...emptyUsage,
        input: tokens,
        totalTokens: tokens,
        totalCost: cost,
        firstActivity: 0,
        lastActivity,
      };
    };
    vi.mocked(loadSessionCostSummariesFromCache).mockImplementation(async ({ sessions }) => {
      return {
        summaries: sessions.map((session) => buildUsage(session.sessionId)),
        cacheStatus: {
          status: "fresh",
          cachedFiles: sessions.length,
          pendingFiles: 0,
          staleFiles: 0,
        },
      };
    });

    const respond = await runSessionsUsage({
      ...BASE_USAGE_RANGE,
      agentScope: "all",
      limit: 1,
    });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(mockArg(respond, 0, 0)).toBe(true);
    const result = mockArg(respond, 0, 1) as {
      sessions: Array<{ key: string }>;
      totals: { totalCost: number; totalTokens: number };
      aggregates: { sessionCount?: number; longestSessionDurationMs?: number };
    };

    // Only the most-recent session (s-a, mtime=300) appears in the page
    expect(result.sessions).toHaveLength(1);
    expect(expectDefined(result.sessions[0], "result.sessions[0] test invariant").key).toContain(
      "s-a",
    );
    // Both visible and hidden sessions load through the same batched per-agent
    // cache read, so the whole cache is parsed once per agent, not once per session.
    expect(vi.mocked(loadSessionCostSummariesFromCache)).toHaveBeenCalledTimes(1);

    // But aggregate totals must include all 3 sessions (0.08 + 0.04 + 0.02 = 0.14)
    expect(result.totals.totalCost).toBeCloseTo(0.14);
    expect(result.totals.totalTokens).toBe(30);
    // Aggregate session stats also cover hidden rows: the longest duration
    // belongs to s-c, which the page dropped. s-late was discovered but has no
    // in-range activity, so it stays out of the count.
    expect(result.aggregates.sessionCount).toBe(3);
    expect(result.aggregates.longestSessionDurationMs).toBe(90_000);
  });
});

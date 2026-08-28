import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionsUsageResult } from "../../shared/usage-types.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { withTempDir } from "../../test-utils/temp-dir.js";

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({
    agents: { list: [{ id: "main", default: true }, { id: "opus" }] },
    session: {},
  })),
}));

vi.mock("../session-utils.js", async () => ({
  ...(await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js")),
  loadCombinedSessionStoreForGatewayCore: vi.fn(),
}));

vi.mock("../../infra/session-cost-usage.js", async () => ({
  ...(await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  )),
  discoverAllSessions: vi.fn(),
  loadSessionCostSummariesFromCache: vi.fn(),
}));

import { createEmptyCostUsageTotals } from "../../infra/session-cost-usage-totals.js";
import {
  discoverAllSessions,
  loadSessionCostSummariesFromCache,
} from "../../infra/session-cost-usage.js";
import { loadCombinedSessionStoreForGatewayCore } from "../session-utils.js";
import { testApi, usageHandlers } from "./usage.js";

type StoredFixture = { key: string; agentId: string; entry: SessionEntry };
type DiscoveredFixture = { agentId: string; sessionId: string };

const mainRow: StoredFixture = {
  key: "agent:main:telegram:dm",
  agentId: "main",
  entry: { sessionId: "shared", updatedAt: 10, label: "Main chat" },
};
const opusRow: StoredFixture = {
  key: "agent:opus:slack:dm",
  agentId: "opus",
  entry: { sessionId: "shared", updatedAt: 20, label: "Opus chat" },
};
const sharedDiscovery: DiscoveredFixture[] = [
  { agentId: "main", sessionId: "shared" },
  { agentId: "opus", sessionId: "shared" },
];
const defaultConfig: OpenClawConfig = {
  agents: { list: [{ id: "main", default: true }, { id: "opus" }] },
};
const explicitConfig: OpenClawConfig = {
  agents: { ownership: "explicit", list: [{ id: "main" }, { id: "opus" }] },
};

async function queryUsage(options: {
  rows: StoredFixture[];
  discovered?: DiscoveredFixture[];
  newestAgent?: string;
  config?: OpenClawConfig;
  params?: Record<string, unknown>;
}): Promise<SessionsUsageResult> {
  return await withTempDir("usage-owner-", async (stateDir) =>
    withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const fixtureStore = {
        durableTargets: [],
        storePath: "(multiple)",
        store: Object.fromEntries(options.rows.map(({ key, entry }) => [key, entry])),
        agentIdBySessionKey: new Map(options.rows.map(({ key, agentId }) => [key, agentId])),
      };
      vi.mocked(loadCombinedSessionStoreForGatewayCore).mockReturnValue(fixtureStore);
      vi.mocked(discoverAllSessions).mockImplementation(async (params) => {
        const agentId = params?.agentId ?? "main";
        return (options.discovered ?? sharedDiscovery)
          .filter((session) => session.agentId === agentId)
          .map(({ sessionId }) => ({
            sessionId,
            sessionFile: path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`),
            mtime: agentId === options.newestAgent ? 200 : 100,
          }));
      });
      vi.mocked(loadSessionCostSummariesFromCache).mockImplementation(async (params) => ({
        summaries: params.sessions.map(() => ({
          ...createEmptyCostUsageTotals(),
          totalTokens: params.agentId === "main" ? 10 : 100,
          totalCost: params.agentId === "main" ? 0.01 : 0.1,
        })),
        cacheStatus: {
          status: "fresh",
          cachedFiles: params.sessions.length,
          pendingFiles: 0,
          staleFiles: 0,
        },
      }));
      const respond = vi.fn();
      try {
        await expectDefined(
          usageHandlers["sessions.usage"],
          "sessions.usage handler",
        )({
          respond,
          params: { range: "all", limit: 10, agentScope: "all", ...options.params },
          context: { getRuntimeConfig: () => options.config ?? defaultConfig },
        } as unknown as Parameters<(typeof usageHandlers)["sessions.usage"]>[0]);
        expect(respond).toHaveBeenCalledTimes(1);
        const call = expectDefined(respond.mock.calls[0], "sessions.usage response");
        expect(call[0]).toBe(true);
        return call[1] as SessionsUsageResult;
      } finally {
        await cleanupSessionStateForTest({ stateDir });
      }
    }),
  );
}

function expectRows(
  result: SessionsUsageResult,
  expected: Array<{ key: string; agentId: string; label?: string; tokens: number }>,
) {
  const rows = result.sessions.map(({ key, agentId, label, usage }) => ({
    key,
    agentId,
    label,
    tokens: usage?.totalTokens,
  }));
  expect(rows.toSorted((a, b) => a.key.localeCompare(b.key))).toEqual(
    expected.toSorted((a, b) => a.key.localeCompare(b.key)),
  );
  expect(result.totals.totalTokens).toBe(expected.reduce((sum, row) => sum + row.tokens, 0));
  for (const agentId of new Set(expected.map((row) => row.agentId))) {
    expect(
      result.aggregates.byAgent.find((agent) => agent.agentId === agentId)?.totals.totalTokens,
    ).toBe(
      expected.filter((row) => row.agentId === agentId).reduce((sum, row) => sum + row.tokens, 0),
    );
  }
}

describe("sessions.usage owner attribution", () => {
  beforeEach(() => {
    testApi.sessionsUsageCache.clear();
    vi.clearAllMocks();
  });

  it.each(["main", "opus"])(
    "retains independent same-id transcripts when %s discovery is newest",
    async (newestAgent) => {
      const result = await queryUsage({ rows: [mainRow], newestAgent });
      expectRows(result, [
        { key: mainRow.key, agentId: "main", label: "Main chat", tokens: 10 },
        { key: "agent:opus:shared", agentId: "opus", label: undefined, tokens: 100 },
      ]);
    },
  );

  it.each(["main", "opus"])(
    "keeps both durable owners sharing an id when %s discovery is newest",
    async (newestAgent) => {
      const result = await queryUsage({ rows: [mainRow, opusRow], newestAgent });
      expectRows(result, [
        { key: mainRow.key, agentId: "main", label: "Main chat", tokens: 10 },
        { key: opusRow.key, agentId: "opus", label: "Opus chat", tokens: 100 },
      ]);
    },
  );

  it("keeps canonical alias selection within a single owner", async () => {
    const result = await queryUsage({
      rows: [
        mainRow,
        {
          ...mainRow,
          key: "agent:main:shared",
          entry: { ...mainRow.entry, updatedAt: 1, label: "Canonical main" },
        },
      ],
      discovered: [{ agentId: "main", sessionId: "shared" }],
    });
    expectRows(result, [
      { key: "agent:main:shared", agentId: "main", label: "Canonical main", tokens: 10 },
    ]);
  });

  it("does not substitute another agent's transcript for an absent owner transcript", async () => {
    const result = await queryUsage({
      rows: [mainRow],
      discovered: [{ agentId: "opus", sessionId: "shared" }],
    });
    expectRows(result, [
      { key: "agent:opus:shared", agentId: "opus", label: undefined, tokens: 100 },
    ]);
  });

  it.each([
    { name: "nondefault global owner", key: "global", config: defaultConfig },
    { name: "global owner without a default", key: "global", config: explicitConfig },
    { name: "unknown owner without a default", key: "unknown", config: explicitConfig },
  ])("uses the projected source owner for $name", async ({ key, config }) => {
    const result = await queryUsage({
      rows: [{ ...opusRow, key }],
      newestAgent: "main",
      config,
    });
    expectRows(result, [
      { key: "agent:main:shared", agentId: "main", label: undefined, tokens: 10 },
      { key, agentId: "opus", label: "Opus chat", tokens: 100 },
    ]);
  });

  it("keeps the explicitly requested global owner without an ambient default", async () => {
    const result = await queryUsage({
      rows: [{ ...opusRow, key: "global" }],
      config: explicitConfig,
      params: { agentScope: undefined, agentId: "opus" },
    });
    expectRows(result, [{ key: "global", agentId: "opus", label: "Opus chat", tokens: 100 }]);
  });

  it("suppresses historical instances only within their owner's family", async () => {
    const result = await queryUsage({
      rows: [
        {
          ...mainRow,
          entry: { ...mainRow.entry, sessionId: "current", usageFamilySessionIds: ["shared"] },
        },
      ],
      discovered: [{ agentId: "main", sessionId: "current" }, ...sharedDiscovery],
      params: { groupBy: "family" },
    });
    expectRows(result, [
      { key: mainRow.key, agentId: "main", label: "Main chat", tokens: 20 },
      { key: "agent:opus:shared", agentId: "opus", label: undefined, tokens: 100 },
    ]);
    expect(
      result.sessions.find((session) => session.key === mainRow.key)?.includedSessionIds,
    ).toEqual(["current", "shared"]);
  });
});

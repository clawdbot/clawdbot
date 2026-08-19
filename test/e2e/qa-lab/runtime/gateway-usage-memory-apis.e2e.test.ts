import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../../src/config/config.js";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../../../../src/config/sessions/legacy-sqlite-marker.js";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../../../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { READ_SCOPE } from "../../../../src/gateway/method-scopes.js";
import { clearModelAuthStatusUsageCache } from "../../../../src/gateway/server-methods/models-auth-status-usage-cache.js";
import { testApi as usageTestApi } from "../../../../src/gateway/server-methods/usage.js";
import { startGatewayServer } from "../../../../src/gateway/server.js";
import { loadGatewaySessionEntryReadOnly } from "../../../../src/gateway/session-utils.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
} from "../../../../src/gateway/test-helpers.e2e.js";
import type { UsageSummary } from "../../../../src/infra/provider-usage.types.js";
import { refreshCostUsageCacheForAgent } from "../../../../src/infra/session-cost-usage-aggregation.js";
import { readSessionCostUsageRollupRows } from "../../../../src/infra/session-cost-usage-cache.sqlite.js";
import type { CostUsageSummary } from "../../../../src/infra/session-cost-usage.js";
import type { SessionUsageTimeSeries } from "../../../../src/shared/session-usage-timeseries-types.js";
import type { SessionsUsageResult } from "../../../../src/shared/usage-types.js";
import { resolveOpenClawAgentSqlitePath } from "../../../../src/state/openclaw-agent-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../../src/test-utils/openclaw-test-state.js";

const TEST_TIMEOUT_MS = 90_000;
const FIXTURE_DATE = "2026-08-03";
const FIXTURE_STARTED_AT = Date.parse(`${FIXTURE_DATE}T10:00:00.000Z`);
const FIXTURE_ENDED_AT = FIXTURE_STARTED_AT + 60_000;
const FIXTURE_SESSION_ID = "gateway-usage-memory-fixture";
const FIXTURE_SESSION_KEY = "agent:main:qa:gateway-usage-memory";
const FIXTURE_USAGE = {
  input: 100,
  output: 20,
  cacheRead: 5,
  cacheWrite: 0,
  totalTokens: 125,
  cost: {
    input: 0.002,
    output: 0.001,
    cacheRead: 0.0001,
    cacheWrite: 0,
    total: 0.0031,
  },
} as const;

type SessionLogsResult = {
  logs: Array<{
    timestamp: number;
    role: "user" | "assistant" | "tool" | "toolResult";
    content: string;
    tokens?: number;
    cost?: number;
  }>;
};

type DoctorMemoryStatus = {
  agentId: string;
  embedding: {
    ok: boolean;
    checked?: boolean;
    error?: string;
  };
};

async function seedCompletedUsageSession(state: OpenClawTestState): Promise<{
  databasePath: string;
}> {
  const agentId = "main";
  const storePath = path.join(state.sessionsDir(agentId), "sessions.json");
  const databasePath = resolveOpenClawAgentSqlitePath({ agentId, env: state.env });
  const sessionFile = formatSqliteSessionFileMarker({
    agentId,
    sessionId: FIXTURE_SESSION_ID,
    storePath,
  });
  const scope = {
    agentId,
    env: state.env,
    sessionId: FIXTURE_SESSION_ID,
    sessionKey: FIXTURE_SESSION_KEY,
    storePath,
  };

  await upsertSessionEntryCore(scope, {
    sessionId: FIXTURE_SESSION_ID,
    sessionFile,
    startedAt: FIXTURE_STARTED_AT,
    updatedAt: FIXTURE_STARTED_AT,
    status: "running",
  });
  const turn = await persistSessionTranscriptTurn(scope, {
    expectedSessionId: FIXTURE_SESSION_ID,
    messages: [
      {
        now: FIXTURE_STARTED_AT,
        message: {
          role: "user",
          content: "Summarize the deterministic gateway usage fixture.",
        },
      },
      {
        now: FIXTURE_STARTED_AT + 1_000,
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.6-luna",
          content: [{ type: "text", text: "Deterministic usage fixture complete." }],
          usage: FIXTURE_USAGE,
        },
      },
    ],
    touchSessionEntry: false,
    updateMode: "none",
  });
  expect(turn.appendedCount).toBe(2);

  await upsertSessionEntryCore(scope, {
    sessionId: FIXTURE_SESSION_ID,
    sessionFile,
    startedAt: FIXTURE_STARTED_AT,
    endedAt: FIXTURE_ENDED_AT,
    runtimeMs: FIXTURE_ENDED_AT - FIXTURE_STARTED_AT,
    updatedAt: FIXTURE_ENDED_AT,
    status: "done",
  });

  await expect(
    refreshCostUsageCacheForAgent({
      agentId,
      databasePath,
      sessionFiles: [sessionFile],
    }),
  ).resolves.toBe("refreshed");

  return { databasePath };
}

describe("gateway usage and memory APIs", () => {
  it(
    "projects deterministic usage and explicit memory readiness over authenticated WebSocket RPCs",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const port = await getGatewayE2ePortBlock();
      const token = `gateway-usage-memory-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}`;
      const state = await createOpenClawTestState({
        label: "gateway-usage-memory-apis",
        env: {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        },
      });
      const config = {
        agents: {
          defaults: { workspace: state.workspaceDir },
          list: [{ id: "main", default: true, workspace: state.workspaceDir }],
        },
        gateway: {
          mode: "local",
          port,
          bind: "loopback",
          auth: { mode: "token", token },
          controlUi: { enabled: false },
        },
        plugins: { enabled: false },
        session: {
          store: path.join(state.stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
        },
      } satisfies OpenClawConfig;
      let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
      let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;

      try {
        await state.writeConfig(config);
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearModelAuthStatusUsageCache();
        usageTestApi.costUsageCache.clear();
        usageTestApi.sessionsUsageCache.clear();

        const { databasePath } = await seedCompletedUsageSession(state);
        const databaseStats = await fs.stat(databasePath);
        expect(databaseStats.isFile()).toBe(true);
        const rollupRows = readSessionCostUsageRollupRows("main", databasePath);
        expect(rollupRows).toHaveLength(1);
        expect(parseSqliteSessionFileMarker(rollupRows[0]?.key)).toEqual({
          agentId: "main",
          sessionId: FIXTURE_SESSION_ID,
          storePath: databasePath,
        });
        const storedSession = loadGatewaySessionEntryReadOnly(FIXTURE_SESSION_KEY);
        expect(storedSession).toMatchObject({
          entry: {
            sessionId: FIXTURE_SESSION_ID,
          },
          storePath: path.join(state.sessionsDir("main"), "sessions.json"),
        });
        expect(storedSession.entry).not.toHaveProperty("sessionFile");

        server = await startGatewayServer(port, {
          bind: "loopback",
          auth: { mode: "token", token },
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        client = await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token,
          scopes: [READ_SCOPE],
          clientDisplayName: "gateway-usage-memory-qa",
          requestTimeoutMs: 30_000,
          timeoutMs: 30_000,
        });

        const usageStatus = await client.request<UsageSummary>("usage.status", {});
        expect(usageStatus.updatedAt).toEqual(expect.any(Number));
        expect(usageStatus.providers).toEqual([]);

        const cost = await client.request<CostUsageSummary>("usage.cost", {
          agentId: "main",
          startDate: FIXTURE_DATE,
          endDate: FIXTURE_DATE,
          mode: "utc",
        });
        expect(cost.daily).toEqual([
          expect.objectContaining({
            date: FIXTURE_DATE,
            totalTokens: FIXTURE_USAGE.totalTokens,
            totalCost: expect.closeTo(FIXTURE_USAGE.cost.total, 8),
          }),
        ]);
        expect(cost.totals).toMatchObject({
          input: FIXTURE_USAGE.input,
          output: FIXTURE_USAGE.output,
          cacheRead: FIXTURE_USAGE.cacheRead,
          totalTokens: FIXTURE_USAGE.totalTokens,
          totalCost: expect.closeTo(FIXTURE_USAGE.cost.total, 8),
        });

        const sessions = await client.request<SessionsUsageResult>("sessions.usage", {
          agentId: "main",
          startDate: FIXTURE_DATE,
          endDate: FIXTURE_DATE,
          mode: "utc",
          limit: 10,
        });
        expect(sessions.aggregates.sessionCount).toBe(1);
        expect(sessions.totals.totalTokens).toBe(FIXTURE_USAGE.totalTokens);
        expect(sessions.totals.totalCost).toBeCloseTo(FIXTURE_USAGE.cost.total, 8);
        expect(sessions.sessions).toEqual([
          expect.objectContaining({
            key: FIXTURE_SESSION_KEY,
            sessionId: FIXTURE_SESSION_ID,
            usage: expect.objectContaining({
              totalTokens: FIXTURE_USAGE.totalTokens,
              totalCost: expect.closeTo(FIXTURE_USAGE.cost.total, 8),
            }),
          }),
        ]);

        const timeseries = await client.request<SessionUsageTimeSeries>(
          "sessions.usage.timeseries",
          { key: FIXTURE_SESSION_KEY },
        );
        expect(timeseries).toEqual({
          sessionId: FIXTURE_SESSION_ID,
          points: [
            expect.objectContaining({
              timestamp: FIXTURE_STARTED_AT + 1_000,
              input: FIXTURE_USAGE.input,
              output: FIXTURE_USAGE.output,
              cacheRead: FIXTURE_USAGE.cacheRead,
              totalTokens: FIXTURE_USAGE.totalTokens,
              cumulativeTokens: FIXTURE_USAGE.totalTokens,
              cost: expect.closeTo(FIXTURE_USAGE.cost.total, 8),
              cumulativeCost: expect.closeTo(FIXTURE_USAGE.cost.total, 8),
            }),
          ],
        });

        const logs = await client.request<SessionLogsResult>("sessions.usage.logs", {
          key: FIXTURE_SESSION_KEY,
          limit: 10,
        });
        expect(logs.logs).toEqual([
          expect.objectContaining({
            timestamp: FIXTURE_STARTED_AT,
            role: "user",
            content: "Summarize the deterministic gateway usage fixture.",
          }),
          expect.objectContaining({
            timestamp: FIXTURE_STARTED_AT + 1_000,
            role: "assistant",
            content: "Deterministic usage fixture complete.",
            tokens: FIXTURE_USAGE.totalTokens,
            cost: expect.closeTo(FIXTURE_USAGE.cost.total, 8),
          }),
        ]);

        await expect(
          client.request("sessions.usage.timeseries", {
            key: "agent:main:qa:missing-usage-session",
          }),
        ).rejects.toMatchObject({
          gatewayCode: "INVALID_REQUEST",
          message: expect.stringContaining("Invalid session key"),
        });

        const memoryStatus = await client.request<DoctorMemoryStatus>("doctor.memory.status", {});
        expect(memoryStatus).toEqual({
          agentId: "main",
          embedding: {
            ok: false,
            error: "memory plugin unavailable",
          },
        });
      } finally {
        if (client) {
          await disconnectGatewayClient(client);
        }
        await server?.close({ reason: "gateway usage and memory QA complete" });
        clearModelAuthStatusUsageCache();
        usageTestApi.costUsageCache.clear();
        usageTestApi.sessionsUsageCache.clear();
        await state.cleanup();
      }
    },
  );
});

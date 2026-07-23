// Ordinary runtime tests receive config after load-time roster migration.
// Keep raw-roster contract tests explicitly unmocked instead of reintroducing a production fallback.
import { vi } from "vitest";
import { resolveSqliteTargetFromSessionStorePath } from "../src/config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";

function materializeRoster(cfg: OpenClawConfig): OpenClawConfig {
  const agents = cfg.agents ?? {};
  const rawEntries = agents.entries;
  let roster: Array<{ id: string; default?: boolean } & Record<string, unknown>>;
  if (rawEntries !== undefined) {
    if (
      !rawEntries ||
      typeof rawEntries !== "object" ||
      Array.isArray(rawEntries) ||
      Object.values(rawEntries).some(
        (entry) => !entry || typeof entry !== "object" || Array.isArray(entry),
      )
    ) {
      return cfg;
    }
    roster = Object.entries(rawEntries).map(([id, entry]) => ({ id, ...entry }));
  } else if (agents.list !== undefined) {
    if (
      !Array.isArray(agents.list) ||
      agents.list.some(
        (entry) =>
          !entry ||
          typeof entry !== "object" ||
          Array.isArray(entry) ||
          typeof entry.id !== "string",
      )
    ) {
      return cfg;
    }
    roster = agents.list.map((entry) => ({ ...entry }));
  } else {
    roster = [];
  }

  if (roster.length === 0) {
    return { ...cfg, agents: { ...agents, entries: { main: { default: true } } } };
  }
  const defaultId = roster.find((entry) => entry.default === true)?.id ?? roster[0]!.id;
  const entries = Object.fromEntries(
    roster.map((entry) => {
      const { id, ...rest } = entry;
      const next = { ...rest };
      if (id === defaultId) {
        next.default = true;
      } else {
        delete next.default;
      }
      return [id, next];
    }),
  );
  const { list: _legacyList, ...rest } = agents;
  return { ...cfg, agents: { ...rest, entries } };
}

vi.mock("../src/agents/agent-scope-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/agent-scope-config.js")>();

  return {
    ...actual,
    listAgentEntriesWithSource: (cfg: OpenClawConfig) =>
      actual.listAgentEntriesWithSource(materializeRoster(cfg)),
    listAgentEntries: (cfg: OpenClawConfig) => actual.listAgentEntries(materializeRoster(cfg)),
    listAgentIds: (cfg: OpenClawConfig) => actual.listAgentIds(materializeRoster(cfg)),
    resolveDefaultAgentId: (cfg: OpenClawConfig) =>
      actual.resolveDefaultAgentId(materializeRoster(cfg)),
    resolveAgentEntry: (cfg: OpenClawConfig, agentId: string) =>
      actual.resolveAgentEntry(materializeRoster(cfg), agentId),
    resolveAgentConfig: (cfg: OpenClawConfig, agentId: string) =>
      actual.resolveAgentConfig(materializeRoster(cfg), agentId),
    resolveAgentContextLimits: (cfg: OpenClawConfig | undefined, agentId?: string | null) =>
      actual.resolveAgentContextLimits(cfg ? materializeRoster(cfg) : cfg, agentId),
    resolveAgentWorkspaceDir: (cfg: OpenClawConfig, agentId: string, env?: NodeJS.ProcessEnv) =>
      actual.resolveAgentWorkspaceDir(materializeRoster(cfg), agentId, env),
    resolveAgentDir: (cfg: OpenClawConfig, agentId: string, env?: NodeJS.ProcessEnv) =>
      actual.resolveAgentDir(materializeRoster(cfg), agentId, env),
    resolveDefaultAgentDir: (cfg: OpenClawConfig, env?: NodeJS.ProcessEnv) =>
      actual.resolveDefaultAgentDir(materializeRoster(cfg), env),
  };
});

// Runtime callers reach SQLite after routing has selected an agent. Ordinary unit
// fixtures historically omit that prepared owner, so model the routed main owner here.
vi.mock("../src/config/sessions/session-accessor.sqlite-scope.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/config/sessions/session-accessor.sqlite-scope.js")
    >();
  const withAgentId = <T extends { agentId?: string; sessionKey?: string }>(scope: T): T =>
    scope.agentId ||
    scope.sessionKey?.startsWith("agent:") ||
    ("storePath" in scope &&
      typeof scope.storePath === "string" &&
      resolveSqliteTargetFromSessionStorePath(scope.storePath).agentId)
      ? scope
      : ({ ...scope, agentId: "main" } as T);
  return {
    ...actual,
    resolveSqliteScope: (scope: Parameters<typeof actual.resolveSqliteScope>[0]) =>
      actual.resolveSqliteScope(withAgentId(scope)),
    resolveSqliteReadScope: (scope: Parameters<typeof actual.resolveSqliteReadScope>[0]) =>
      actual.resolveSqliteReadScope(withAgentId(scope)),
    resolveSqliteStoreScope: (
      storePath: string,
      options?: Parameters<typeof actual.resolveSqliteStoreScope>[1],
    ) => {
      const storeAgentId = resolveSqliteTargetFromSessionStorePath(storePath).agentId;
      return actual.resolveSqliteStoreScope(
        storePath,
        options?.agentId || storeAgentId ? options : { agentId: "main" },
      );
    },
    resolveSqliteTranscriptScope: (
      scope: Parameters<typeof actual.resolveSqliteTranscriptScope>[0],
    ) => actual.resolveSqliteTranscriptScope(withAgentId(scope)),
    resolveSqliteTranscriptReadScope: (
      scope: Parameters<typeof actual.resolveSqliteTranscriptReadScope>[0],
    ) => actual.resolveSqliteTranscriptReadScope(withAgentId(scope)),
  };
});

// Extension cache fixtures historically resolve the shipped single-agent store before
// threading the routed owner through their public SDK call.
vi.mock("openclaw/plugin-sdk/session-store-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/plugin-sdk/session-store-runtime.js")>();
  return {
    ...actual,
    resolveStorePath: (
      store: Parameters<typeof actual.resolveStorePath>[0],
      options?: Parameters<typeof actual.resolveStorePath>[1],
    ) =>
      actual.resolveStorePath(store, options?.agentId ? options : { ...options, agentId: "main" }),
  };
});

// Usage tests historically model the shipped single-agent layout without threading
// the routed owner through every public entrypoint. Production callers resolve it first.
vi.mock("../src/infra/session-cost-usage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/infra/session-cost-usage.js")>();
  const withAgentId = <T extends object>(params: T | undefined): T & { agentId: string } =>
    ({
      ...params,
      agentId:
        typeof (params as { agentId?: unknown } | undefined)?.agentId === "string"
          ? (params as { agentId: string }).agentId
          : "main",
    }) as T & { agentId: string };
  return {
    ...actual,
    resolveExistingUsageSessionFile: (
      params: Parameters<typeof actual.resolveExistingUsageSessionFile>[0],
    ) => actual.resolveExistingUsageSessionFile(withAgentId(params)),
    loadCostUsageSummary: (params?: Parameters<typeof actual.loadCostUsageSummary>[0]) =>
      actual.loadCostUsageSummary(withAgentId(params)),
    loadCostUsageSummaryFromCache: (
      params: Parameters<typeof actual.loadCostUsageSummaryFromCache>[0],
    ) => actual.loadCostUsageSummaryFromCache(withAgentId(params)),
    loadSessionCostSummariesFromCache: (
      params: Parameters<typeof actual.loadSessionCostSummariesFromCache>[0],
    ) => actual.loadSessionCostSummariesFromCache(withAgentId(params)),
    discoverAllSessions: (params?: Parameters<typeof actual.discoverAllSessions>[0]) =>
      actual.discoverAllSessions(withAgentId(params)),
    loadSessionCostSummary: (params: Parameters<typeof actual.loadSessionCostSummary>[0]) =>
      actual.loadSessionCostSummary(withAgentId(params)),
    loadSessionUsageTimeSeries: (params: Parameters<typeof actual.loadSessionUsageTimeSeries>[0]) =>
      actual.loadSessionUsageTimeSeries(withAgentId(params)),
    loadSessionLogs: (params: Parameters<typeof actual.loadSessionLogs>[0]) =>
      actual.loadSessionLogs(withAgentId(params)),
  };
});

// Direct trajectory-store fixtures predate explicit per-agent database ownership.
vi.mock("../src/trajectory/runtime-store.sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/trajectory/runtime-store.sqlite.js")>();
  const withAgentId = <T extends { agentId?: string }>(scope: T): T =>
    scope.agentId ? scope : ({ ...scope, agentId: "main" } as T);
  return {
    ...actual,
    appendSqliteTrajectoryRuntimeEvents: (
      scope: Parameters<typeof actual.appendSqliteTrajectoryRuntimeEvents>[0],
      events: Parameters<typeof actual.appendSqliteTrajectoryRuntimeEvents>[1],
    ) => actual.appendSqliteTrajectoryRuntimeEvents(withAgentId(scope), events),
    loadSqliteTrajectoryRuntimeEvents: (
      scope: Parameters<typeof actual.loadSqliteTrajectoryRuntimeEvents>[0],
    ) => actual.loadSqliteTrajectoryRuntimeEvents(withAgentId(scope)),
    loadSqliteTrajectoryRuntimeEventRowsSync: (
      scope: Parameters<typeof actual.loadSqliteTrajectoryRuntimeEventRowsSync>[0],
    ) => actual.loadSqliteTrajectoryRuntimeEventRowsSync(withAgentId(scope)),
  };
});

// The gateway prepares the current roster default before constructing CronService.
// Direct unit constructions model that boundary unless a contract test passes its own value.
vi.mock("../src/cron/service/state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cron/service/state.js")>();
  return {
    ...actual,
    createCronServiceState: (params: Parameters<typeof actual.createCronServiceState>[0]) =>
      actual.createCronServiceState({ defaultAgentId: "main", ...params }),
  };
});

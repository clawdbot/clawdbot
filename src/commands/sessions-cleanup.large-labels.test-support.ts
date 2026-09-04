import { mock } from "node:test";

const count = 150_000;
const storePath = "/mock/agents/main/agent/openclaw-agent.sqlite";
const unexpected = () => {
  throw new Error("unexpected non-preview dependency");
};
const beforeStore = Object.fromEntries(
  Array.from({ length: count }, (_, i) => [
    `agent:main:label-${i}`,
    { sessionId: `session-${i}`, updatedAt: 1, model: "gpt-5.6-sol", label: `label-${i}` },
  ]),
);
let serviceCalls = 0;

// Keep the actual command, grid, and label-summary owners. Only fixture the
// service and unrelated metadata boundaries; no large database is needed.
mock.module(new URL("../config/config.ts", import.meta.url), {
  namedExports: { getRuntimeConfig: () => ({}) },
});
mock.module(new URL("./session-store-targets.ts", import.meta.url), {
  namedExports: { resolveCommandSessionStoreTargets: () => [{ agentId: "main", storePath }] },
});
mock.module(new URL("../config/sessions.ts", import.meta.url), {
  namedExports: {
    resolveSessionCleanupAction: () => "keep",
    isSessionsCleanupPartialResult: unexpected,
    serializeSessionCleanupResult: unexpected,
    runSessionsCleanup: async () => {
      serviceCalls += 1;
      return {
        mode: "warn",
        appliedSummaries: [],
        previewResults: [
          {
            summary: {
              agentId: "main",
              storePath,
              mode: "warn",
              dryRun: true,
              beforeCount: count,
              afterCount: count,
              missing: 0,
              dmScopeRetired: 0,
              modelRunPruned: 0,
              pruned: 0,
              capped: 0,
              diskBudget: null,
              wouldMutate: false,
            },
            beforeStore,
            missingKeys: new Set(),
            modelRunPrunedKeys: new Set(),
            archivedKeys: new Set(),
            staleKeys: new Set(),
            cappedKeys: new Set(),
            dmScopeRetiredKeys: new Set(),
          },
        ],
      };
    },
  },
});
mock.module(new URL("../gateway/call.ts", import.meta.url), {
  namedExports: { callGateway: unexpected, isGatewayTransportError: () => false },
});
mock.module(new URL("../config/sessions/session-sqlite-target.ts", import.meta.url), {
  namedExports: { resolveSqliteTargetFromSessionStorePath: () => ({ path: storePath }) },
});
mock.module(new URL("./sessions-display-model.ts", import.meta.url), {
  namedExports: {
    resolveSessionDisplayModel: (_cfg: unknown, row: { model: string }) => row.model,
  },
});

const { sessionsCleanupCommand } = await import("./sessions-cleanup.js");
let gridPrinted = false;
let summaryPrinted = false;
let labelRows = 0;
let total = "";
await sessionsCleanupCommand(
  { dryRun: true, store: storePath },
  {
    log: (value: unknown) => {
      const line = String(value);
      if (line.includes("Action") && line.includes("Flags")) {
        gridPrinted = true;
      }
      if (line === "Summary by Label:") {
        summaryPrinted = true;
      }
      if (/^label-\d+ +1 kept, 0 pruned$/u.test(line)) {
        labelRows += 1;
      }
      if (line.startsWith("Total:")) {
        total = line;
      }
    },
    error: unexpected,
    exit: unexpected,
  },
);
console.log(JSON.stringify({ serviceCalls, gridPrinted, summaryPrinted, labelRows, total }));
mock.restoreAll();

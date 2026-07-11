import type { WorkspaceDoc } from "./schema.js";

export const DEFAULT_WORKSPACE: WorkspaceDoc = {
  schemaVersion: 1,
  workspaceVersion: 1,
  tabs: [
    {
      slug: "main",
      title: "Overview",
      icon: "layoutWorkspace",
      hidden: false,
      createdBy: "system",
      widgets: [
        {
          id: "cost-today",
          kind: "builtin:stat-card",
          title: "Cost Today",
          grid: { x: 0, y: 0, w: 4, h: 2 },
          collapsed: false,
          hidden: false,
          createdBy: "system",
          bindings: {
            value: {
              source: "rpc",
              method: "usage.cost",
              params: { days: 1, agentScope: "all" },
            },
          },
          props: { metric: "todayCost", format: "usd" },
        },
        {
          id: "tokens-today",
          kind: "builtin:stat-card",
          title: "Tokens Today",
          grid: { x: 4, y: 0, w: 4, h: 2 },
          collapsed: false,
          hidden: false,
          createdBy: "system",
          bindings: {
            // usage.cost carries the day-scoped totals; the stat-card selects the
            // token total via props.metric. (usage.status is provider rate-limit
            // windows — not token counts.)
            value: {
              source: "rpc",
              method: "usage.cost",
              params: { days: 1, agentScope: "all" },
            },
          },
          props: { metric: "todayTokens", format: "int" },
        },
        {
          id: "instances-health",
          kind: "builtin:instances",
          title: "Instances",
          grid: { x: 8, y: 0, w: 4, h: 2 },
          collapsed: false,
          hidden: false,
          createdBy: "system",
          bindings: {
            // system-presence is the live connected-instances + health feed the
            // instances page consumes (PresenceEntry[]).
            presence: { source: "rpc", method: "system-presence" },
          },
        },
        {
          id: "sessions",
          kind: "builtin:sessions",
          title: "Sessions",
          grid: { x: 0, y: 2, w: 6, h: 5 },
          collapsed: false,
          hidden: false,
          createdBy: "system",
          bindings: {
            sessions: { source: "rpc", method: "sessions.list" },
          },
        },
        {
          id: "cron",
          kind: "builtin:cron",
          title: "Cron",
          grid: { x: 6, y: 2, w: 6, h: 5 },
          collapsed: false,
          hidden: false,
          createdBy: "system",
          bindings: {
            jobs: { source: "rpc", method: "cron.list" },
          },
        },
        {
          id: "activity",
          kind: "builtin:activity",
          title: "Activity",
          grid: { x: 0, y: 7, w: 12, h: 8 },
          collapsed: false,
          hidden: false,
          createdBy: "system",
          bindings: {
            // cron.runs (scope defaults to "all" without a jobId) is the global
            // recent-run feed. sessions.usage.logs is per-session (needs a key).
            runs: { source: "rpc", method: "cron.runs" },
          },
        },
      ],
    },
  ],
  widgetsRegistry: {},
  prefs: { tabOrder: ["main"] },
};

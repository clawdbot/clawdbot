// Heartbeat config honor inventory lists heartbeat config ownership rows.
import type { ConfigHonorInventoryRow } from "./config-honor-audit.js";

// Inventory of heartbeat config keys and the proof paths that should honor them.

/** Config prefixes audited for heartbeat key coverage. */
export const HEARTBEAT_CONFIG_PREFIXES = [
  "agents.defaults.heartbeat",
  "agents.entries.*.heartbeat",
] as const;

/** Heartbeat config honor inventory consumed by config audit tests. */
export const HEARTBEAT_CONFIG_HONOR_INVENTORY: ConfigHonorInventoryRow[] = [
  {
    key: "every",
    schemaPaths: ["agents.defaults.heartbeat.every", "agents.entries.*.heartbeat.every"],
    typePaths: ["src/config/types.agent-defaults.ts", "src/config/zod-schema.agent-runtime.ts"],
    mergePaths: ["src/infra/heartbeat-runner.ts", "src/agents/acp-spawn.ts"],
    consumerPaths: ["src/infra/heartbeat-runner.ts", "src/agents/acp-spawn.ts"],
    reloadPaths: ["src/gateway/config-reload-plan.ts"],
    testPaths: [
      "src/infra/heartbeat-runner.returns-default-unset.test.ts",
      "src/gateway/config-reload.test.ts",
    ],
  },
  {
    key: "model",
    schemaPaths: ["agents.defaults.heartbeat.model", "agents.entries.*.heartbeat.model"],
    typePaths: ["src/config/types.agent-defaults.ts", "src/config/zod-schema.agent-runtime.ts"],
    mergePaths: ["src/infra/heartbeat-runner.ts"],
    consumerPaths: ["src/infra/heartbeat-runner.ts"],
    reloadPaths: ["src/gateway/config-reload-plan.ts"],
    testPaths: [
      "src/infra/heartbeat-runner.model-override.test.ts",
      "src/gateway/config-reload.test.ts",
    ],
  },
  {
    key: "prompt",
    schemaPaths: ["agents.defaults.heartbeat.prompt", "agents.entries.*.heartbeat.prompt"],
    typePaths: ["src/config/types.agent-defaults.ts", "src/config/zod-schema.agent-runtime.ts"],
    mergePaths: ["src/infra/heartbeat-runner.ts"],
    consumerPaths: ["src/infra/heartbeat-runner.ts"],
    reloadPaths: ["src/gateway/config-reload-plan.ts"],
    testPaths: ["src/infra/heartbeat-runner.returns-default-unset.test.ts"],
  },
  {
    key: "timeoutSeconds",
    schemaPaths: [
      "agents.defaults.heartbeat.timeoutSeconds",
      "agents.entries.*.heartbeat.timeoutSeconds",
    ],
    typePaths: ["src/config/types.agent-defaults.ts", "src/config/zod-schema.agent-runtime.ts"],
    mergePaths: ["src/infra/heartbeat-runner.ts"],
    consumerPaths: ["src/infra/heartbeat-runner.ts", "src/auto-reply/reply/get-reply.ts"],
    reloadPaths: ["src/gateway/config-reload-plan.ts"],
    testPaths: [
      "src/config/zod-schema.agent-defaults.test.ts",
      "src/infra/heartbeat-runner.model-override.test.ts",
    ],
  },
  {
    key: "lightContext",
    schemaPaths: [
      "agents.defaults.heartbeat.lightContext",
      "agents.entries.*.heartbeat.lightContext",
    ],
    typePaths: ["src/config/types.agent-defaults.ts", "src/config/zod-schema.agent-runtime.ts"],
    mergePaths: ["src/infra/heartbeat-runner.ts"],
    consumerPaths: ["src/infra/heartbeat-runner.ts", "src/agents/bootstrap-files.ts"],
    reloadPaths: ["src/gateway/config-reload-plan.ts"],
    testPaths: [
      "src/infra/heartbeat-runner.model-override.test.ts",
      "src/agents/bootstrap-files.test.ts",
      "src/gateway/config-reload.test.ts",
    ],
  },
  {
    key: "isolatedSession",
    schemaPaths: [
      "agents.defaults.heartbeat.isolatedSession",
      "agents.entries.*.heartbeat.isolatedSession",
    ],
    typePaths: ["src/config/types.agent-defaults.ts", "src/config/zod-schema.agent-runtime.ts"],
    mergePaths: ["src/infra/heartbeat-runner.ts"],
    consumerPaths: ["src/infra/heartbeat-runner.ts"],
    reloadPaths: ["src/gateway/config-reload-plan.ts"],
    testPaths: ["src/infra/heartbeat-runner.model-override.test.ts"],
  },
  {
    key: "target",
    schemaPaths: ["agents.defaults.heartbeat.target", "agents.entries.*.heartbeat.target"],
    typePaths: ["src/config/types.agent-defaults.ts", "src/config/zod-schema.agent-runtime.ts"],
    mergePaths: ["src/infra/heartbeat-runner.ts", "src/infra/outbound/targets.ts"],
    consumerPaths: ["src/infra/outbound/targets.ts", "src/infra/heartbeat-runner.ts"],
    reloadPaths: ["src/gateway/config-reload-plan.ts"],
    testPaths: [
      "src/infra/heartbeat-runner.returns-default-unset.test.ts",
      "src/cron/service.main-job-passes-heartbeat-target-last.test.ts",
    ],
  },
  {
    key: "to",
    schemaPaths: ["agents.defaults.heartbeat.to", "agents.entries.*.heartbeat.to"],
    typePaths: ["src/config/types.agent-defaults.ts", "src/config/zod-schema.agent-runtime.ts"],
    mergePaths: ["src/infra/heartbeat-runner.ts", "src/infra/outbound/targets.ts"],
    consumerPaths: ["src/infra/outbound/targets.ts"],
    reloadPaths: ["src/gateway/config-reload-plan.ts"],
    testPaths: ["src/infra/heartbeat-runner.returns-default-unset.test.ts"],
  },
  {
    key: "accountId",
    schemaPaths: ["agents.defaults.heartbeat.accountId", "agents.entries.*.heartbeat.accountId"],
    typePaths: ["src/config/types.agent-defaults.ts", "src/config/zod-schema.agent-runtime.ts"],
    mergePaths: ["src/infra/heartbeat-runner.ts", "src/infra/outbound/targets.ts"],
    consumerPaths: ["src/infra/outbound/targets.ts", "src/infra/heartbeat-runner.ts"],
    reloadPaths: ["src/gateway/config-reload-plan.ts"],
    testPaths: [
      "src/infra/heartbeat-runner.returns-default-unset.test.ts",
      "src/infra/heartbeat-runner.respects-ackmaxchars-heartbeat-acks.test.ts",
    ],
  },
  {
    key: "directPolicy",
    schemaPaths: [
      "agents.defaults.heartbeat.directPolicy",
      "agents.entries.*.heartbeat.directPolicy",
    ],
    typePaths: ["src/config/types.agent-defaults.ts", "src/config/zod-schema.agent-runtime.ts"],
    mergePaths: ["src/infra/heartbeat-runner.ts", "src/infra/outbound/targets.ts"],
    consumerPaths: ["src/infra/outbound/targets.ts"],
    reloadPaths: ["src/gateway/config-reload-plan.ts"],
    testPaths: ["src/infra/heartbeat-runner.returns-default-unset.test.ts"],
  },
];

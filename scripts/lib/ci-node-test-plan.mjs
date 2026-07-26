// Builds CI node/Vitest shard plans from the full suite configuration.
import { relative } from "node:path";
import { agentsCoreIsolatedTestFiles } from "../../test/vitest/vitest.agents-paths.mjs";
import { commandsLightTestFiles } from "../../test/vitest/vitest.commands-light-paths.mjs";
import { fullSuiteVitestShards } from "../../test/vitest/vitest.test-shards.mjs";
import { toolingIsolatedTestFiles } from "../../test/vitest/vitest.tooling-isolated-paths.mjs";
import {
  getUnitFastIsolatedTestFiles,
  getUnitFastTestFiles,
  getUnitFastTestFilesForIncludePatterns,
  getUnitFastTimerTestFiles,
} from "../../test/vitest/vitest.unit-fast-paths.mjs";
import { boundaryTestFiles } from "../../test/vitest/vitest.unit-paths.mjs";
import { listTrackedTestFiles } from "./list-test-files.mjs";

const EXCLUDED_FULL_SUITE_SHARDS = new Set([
  "test/vitest/vitest.full-core-contracts.config.ts",
  "test/vitest/vitest.full-core-bundled.config.ts",
  "test/vitest/vitest.full-extensions.config.ts",
]);

const EXCLUDED_PROJECT_CONFIGS = new Set(["test/vitest/vitest.channels.config.ts"]);
const DEFAULT_NODE_TEST_RUNNER = "blacksmith-8vcpu-ubuntu-2404";
const BUNDLED_NODE_TEST_RUNNER = "blacksmith-4vcpu-ubuntu-2404";
// Startup-core transforms the broad gateway graph before its assertions run.
// Keep enough CPU here to avoid spending minutes in Vitest imports on 4 vCPU.
const GATEWAY_STARTUP_CORE_RUNNER = DEFAULT_NODE_TEST_RUNNER;
// This cold gateway graph can stall after warming Vitest's module cache; its
// retry completes in seconds, so do not spend the global five-minute timeout.
const GATEWAY_STARTUP_HEALTH_RUNTIME_ENV = {
  OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "60000",
};
const MAX_BUNDLED_NODE_TEST_PATTERNS = 64;
// PR-only bundles trade a little serial work for fewer ephemeral runner registrations.
// Keep runner classes and subprocess isolation intact while bounding each combined job.
// The group hints below are loaded-fleet CI walls, so the cap is the real per-bin
// test budget: 235s packs both runner classes into the same job count as before
// (6 large + 15 small) while the measured ~60s median job setup keeps the slowest
// bin near the 5-minute PR wall-clock budget. 220 with honest hints adds a job to
// each pool for no ceiling win.
// 190s cap: forbids pairings like core-runtime-media-ui (124) +
// core-unit-src-security (95) that produced a 195s real-wall straggler bin
// while the pack sat at ~160s; ~3 extra bins buy ~30-40s of run wall.
const COMPACT_NODE_TEST_JOB_SECONDS = 190;
const COMPACT_NODE_TEST_JOB_GROUPS = 10;
const COMPACT_TOOLING_NODE_TEST_GROUPS = 4;
const COMPACT_WHOLE_NODE_TEST_TIMEOUT_MINUTES = 120;
const AUTO_REPLY_COMMANDS_STRIPES = 3;
const AGENTS_CORE_RUNNER_CLI_STRIPES = 3;
const UNIT_FAST_NODE_TEST_STRIPES = 2;
// Advisory runtime estimates (seconds) per split shard: [shard:*] begin->end
// wall clock across seven green Blacksmith compact PR runs after the
// cli-runner reliability whale fix (29605136624, 29605203485, 29605983019,
// 29606701461, 29611308972, 29611457693, 29611500865), averaged after
// dropping cache-warm/contention outliers outside [median/1.5, median*1.5].
// Packing only: a stale entry skews job balance but never correctness.
// Unknown shards fall back to a per-file estimate.
const COMPACT_GROUP_SECONDS_HINTS = new Map([
  ["agentic-agents-core-auth", 27],
  ["agentic-agents-core-isolated", 9],
  ["agentic-agents-core-models", 51],
  // Reliability's runtime-free provider check dropped its wall time from
  // ~245s to ~5s; the narrow anthropic cli-api artifact removes the same
  // full-barrel evaluation for the remaining facade importers (spawn).
  ["agentic-agents-core-runner-cli-1", 8],
  ["agentic-agents-core-runner-cli-2", 9],
  ["agentic-agents-core-runner-cli-3", 8],
  ["agentic-agents-core-runner-commands", 27],
  ["agentic-agents-core-runner-embedded", 20],
  ["agentic-agents-core-runner-sessions", 13],
  ["agentic-agents-core-runtime", 79],
  ["agentic-agents-core-subagents", 32],
  ["agentic-agents-core-tools", 52],
  ["agentic-agents-embedded", 57],
  ["agentic-agents-support", 105],
  ["agentic-agents-tools", 42],
  ["agentic-cli", 72],
  ["agentic-command-support", 41],
  ["agentic-commands-agent-channel", 51],
  ["agentic-commands-doctor", 19],
  ["agentic-commands-doctor-auth", 11],
  ["agentic-commands-doctor-config-state", 42],
  ["agentic-commands-doctor-gateway", 4],
  ["agentic-commands-doctor-plugins-tools", 11],
  ["agentic-commands-doctor-sessions-cron", 24],
  ["agentic-commands-doctor-shared", 16],
  ["agentic-commands-models", 16],
  ["agentic-commands-onboard-config", 11],
  ["agentic-commands-status-tools", 21],
  ["agentic-control-plane-agent-chat", 74],
  ["agentic-control-plane-auth-node", 89],
  ["agentic-control-plane-http-models", 33],
  ["agentic-control-plane-http-plugin-ws", 39],
  ["agentic-control-plane-runtime-config", 14],
  ["agentic-control-plane-runtime-cron", 15],
  ["agentic-control-plane-runtime-server", 29],
  ["agentic-control-plane-runtime-shared-token", 22],
  ["agentic-control-plane-runtime-state", 13],
  ["agentic-control-plane-runtime-ui-tools", 11],
  ["agentic-control-plane-startup-core", 156],
  ["agentic-control-plane-startup-health-runtime", 22],
  ["agentic-control-plane-startup-restart-close", 8],
  ["agentic-gateway-core", 124],
  ["agentic-gateway-methods", 69],
  ["agentic-plugin-sdk", 47],
  ["auto-reply-core-top-level", 30],
  ["auto-reply-reply-agent-runner", 40],
  ["auto-reply-reply-commands-1", 24],
  ["auto-reply-reply-commands-2", 10],
  ["auto-reply-reply-commands-3", 12],
  ["auto-reply-reply-dispatch", 40],
  ["auto-reply-reply-session", 19],
  ["auto-reply-reply-state-routing", 18],
  ["core-runtime-cron-core", 16],
  ["core-runtime-cron-isolated-agent", 59],
  ["core-runtime-cron-service", 23],
  ["core-runtime-hooks", 9],
  ["core-runtime-infra-approval-exec", 30],
  ["core-runtime-infra-channel-plugin", 17],
  ["core-runtime-infra-diagnostics-state", 19],
  ["core-runtime-infra-heartbeat-runner", 53],
  ["core-runtime-infra-misc", 9],
  ["core-runtime-infra-net-install", 13],
  ["core-runtime-infra-outbound-actions", 19],
  ["core-runtime-infra-outbound-core", 45],
  ["core-runtime-infra-process", 91],
  ["core-runtime-infra-provider-push", 17],
  ["core-runtime-infra-storage-state", 70],
  ["core-runtime-infra-system-runtime", 40],
  ["core-runtime-media-ui", 124],
  ["core-runtime-secrets", 37],
  ["core-runtime-shared", 48],
  // PTY timing suites still need a lightly packed lane; the exclusive-bin cap
  // leaves only trivial co-groups next to this measured runtime.
  ["core-runtime-tui-pty", 116],
  ["core-tooling-1", 94],
  ["core-tooling-2", 95],
  ["core-tooling-3", 108],
  ["core-tooling-4", 125],
  ["core-tooling-isolated", 49],
  ["core-unit-fast-1", 41],
  ["core-unit-fast-2", 35],
  // Fork-per-file isolation parallelizes poorly on 4 vCPU; keep it on the
  // 8 vCPU class, where it still runs a measured ~90s under fleet load.
  ["core-unit-fast-isolated", 90],
  ["core-unit-src-security", 95],
  ["core-unit-support", 17],
]);
// Advisory per-file wall-clock hints (seconds) for stripe balancing, measured
// from single-file local runs (M4 Max) and static import-graph size. Packing
// only: a stale entry skews stripe balance but never correctness. Unlisted
// files use the default, which mostly reflects the per-file module-graph
// re-evaluation cost that dominates these serial suites.
const STRIPE_FILE_SECONDS_HINTS = new Map([
  // cli-runner entries are CI wall clock (begin->checkmark deltas from the
  // compact runs above), refreshed by focused Testbox profiling where noted.
  ["src/agents/cli-runner.context-engine.test.ts", 6],
  // Fresh profile: 5.1s total, 3.8s import; retain a conservative packing hint.
  ["src/agents/cli-runner.reliability.test.ts", 8],
  ["src/agents/cli-runner.spawn.test.ts", 18],
  ["src/auto-reply/reply/commands-export-session.test.ts", 8],
  ["src/auto-reply/reply/commands-gating.test.ts", 6],
  ["src/auto-reply/reply/commands-learn.test.ts", 8],
  ["src/auto-reply/reply/commands-plugins.install.test.ts", 6],
  ["src/auto-reply/reply/commands-status.test.ts", 12],
  ["src/auto-reply/reply/commands-system-prompt.test.ts", 8],
  ["src/scripts/test-projects.test.ts", 21],
  ["test/scripts/bench-sqlite-reliability.test.ts", 9],
  ["test/scripts/bundled-plugin-install-uninstall-probe.test.ts", 4],
  ["test/scripts/changed-lanes.test.ts", 5],
  ["test/scripts/ci-workflow-guards.test.ts", 12],
  ["test/scripts/crabbox-wrapper.test.ts", 19],
  ["test/scripts/find-reusable-release-validation.test.ts", 8],
  ["test/scripts/install-sh.test.ts", 6],
  ["test/scripts/kitchen-sink-rpc-walk.test.ts", 5],
  ["test/scripts/openclaw-live-updater.test.ts", 18],
  ["test/scripts/parallels-smoke-model.test.ts", 8],
  ["test/scripts/plugin-clawhub-release.test.ts", 5],
  ["test/scripts/plugin-gateway-gauntlet.test.ts", 5],
  ["test/scripts/plugin-sdk-surface-report.test.ts", 6],
  ["test/scripts/pr-operation-lock.test.ts", 27],
  ["test/scripts/test-projects.test.ts", 8],
]);
const DEFAULT_STRIPE_FILE_SECONDS = 3;

const DEFAULT_WHOLE_GROUP_SECONDS = 25;
const DEFAULT_SECONDS_PER_TEST_FILE = 0.5;
// Spawn/signal-timing suites (process-group waits, PTY smoke) flake when a
// concurrent sibling Vitest run competes for the 4 vCPU runner. Pack them
// into bins the shard runner executes at concurrency 1.
const EXCLUSIVE_COMPACT_GROUP_RE = /^core-tooling(?:-\d+|-isolated)$|^core-runtime-tui-pty$/u;
// Exclusive bins run serially, so their packed estimate is their wall clock.
const COMPACT_EXCLUSIVE_JOB_SECONDS = 150;

function isExclusiveCompactGroup(group) {
  return EXCLUSIVE_COMPACT_GROUP_RE.test(group.shard_name);
}

// Spawn/signal/PTY-timing suites also flake under high in-process worker
// counts; pin them to the proven 2-worker budget while the job-level default
// scales with the runner class. infra-process spawns child processes per test
// and hit worker-startup timeouts under contention before serialization.
const PINNED_WORKER_COMPACT_GROUP_RE =
  /^core-tooling(?:-\d+|-isolated)$|^core-runtime-tui-pty$|^core-runtime-infra-process$|^core-runtime-media-ui$|^agentic-gateway-(?:core|methods)$/u;
const PINNED_COMPACT_GROUP_ENV = { OPENCLAW_VITEST_MAX_WORKERS: "2" };

function applyCompactGroupWorkerPins(group) {
  if (!PINNED_WORKER_COMPACT_GROUP_RE.test(group.shard_name)) {
    return group;
  }
  return { ...group, env: { ...group.env, ...PINNED_COMPACT_GROUP_ENV } };
}

function estimateCompactGroupSeconds(group) {
  const hint = COMPACT_GROUP_SECONDS_HINTS.get(group.shard_name);
  if (hint !== undefined) {
    return hint;
  }
  if (Array.isArray(group.includePatterns)) {
    return Math.max(3, Math.round(group.includePatterns.length * DEFAULT_SECONDS_PER_TEST_FILE));
  }
  return DEFAULT_WHOLE_GROUP_SECONDS;
}
const TOOLING_CONFIG = "test/vitest/vitest.tooling.config.ts";
const TOOLING_DOCKER_TEST_FILE = "test/scripts/docker-build-helper.test.ts";
const TOOLING_ISOLATED_CONFIG = "test/vitest/vitest.tooling-isolated.config.ts";
// The full matrix is capped at 28 jobs. Admit the consistently slow serial
// shards first so short alphabetical groups cannot leave them on the tail.
const FULL_NODE_TEST_ADMISSION_PRIORITY = new Map([
  // Start the broad cache writer in the first admission wave so later jobs
  // can reuse its protected transform snapshot on the next run.
  ["core-unit-fast-1", 0],
  ["core-unit-fast-2", 0],
  ["core-tooling-1", 1],
  ["core-tooling-2", 1],
  ["core-tooling-3", 1],
  ["core-tooling-4", 1],
]);
// Commands and cron run non-isolated, so keep their split shards as separate
// processes. Combining their include lists can retain test state across groups.
const BUNDLEABLE_NODE_TEST_CONFIGS = new Set(["test/vitest/vitest.infra.config.ts"]);
const KEEP_LARGE_NODE_TEST_RUNNER = new Set([
  "agentic-agents-core-auth",
  "agentic-agents-core-models",
  "agentic-agents-core-runtime",
  "agentic-agents-core-subagents",
  "agentic-agents-embedded",
  "agentic-agents-support",
  "agentic-agents-core-runner-cli-1",
  "agentic-agents-core-runner-cli-2",
  "agentic-agents-core-runner-cli-3",
  "agentic-agents-core-runner-commands",
  "agentic-agents-core-runner-embedded",
  "agentic-agents-core-runner-sessions",
  "agentic-agents-core-tools",
  "agentic-control-plane-startup-core",
  "agentic-gateway-core",
  "agentic-gateway-methods",
  "auto-reply-reply-dispatch",
  // The commands stripes and security suite are import-bound (30-45s of
  // module-graph import per file); the 8 vCPU class with a higher Vitest
  // worker budget cuts their wall clock roughly linearly.
  "auto-reply-reply-commands-1",
  "auto-reply-reply-commands-2",
  "auto-reply-reply-commands-3",
  "core-runtime-media-ui",
  "core-unit-fast-1",
  "core-unit-fast-2",
  "core-unit-fast-isolated",
  "core-unit-src-security",
]);
const RELEASE_ONLY_PLUGIN_SHARDS = new Set(["agentic-plugins"]);
function listTestFiles(rootDir) {
  return listTrackedTestFiles(rootDir);
}

function createAutoReplyReplySplitShards() {
  const files = listTestFiles("src/auto-reply/reply");
  const groups = {
    "auto-reply-reply-agent-runner": [],
    "auto-reply-reply-commands": [],
    "auto-reply-reply-dispatch": [],
    "auto-reply-reply-session": [],
    "auto-reply-reply-state-routing": [],
  };

  for (const file of files) {
    const name = relative("src/auto-reply/reply", file).replaceAll("\\", "/");
    if (
      name.startsWith("agent-runner") ||
      name.startsWith("acp-") ||
      name === "abort.test.ts" ||
      name === "bash-command.stop.test.ts" ||
      name.startsWith("block-")
    ) {
      groups["auto-reply-reply-agent-runner"].push(file);
    } else if (name.startsWith("commands")) {
      groups["auto-reply-reply-commands"].push(file);
    } else if (
      name.startsWith("directive-") ||
      name.startsWith("dispatch") ||
      name.startsWith("followup-") ||
      name.startsWith("get-reply")
    ) {
      groups["auto-reply-reply-dispatch"].push(file);
    } else if (name.startsWith("session")) {
      groups["auto-reply-reply-session"].push(file);
    } else {
      groups["auto-reply-reply-state-routing"].push(file);
    }
  }

  return Object.entries(groups)
    .flatMap(([groupName, includePatterns]) => {
      // The commands bucket alone serializes ~3 minutes; stripe it so packing
      // can spread that runtime across jobs.
      if (groupName === "auto-reply-reply-commands") {
        return createStripedBatches(includePatterns, AUTO_REPLY_COMMANDS_STRIPES).map(
          (batch, index) => ({
            configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
            includePatterns: batch,
            requiresDist: false,
            shardName: `${groupName}-${index + 1}`,
          }),
        );
      }
      return [
        {
          configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
          includePatterns,
          requiresDist: false,
          shardName: groupName,
        },
      ];
    })
    .filter((shard) => shard.includePatterns.length > 0);
}

function resolveCommandShardName(file) {
  const name = relative("src/commands", file).replaceAll("\\", "/");
  if (name.startsWith("agent") || name.startsWith("channel") || name === "message.test.ts") {
    return "agentic-commands-agent-channel";
  }
  if (name.startsWith("oauth-tls-preflight.doctor")) {
    return "agentic-commands-doctor-auth";
  }
  if (name.startsWith("doctor")) {
    if (name.startsWith("doctor/shared/") || name.startsWith("doctor/")) {
      return "agentic-commands-doctor-shared";
    }
    if (name.startsWith("doctor-auth")) {
      return "agentic-commands-doctor-auth";
    }
    if (
      name.startsWith("doctor-config") ||
      name.startsWith("doctor-legacy-config") ||
      name.startsWith("doctor-state")
    ) {
      return "agentic-commands-doctor-config-state";
    }
    if (
      name.startsWith("doctor-cron") ||
      name.startsWith("doctor-heartbeat") ||
      name.startsWith("doctor-session")
    ) {
      return "agentic-commands-doctor-sessions-cron";
    }
    if (name.startsWith("doctor-gateway")) {
      return "agentic-commands-doctor-gateway";
    }
    if (name.startsWith("doctor-device")) {
      return "agentic-commands-doctor-device";
    }
    if (name.startsWith("doctor-platform")) {
      return "agentic-commands-doctor-platform";
    }
    if (name.startsWith("doctor-whatsapp")) {
      return "agentic-commands-doctor-whatsapp";
    }
    if (name.startsWith("doctor-workspace")) {
      return "agentic-commands-doctor-workspace";
    }
    if (
      name.startsWith("doctor-browser") ||
      name.startsWith("doctor-plugin") ||
      name.startsWith("doctor-skill") ||
      name.startsWith("doctor-memory") ||
      name.startsWith("doctor-claude")
    ) {
      return "agentic-commands-doctor-plugins-tools";
    }
    return "agentic-commands-doctor";
  }
  if (
    name.startsWith("auth-choice") ||
    name.startsWith("configure") ||
    name.startsWith("onboard") ||
    name === "setup.test.ts"
  ) {
    return "agentic-commands-onboard-config";
  }
  if (
    name.startsWith("models/") ||
    name === "model-picker.test.ts" ||
    name === "openai-model-default.test.ts"
  ) {
    return "agentic-commands-models";
  }
  return "agentic-commands-status-tools";
}

function createAgenticCommandSplitShards() {
  const commandsLightTests = new Set(commandsLightTestFiles);
  const groups = new Map();
  for (const file of listTestFiles("src/commands")) {
    if (commandsLightTests.has(file) || file.endsWith(".e2e.test.ts")) {
      continue;
    }
    const shardName = resolveCommandShardName(file);
    groups.set(shardName, [...(groups.get(shardName) ?? []), file]);
  }

  return [
    "agentic-commands-agent-channel",
    "agentic-commands-doctor",
    "agentic-commands-doctor-auth",
    "agentic-commands-doctor-config-state",
    "agentic-commands-doctor-device",
    "agentic-commands-doctor-gateway",
    "agentic-commands-doctor-platform",
    "agentic-commands-doctor-plugins-tools",
    "agentic-commands-doctor-sessions-cron",
    "agentic-commands-doctor-shared",
    "agentic-commands-doctor-whatsapp",
    "agentic-commands-doctor-workspace",
    "agentic-commands-models",
    "agentic-commands-onboard-config",
    "agentic-commands-status-tools",
  ]
    .map((shardName) => ({
      configs: ["test/vitest/vitest.commands.config.ts"],
      includePatterns: groups.get(shardName) ?? [],
      requiresDist: false,
      shardName,
    }))
    .filter((shard) => shard.includePatterns.length > 0);
}

function resolveAgentCoreShardName(file) {
  const name = relative("src/agents", file).replaceAll("\\", "/");
  if (
    name.startsWith("auth") ||
    name.includes("auth") ||
    name.includes("oauth") ||
    name.includes("credential") ||
    name.includes("api-key") ||
    name.includes("token")
  ) {
    return "agentic-agents-core-auth";
  }
  if (
    name.startsWith("model") ||
    name.includes("provider") ||
    name.includes("openai") ||
    name.includes("anthropic") ||
    name.includes("gemini") ||
    name.includes("moonshot") ||
    name.includes("minimax") ||
    name.includes("xai") ||
    name.includes("zai") ||
    name.includes("chutes") ||
    name.includes("catalog")
  ) {
    return "agentic-agents-core-models";
  }
  if (
    name.startsWith("agent-tools") ||
    name.startsWith("openclaw-tools") ||
    name.startsWith("bash-tools") ||
    name.startsWith("tool") ||
    name.startsWith("apply-patch") ||
    name.startsWith("exec") ||
    name.startsWith("sandbox")
  ) {
    return "agentic-agents-core-tools";
  }
  if (
    name.startsWith("subagent") ||
    name.startsWith("spawn") ||
    name.startsWith("embedded-agent-subscribe")
  ) {
    return "agentic-agents-core-subagents";
  }
  // The former single "core-runner" bucket serialized ~3 minutes of tests in
  // one group; keep these three slices separate so packing can balance them.
  if (name.startsWith("embedded-agent-runner")) {
    return "agentic-agents-core-runner-embedded";
  }
  if (
    name.startsWith("agent-command") ||
    name.startsWith("command") ||
    name.includes("compaction")
  ) {
    return "agentic-agents-core-runner-commands";
  }
  if (name.startsWith("cli-runner")) {
    return "agentic-agents-core-runner-cli";
  }
  if (name.includes("session")) {
    return "agentic-agents-core-runner-sessions";
  }
  return "agentic-agents-core-runtime";
}

function createAgentCoreSplitShards() {
  const isolatedTests = new Set(agentsCoreIsolatedTestFiles);
  const groups = new Map();
  for (const file of listTestFiles("src/agents")) {
    const name = relative("src/agents", file).replaceAll("\\", "/");
    if (name.includes("/") || isolatedTests.has(file)) {
      continue;
    }
    const shardName = resolveAgentCoreShardName(file);
    groups.set(shardName, [...(groups.get(shardName) ?? []), file]);
  }

  const sharedShards = [
    "agentic-agents-core-auth",
    "agentic-agents-core-models",
    "agentic-agents-core-tools",
    "agentic-agents-core-subagents",
    "agentic-agents-core-runner-cli",
    "agentic-agents-core-runner-commands",
    "agentic-agents-core-runner-embedded",
    "agentic-agents-core-runner-sessions",
    "agentic-agents-core-runtime",
  ]
    .flatMap((shardName) => {
      const includePatterns = groups.get(shardName) ?? [];
      // agents-core runs files serially (fileParallelism false guards shared
      // module state), so the import-heavy cli-runner suite (~35s of module
      // import per file) stripes across bins to parallelize at the job level.
      if (shardName === "agentic-agents-core-runner-cli") {
        return createStripedBatches(includePatterns, AGENTS_CORE_RUNNER_CLI_STRIPES).map(
          (batch, index) => ({
            configs: ["test/vitest/vitest.agents-core.config.ts"],
            includePatterns: batch,
            requiresDist: false,
            shardName: `${shardName}-${index + 1}`,
          }),
        );
      }
      return [
        {
          configs: ["test/vitest/vitest.agents-core.config.ts"],
          includePatterns,
          requiresDist: false,
          shardName,
        },
      ];
    })
    .filter((shard) => shard.includePatterns.length > 0);

  return [
    ...sharedShards,
    {
      configs: ["test/vitest/vitest.agents-core-isolated.config.ts"],
      includePatterns: agentsCoreIsolatedTestFiles,
      requiresDist: false,
      shardName: "agentic-agents-core-isolated",
    },
  ];
}

const GATEWAY_SERVER_BACKED_HTTP_TESTS = new Set([
  "src/gateway/embeddings-http.test.ts",
  "src/gateway/models-http.test.ts",
  "src/gateway/openai-http.test.ts",
  "src/gateway/openresponses-http.test.ts",
  "src/gateway/probe.auth.integration.test.ts",
]);

const GATEWAY_SERVER_EXCLUDED_TESTS = new Set([
  "src/gateway/gateway.test.ts",
  "src/gateway/server.startup-matrix-migration.integration.test.ts",
  "src/gateway/sessions-history-http.test.ts",
]);

function isGatewayServerTestFile(file) {
  return (
    file.startsWith("src/gateway/") &&
    !file.startsWith("src/gateway/server-methods/") &&
    !GATEWAY_SERVER_EXCLUDED_TESTS.has(file) &&
    (file.includes("server") || GATEWAY_SERVER_BACKED_HTTP_TESTS.has(file))
  );
}

function resolveGatewayStartupShardName(file) {
  const name = relative("src/gateway", file).replaceAll("\\", "/");
  if (name.startsWith("server-startup-config") || name.startsWith("server-startup-early")) {
    return "agentic-control-plane-startup-config";
  }
  if (
    name.startsWith("server-runtime") ||
    name.startsWith("server.health") ||
    name.startsWith("server.lazy") ||
    name.startsWith("server/health-state") ||
    name.startsWith("server/readiness")
  ) {
    return "agentic-control-plane-startup-health-runtime";
  }
  if (name.startsWith("server-restart") || name === "server-close.test.ts") {
    return "agentic-control-plane-startup-restart-close";
  }
  return "agentic-control-plane-startup-core";
}

function resolveGatewayServerShardName(file) {
  const name = relative("src/gateway", file).replaceAll("\\", "/");
  if (
    GATEWAY_SERVER_BACKED_HTTP_TESTS.has(file) ||
    name.startsWith("server.models") ||
    name.startsWith("server.talk")
  ) {
    return "agentic-control-plane-http-models";
  }
  if (
    name.startsWith("server.agent") ||
    name.startsWith("server.chat") ||
    name.startsWith("server.sessions")
  ) {
    return "agentic-control-plane-agent-chat";
  }
  if (
    name.includes("auth") ||
    name.includes("device") ||
    name.includes("node") ||
    name.includes("roles") ||
    name.includes("silent") ||
    name.includes("preauth") ||
    name.includes("control-plane-rate-limit")
  ) {
    return "agentic-control-plane-auth-node";
  }
  if (
    name.startsWith("server-startup") ||
    name.startsWith("server-restart") ||
    name.startsWith("server-runtime") ||
    name.startsWith("server.lazy") ||
    name.startsWith("server.health") ||
    name.startsWith("server/health-state") ||
    name.startsWith("server/readiness") ||
    name === "server-close.test.ts"
  ) {
    return resolveGatewayStartupShardName(file);
  }
  if (name.includes("cron")) {
    return "agentic-control-plane-runtime-cron";
  }
  if (name.includes("network")) {
    return "agentic-control-plane-runtime-network";
  }
  if (
    name.includes("plugin") ||
    name.includes("hooks") ||
    name.includes("http") ||
    name.includes("ws-connection")
  ) {
    return "agentic-control-plane-http-plugin-ws";
  }
  if (name.startsWith("server-")) {
    return "agentic-control-plane-runtime-server";
  }
  if (name.startsWith("server.config-patch")) {
    return "agentic-control-plane-runtime-config";
  }
  if (name.startsWith("server.shared-token")) {
    return "agentic-control-plane-runtime-shared-token";
  }
  if (
    name.startsWith("server.control-ui-root") ||
    name.startsWith("server.ios-client-id") ||
    name.startsWith("server.minimal-channel-pin") ||
    name.startsWith("server.tools-catalog")
  ) {
    return "agentic-control-plane-runtime-ui-tools";
  }
  if (name.startsWith("server/")) {
    return "agentic-control-plane-runtime-events";
  }
  if (name.startsWith("server.") || name.startsWith("server/")) {
    return "agentic-control-plane-runtime-state";
  }
  return "agentic-control-plane-runtime";
}

function createGatewayServerSplitShards() {
  const groups = new Map();
  for (const file of listTestFiles("src/gateway").filter(isGatewayServerTestFile)) {
    const shardName = resolveGatewayServerShardName(file);
    groups.set(shardName, [...(groups.get(shardName) ?? []), file]);
  }
  return [
    "agentic-control-plane-agent-chat",
    "agentic-control-plane-auth-node",
    "agentic-control-plane-http-models",
    "agentic-control-plane-http-plugin-ws",
    "agentic-control-plane-runtime",
    "agentic-control-plane-runtime-config",
    "agentic-control-plane-runtime-cron",
    "agentic-control-plane-runtime-events",
    "agentic-control-plane-runtime-network",
    "agentic-control-plane-runtime-server",
    "agentic-control-plane-runtime-shared-token",
    "agentic-control-plane-runtime-state",
    "agentic-control-plane-runtime-ui-tools",
    "agentic-control-plane-startup-config",
    "agentic-control-plane-startup-core",
    "agentic-control-plane-startup-health-runtime",
    "agentic-control-plane-startup-restart-close",
  ]
    .map((shardName) => ({
      configs: ["test/vitest/vitest.gateway-server.config.ts"],
      env:
        shardName === "agentic-control-plane-startup-health-runtime"
          ? GATEWAY_STARTUP_HEALTH_RUNTIME_ENV
          : undefined,
      includePatterns: groups.get(shardName) ?? [],
      requiresDist: false,
      runner:
        shardName === "agentic-control-plane-startup-core"
          ? GATEWAY_STARTUP_CORE_RUNNER
          : BUNDLED_NODE_TEST_RUNNER,
      shardName,
    }))
    .filter((shard) => shard.includePatterns.length > 0);
}

function resolveCronShardName(file) {
  const name = relative("src/cron", file).replaceAll("\\", "/");
  if (name.startsWith("isolated-agent")) {
    return "core-runtime-cron-isolated-agent";
  }
  if (name.startsWith("service")) {
    return "core-runtime-cron-service";
  }
  return "core-runtime-cron-core";
}

function createCronSplitShards() {
  const groups = new Map();
  for (const file of listTestFiles("src/cron")) {
    const shardName = resolveCronShardName(file);
    groups.set(shardName, [...(groups.get(shardName) ?? []), file]);
  }

  return ["core-runtime-cron-core", "core-runtime-cron-isolated-agent", "core-runtime-cron-service"]
    .map((shardName) => ({
      configs: ["test/vitest/vitest.cron.config.ts"],
      includePatterns: groups.get(shardName) ?? [],
      requiresDist: false,
      shardName,
    }))
    .filter((shard) => shard.includePatterns.length > 0);
}

function resolveInfraShardName(file) {
  const name = relative("src/infra", file).replaceAll("\\", "/");
  if (name.startsWith("approval") || name.startsWith("exec")) {
    return "core-runtime-infra-approval-exec";
  }
  if (name.startsWith("heartbeat-runner")) {
    return "core-runtime-infra-heartbeat-runner";
  }
  if (name.startsWith("heartbeat")) {
    return "core-runtime-infra-heartbeat-core";
  }
  if (name.startsWith("outbound/message-action")) {
    return "core-runtime-infra-outbound-actions";
  }
  if (name.startsWith("outbound/")) {
    return "core-runtime-infra-outbound-core";
  }
  if (
    name.startsWith("net/") ||
    name.startsWith("install") ||
    name.startsWith("npm") ||
    name.startsWith("brew") ||
    name.startsWith("binaries")
  ) {
    return "core-runtime-infra-net-install";
  }
  if (name.startsWith("device")) {
    return "core-runtime-infra-device";
  }
  if (name.startsWith("gateway-lock") || name.startsWith("gateway-process-argv")) {
    return "core-runtime-infra-gateway-lock-argv";
  }
  if (name.startsWith("gateway-processes")) {
    return "core-runtime-infra-gateway-processes";
  }
  if (name.startsWith("gateway-watch")) {
    return "core-runtime-infra-gateway-watch";
  }
  if (name.startsWith("node") || name.startsWith("bonjour") || name.startsWith("network")) {
    return "core-runtime-infra-network-node";
  }
  if (
    name.startsWith("archive") ||
    name.startsWith("backup") ||
    name.startsWith("diagnostic") ||
    name.startsWith("diagnostics")
  ) {
    return "core-runtime-infra-diagnostics-state";
  }
  if (
    name.startsWith("command-analysis/") ||
    name.startsWith("command-explainer/") ||
    name.startsWith("file-") ||
    name.startsWith("fs-") ||
    name.startsWith("json") ||
    name.startsWith("path") ||
    name.startsWith("shell") ||
    name.startsWith("tmp-openclaw-dir")
  ) {
    return "core-runtime-infra-files-commands";
  }
  if (name.startsWith("provider-usage") || name.startsWith("push-")) {
    return "core-runtime-infra-provider-push";
  }
  if (
    name.startsWith("kysely") ||
    name.startsWith("session") ||
    name.startsWith("sqlite") ||
    name.startsWith("stale-lock") ||
    name.startsWith("state-migrations")
  ) {
    return "core-runtime-infra-storage-state";
  }
  if (
    name.startsWith("channel") ||
    name.startsWith("plugin") ||
    name.startsWith("pairing") ||
    name.startsWith("voicewake")
  ) {
    return "core-runtime-infra-channel-plugin";
  }
  if (
    name.startsWith("package") ||
    name.startsWith("ports") ||
    name.startsWith("process") ||
    name.startsWith("restart") ||
    name.startsWith("runtime") ||
    name.startsWith("run-node") ||
    name.startsWith("system") ||
    name.startsWith("update")
  ) {
    return "core-runtime-infra-system-runtime";
  }
  if (
    name.startsWith("dotenv") ||
    name.startsWith("env") ||
    name.startsWith("gemini-auth") ||
    name.startsWith("google-api") ||
    name.startsWith("home-dir") ||
    name.startsWith("host-env") ||
    name.startsWith("openclaw-exec-env") ||
    name.startsWith("secret") ||
    name.startsWith("secure-random")
  ) {
    return "core-runtime-infra-env-auth";
  }
  if (
    name.startsWith("build-stamp") ||
    name.startsWith("changelog") ||
    name.startsWith("clawhub") ||
    name.startsWith("detect-package-manager") ||
    name.startsWith("git-") ||
    name.startsWith("openclaw-root") ||
    name.startsWith("tsdown") ||
    name.startsWith("vitest")
  ) {
    return "core-runtime-infra-repo-tooling";
  }
  if (
    name.startsWith("scp") ||
    name.startsWith("ssh") ||
    name.startsWith("tailnet") ||
    name.startsWith("tailscale") ||
    name.startsWith("tcp") ||
    name.startsWith("tls/") ||
    name.startsWith("transport") ||
    name.startsWith("widearea") ||
    name.startsWith("windows") ||
    name.startsWith("ws") ||
    name.startsWith("wsl")
  ) {
    return "core-runtime-infra-network-platform";
  }
  if (
    name.startsWith("abort") ||
    name.startsWith("backoff") ||
    name.startsWith("errors") ||
    name.startsWith("fatal-error") ||
    name.startsWith("fetch") ||
    name.startsWith("fixed-window") ||
    name.startsWith("format-time/") ||
    name.startsWith("http-body") ||
    name.startsWith("parse-finite-number") ||
    name.startsWith("plain-object") ||
    name.startsWith("prototype-keys") ||
    name.startsWith("retry") ||
    name.startsWith("warning-filter")
  ) {
    return "core-runtime-infra-core-utils";
  }
  if (
    name.startsWith("browser") ||
    name.startsWith("cli-") ||
    name.startsWith("clipboard") ||
    name.startsWith("control-ui") ||
    name.startsWith("embedded") ||
    name.startsWith("is-main")
  ) {
    return "core-runtime-infra-cli-ui";
  }
  if (
    name.startsWith("agent-events") ||
    name.startsWith("event-session") ||
    name.startsWith("infra-") ||
    name.startsWith("non-fatal") ||
    name.startsWith("supervisor") ||
    name.startsWith("unhandled")
  ) {
    return "core-runtime-infra-events-runtime";
  }
  if (
    name.startsWith("boundary") ||
    name.startsWith("hardlink") ||
    name.startsWith("replace-file") ||
    name.startsWith("resolve-system-bin") ||
    name.startsWith("safe-package-install") ||
    name.startsWith("stable-node-path") ||
    name.startsWith("watch-node")
  ) {
    return "core-runtime-infra-file-safety";
  }
  if (name.startsWith("dedupe") || name.startsWith("disk-space")) {
    return "core-runtime-infra-misc-dedupe-disk";
  }
  if (
    name.startsWith("inline-option-token") ||
    name.startsWith("map-size") ||
    name.startsWith("machine-name")
  ) {
    return "core-runtime-infra-misc-values";
  }
  if (name.startsWith("os-summary")) {
    return "core-runtime-infra-misc-os";
  }
  return "core-runtime-infra-misc";
}

function createInfraSplitShards() {
  const groups = new Map();
  for (const file of listTestFiles("src/infra")) {
    const shardName = resolveInfraShardName(file);
    groups.set(shardName, [...(groups.get(shardName) ?? []), file]);
  }

  return [
    "core-runtime-infra-approval-exec",
    "core-runtime-infra-channel-plugin",
    "core-runtime-infra-cli-ui",
    "core-runtime-infra-device",
    "core-runtime-infra-diagnostics-state",
    "core-runtime-infra-core-utils",
    "core-runtime-infra-env-auth",
    "core-runtime-infra-events-runtime",
    "core-runtime-infra-file-safety",
    "core-runtime-infra-files-commands",
    "core-runtime-infra-gateway-lock-argv",
    "core-runtime-infra-gateway-processes",
    "core-runtime-infra-gateway-watch",
    "core-runtime-infra-heartbeat-core",
    "core-runtime-infra-heartbeat-runner",
    "core-runtime-infra-misc",
    "core-runtime-infra-misc-dedupe-disk",
    "core-runtime-infra-misc-os",
    "core-runtime-infra-misc-values",
    "core-runtime-infra-net-install",
    "core-runtime-infra-network-node",
    "core-runtime-infra-network-platform",
    "core-runtime-infra-outbound-actions",
    "core-runtime-infra-outbound-core",
    "core-runtime-infra-provider-push",
    "core-runtime-infra-repo-tooling",
    "core-runtime-infra-storage-state",
    "core-runtime-infra-system-runtime",
  ]
    .map((shardName) => ({
      configs: ["test/vitest/vitest.infra.config.ts"],
      includePatterns: groups.get(shardName) ?? [],
      requiresDist: false,
      runner: "blacksmith-4vcpu-ubuntu-2404",
      shardName,
    }))
    .filter((shard) => shard.includePatterns.length > 0);
}

// The broad unit-fast graph is import-bound (~180s of module evaluation on an
// 8 vCPU runner as one job); striping the file list halves the wall clock.
// Isolated and fake-timer projects stay whole: they are small and own
// worker-isolation semantics that include lists must not slice.
function createUnitFastSplitShards() {
  const timerTestFiles = new Set(getUnitFastTimerTestFiles());
  const isolatedTestFiles = new Set(getUnitFastIsolatedTestFiles());
  const stripeFiles = getUnitFastTestFiles().filter(
    (file) => !timerTestFiles.has(file) && !isolatedTestFiles.has(file),
  );
  return [
    ...createStripedBatches(stripeFiles, UNIT_FAST_NODE_TEST_STRIPES).map(
      (includePatterns, index) => ({
        shardName: `core-unit-fast-${index + 1}`,
        configs: ["test/vitest/vitest.unit-fast.config.ts"],
        includePatterns,
        requiresDist: false,
      }),
    ),
    {
      shardName: "core-unit-fast-isolated",
      configs: [
        "test/vitest/vitest.unit-fast-isolated.config.ts",
        "test/vitest/vitest.unit-fast-fake-timers.config.ts",
      ],
      requiresDist: false,
    },
  ];
}

// Tooling is test-time bound (~170s of spawned-process tests as one serial
// job). Both the full and compact plans consume these stripes; the compact
// packer keeps them in exclusive bins via EXCLUSIVE_COMPACT_GROUP_RE.
function createToolingSplitShards() {
  return [
    ...createStripedBatches(listCompactToolingTestFiles(), COMPACT_TOOLING_NODE_TEST_GROUPS).map(
      (includePatterns, index) => ({
        shardName: `core-tooling-${index + 1}`,
        configs: [TOOLING_CONFIG],
        includePatterns,
        requiresDist: false,
      }),
    ),
    {
      shardName: "core-tooling-isolated",
      configs: ["test/vitest/vitest.tooling-docker.config.ts", TOOLING_ISOLATED_CONFIG],
      requiresDist: false,
    },
  ];
}

const SPLIT_NODE_SHARDS = new Map([
  ["core-unit-fast", createUnitFastSplitShards()],
  ["core-tooling", createToolingSplitShards()],
  [
    "core-unit-src",
    [
      {
        shardName: "core-unit-src-security",
        configs: [
          "test/vitest/vitest.unit-src.config.ts",
          "test/vitest/vitest.unit-security.config.ts",
        ],
        includeExternalConfigs: true,
        requiresDist: false,
      },
    ],
  ],
  ["core-unit-security", []],
  [
    "core-unit-support",
    [
      {
        shardName: "core-unit-support",
        configs: ["test/vitest/vitest.unit-support.config.ts"],
        requiresDist: false,
      },
    ],
  ],
  [
    "core-runtime",
    [
      {
        shardName: "core-runtime-hooks",
        configs: ["test/vitest/vitest.hooks.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
      },
      ...createInfraSplitShards(),
      {
        shardName: "core-runtime-secrets",
        configs: ["test/vitest/vitest.secrets.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
      },
      {
        shardName: "core-runtime-infra-process",
        configs: [
          "test/vitest/vitest.logging.config.ts",
          "test/vitest/vitest.process.config.ts",
          "test/vitest/vitest.runtime-config.config.ts",
        ],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
      },
      {
        shardName: "core-runtime-tui-pty",
        configs: ["test/vitest/vitest.tui-pty.config.ts"],
        env: {
          OPENCLAW_TUI_PTY_INCLUDE_LOCAL: "1",
        },
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
      },
      {
        shardName: "core-runtime-media-ui",
        configs: [
          "test/vitest/vitest.media.config.ts",
          "test/vitest/vitest.media-understanding.config.ts",
          "test/vitest/vitest.tui.config.ts",
          "test/vitest/vitest.ui.config.ts",
          "test/vitest/vitest.ui-isolated.config.ts",
          "test/vitest/vitest.wizard.config.ts",
        ],
        requiresDist: false,
      },
      {
        shardName: "core-runtime-shared",
        configs: [
          "test/vitest/vitest.acp.config.ts",
          "test/vitest/vitest.shared-core.config.ts",
          "test/vitest/vitest.tasks.config.ts",
          "test/vitest/vitest.utils.config.ts",
        ],
        requiresDist: false,
      },
      ...createCronSplitShards(),
    ],
  ],
  [
    "auto-reply",
    [
      {
        shardName: "auto-reply-core-top-level",
        configs: [
          "test/vitest/vitest.auto-reply-core.config.ts",
          "test/vitest/vitest.auto-reply-top-level.config.ts",
        ],
        requiresDist: false,
      },
      ...createAutoReplyReplySplitShards(),
    ],
  ],
  [
    "agentic",
    [
      ...createGatewayServerSplitShards(),
      {
        shardName: "agentic-cli",
        configs: ["test/vitest/vitest.cli.config.ts"],
        requiresDist: false,
      },
      {
        shardName: "agentic-command-support",
        configs: [
          "test/vitest/vitest.commands-light.config.ts",
          "test/vitest/vitest.daemon.config.ts",
        ],
        requiresDist: false,
      },
      ...createAgenticCommandSplitShards(),
      ...createAgentCoreSplitShards(),
      {
        shardName: "agentic-agents-embedded",
        configs: ["test/vitest/vitest.agents-embedded-agent.config.ts"],
        requiresDist: false,
      },
      {
        shardName: "agentic-agents-support",
        configs: ["test/vitest/vitest.agents-support.config.ts"],
        requiresDist: false,
      },
      {
        shardName: "agentic-agents-tools",
        configs: ["test/vitest/vitest.agents-tools.config.ts"],
        requiresDist: false,
      },
      {
        shardName: "agentic-gateway-core",
        configs: [
          "test/vitest/vitest.gateway-core.config.ts",
          "test/vitest/vitest.gateway-client.config.ts",
        ],
        requiresDist: false,
      },
      {
        shardName: "agentic-gateway-methods",
        configs: ["test/vitest/vitest.gateway-methods.config.ts"],
        requiresDist: false,
      },
      {
        shardName: "agentic-plugin-sdk",
        configs: [
          "test/vitest/vitest.plugin-sdk-light.config.ts",
          "test/vitest/vitest.plugin-sdk.config.ts",
        ],
        requiresDist: false,
      },
      {
        shardName: "agentic-plugins",
        configs: ["test/vitest/vitest.plugins.config.ts"],
        requiresDist: false,
      },
    ],
  ],
]);
const DIST_DEPENDENT_NODE_SHARD_NAMES = new Set(["core-support-boundary"]);

function formatNodeTestShardCheckName(shardName) {
  const normalizedShardName = shardName.startsWith("core-unit-")
    ? `core-${shardName.slice("core-unit-".length)}`
    : shardName;
  return `checks-node-${normalizedShardName}`;
}

/** Create node test shard descriptors for CI, optionally excluding release-only plugin shards. */
export function createNodeTestShards(options = {}) {
  const includeReleaseOnlyPluginShards = options.includeReleaseOnlyPluginShards ?? true;

  return fullSuiteVitestShards.flatMap((shard) => {
    if (EXCLUDED_FULL_SUITE_SHARDS.has(shard.config)) {
      return [];
    }

    const configs = shard.projects.filter((config) => !EXCLUDED_PROJECT_CONFIGS.has(config));
    if (configs.length === 0) {
      return [];
    }

    const splitShards = SPLIT_NODE_SHARDS.get(shard.name);
    if (splitShards) {
      return splitShards.flatMap((splitShard) => {
        if (
          RELEASE_ONLY_PLUGIN_SHARDS.has(splitShard.shardName) &&
          !includeReleaseOnlyPluginShards
        ) {
          return [];
        }

        const splitConfigs = splitShard.includeExternalConfigs
          ? splitShard.configs
          : splitShard.configs.filter((config) => configs.includes(config));
        if (splitConfigs.length === 0) {
          return [];
        }

        return [
          {
            checkName: formatNodeTestShardCheckName(splitShard.shardName),
            shardName: splitShard.shardName,
            configs: splitConfigs,
            ...(splitShard.env ? { env: splitShard.env } : {}),
            ...(splitShard.includePatterns ? { includePatterns: splitShard.includePatterns } : {}),
            runner: splitShard.runner ?? DEFAULT_NODE_TEST_RUNNER,
            requiresDist: splitShard.requiresDist,
          },
        ];
      });
    }

    return [
      {
        checkName: formatNodeTestShardCheckName(shard.name),
        shardName: shard.name,
        configs,
        runner: DEFAULT_NODE_TEST_RUNNER,
        requiresDist: DIST_DEPENDENT_NODE_SHARD_NAMES.has(shard.name),
      },
    ];
  });
}

function resolveCiNodeTestRunner(shard) {
  if (shard.runner !== DEFAULT_NODE_TEST_RUNNER) {
    return shard.runner;
  }
  return KEEP_LARGE_NODE_TEST_RUNNER.has(shard.shardName)
    ? DEFAULT_NODE_TEST_RUNNER
    : BUNDLED_NODE_TEST_RUNNER;
}

function bundleNameForConfigs(configs) {
  const config = configs[0] ?? "node";
  return config
    .replace(/^test\/vitest\/vitest\./u, "")
    .replace(/\.config\.ts$/u, "")
    .replace(/[^a-z0-9-]+/giu, "-");
}

function compareFullNodeTestAdmissionOrder(a, b) {
  const fallbackPriority = FULL_NODE_TEST_ADMISSION_PRIORITY.size;
  return (
    (FULL_NODE_TEST_ADMISSION_PRIORITY.get(a.shardName) ?? fallbackPriority) -
      (FULL_NODE_TEST_ADMISSION_PRIORITY.get(b.shardName) ?? fallbackPriority) ||
    a.checkName.localeCompare(b.checkName)
  );
}

function stripeFileWeight(file) {
  return STRIPE_FILE_SECONDS_HINTS.get(file) ?? DEFAULT_STRIPE_FILE_SECONDS;
}

// Deterministic cost-aware striping (greedy LPT): heaviest files first, each
// into the currently lightest batch. Round-robin by discovery order packed one
// whale next to another and left sibling stripes ~10x lighter.
function createStripedBatches(values, batchCount) {
  const entries = values.map((value, index) => ({
    index,
    value,
    weight: stripeFileWeight(value),
  }));
  entries.sort((a, b) => b.weight - a.weight || a.index - b.index);
  const batches = Array.from({ length: batchCount }, () => ({ totalWeight: 0, entries: [] }));
  for (const entry of entries) {
    let target = batches[0];
    for (const batch of batches) {
      if (batch.totalWeight < target.totalWeight) {
        target = batch;
      }
    }
    target.totalWeight += entry.weight;
    target.entries.push(entry);
  }
  // Keep discovery order inside each stripe so include lists stay stable.
  return batches.map((batch) =>
    batch.entries.toSorted((a, b) => a.index - b.index).map((entry) => entry.value),
  );
}

function listCompactToolingTestFiles() {
  const unitFastFiles = getUnitFastTestFilesForIncludePatterns([
    "test/**/*.test.ts",
    "src/scripts/**/*.test.ts",
  ]);
  const excludedFiles = new Set([
    ...boundaryTestFiles,
    ...unitFastFiles,
    TOOLING_DOCKER_TEST_FILE,
    ...toolingIsolatedTestFiles,
  ]);
  return [...listTestFiles("test"), ...listTestFiles("src/scripts")].filter(
    (file) =>
      !file.startsWith("test/fixtures/") &&
      !file.endsWith(".e2e.test.ts") &&
      !file.endsWith(".live.test.ts") &&
      !excludedFiles.has(file),
  );
}

/**
 * Collapse split include-pattern shards into bounded jobs for normal CI.
 * The base plan remains unchanged for release and coverage consumers.
 */
export function createNodeTestShardBundles(options = {}) {
  if (options.compact === true) {
    return createCompactNodeTestShardBundles(options);
  }

  const shards = createNodeTestShards(options);
  const unbundled = [];
  const groups = new Map();

  for (const shard of shards) {
    const runner = resolveCiNodeTestRunner(shard);
    if (
      shard.requiresDist ||
      shard.configs.length !== 1 ||
      !BUNDLEABLE_NODE_TEST_CONFIGS.has(shard.configs[0]) ||
      !Array.isArray(shard.includePatterns) ||
      shard.includePatterns.length === 0
    ) {
      unbundled.push({ ...shard, runner });
      continue;
    }

    const key = JSON.stringify([shard.configs, shard.requiresDist, runner]);
    const group = groups.get(key) ?? {
      configs: shard.configs,
      requiresDist: shard.requiresDist,
      runner,
      shards: [],
    };
    group.shards.push(shard);
    groups.set(key, group);
  }

  const bundled = [];
  for (const group of groups.values()) {
    const bins = [];
    const sortedShards = group.shards.toSorted(
      (a, b) =>
        (b.includePatterns?.length ?? 0) - (a.includePatterns?.length ?? 0) ||
        a.shardName.localeCompare(b.shardName),
    );
    for (const shard of sortedShards) {
      const patterns = shard.includePatterns ?? [];
      for (let offset = 0; offset < patterns.length; offset += MAX_BUNDLED_NODE_TEST_PATTERNS) {
        const chunk = patterns.slice(offset, offset + MAX_BUNDLED_NODE_TEST_PATTERNS);
        const bin = bins.find(
          (candidate) =>
            candidate.includePatterns.length + chunk.length <= MAX_BUNDLED_NODE_TEST_PATTERNS,
        );
        if (bin) {
          bin.includePatterns.push(...chunk);
        } else {
          bins.push({ includePatterns: [...chunk] });
        }
      }
    }

    const runnerClass = group.runner.includes("-8vcpu-") ? "large" : "small";
    const bundleName = `${bundleNameForConfigs(group.configs)}-${runnerClass}`;
    for (const [index, bin] of bins.entries()) {
      const shardName = `bundle-${bundleName}-${index + 1}`;
      bundled.push({
        checkName: formatNodeTestShardCheckName(shardName),
        shardName,
        configs: group.configs,
        includePatterns: bin.includePatterns.toSorted((a, b) => a.localeCompare(b)),
        runner: group.runner,
        requiresDist: group.requiresDist,
      });
    }
  }

  return [...unbundled, ...bundled].toSorted(compareFullNodeTestAdmissionOrder);
}

/**
 * Mark one semantic cache producer without coupling persistence to matrix order.
 * The broad core unit graph is shared by most shards; precise changed plans
 * fall back to their first (normally only) job.
 */
export function assignVitestFsCacheWriter(shards) {
  const preferredIndex = shards.findIndex(
    (shard) =>
      shard.shardName.startsWith("core-unit-fast") ||
      shard.groups?.some((group) => group.shard_name.startsWith("core-unit-fast")),
  );
  const writerIndex = preferredIndex >= 0 ? preferredIndex : shards.length > 0 ? 0 : -1;
  return shards.map((shard, index) => ({
    ...shard,
    saveVitestFsCache: index === writerIndex,
  }));
}

function createCompactNodeTestShardBundles(options = {}) {
  const shards = createNodeTestShards(options);
  const groupsByRunner = new Map();

  for (const shard of shards) {
    const runner = resolveCiNodeTestRunner(shard);
    const key = JSON.stringify([runner, shard.requiresDist]);
    const groups = groupsByRunner.get(key) ?? [];
    const group = {
      configs: shard.configs,
      ...(shard.env ? { env: shard.env } : {}),
      ...(shard.includePatterns ? { includePatterns: shard.includePatterns } : {}),
      requiresDist: shard.requiresDist,
      runner,
      shard_name: shard.shardName,
    };
    groups.push(applyCompactGroupWorkerPins(group));
    groupsByRunner.set(key, groups);
  }

  const compactJobs = [];
  for (const groups of groupsByRunner.values()) {
    // First-fit decreasing on estimated serial seconds keeps every job near
    // the same runtime; the old per-file weights let one 3-minute group land
    // next to nine trivial ones and own the PR wall clock.
    const bins = [];
    const sortedGroups = groups.toSorted(
      (a, b) =>
        estimateCompactGroupSeconds(b) - estimateCompactGroupSeconds(a) ||
        a.shard_name.localeCompare(b.shard_name),
    );
    for (const group of sortedGroups) {
      const weight = estimateCompactGroupSeconds(group);
      const exclusive = isExclusiveCompactGroup(group);
      const secondsCap = exclusive ? COMPACT_EXCLUSIVE_JOB_SECONDS : COMPACT_NODE_TEST_JOB_SECONDS;
      const bin = bins.find(
        (candidate) =>
          candidate.exclusive === exclusive &&
          candidate.groups.length < COMPACT_NODE_TEST_JOB_GROUPS &&
          candidate.weight + weight <= secondsCap,
      );
      if (bin) {
        bin.groups.push(group);
        bin.weight += weight;
        bin.hasWholeConfigGroup ||= !group.includePatterns;
      } else {
        bins.push({
          exclusive,
          groups: [group],
          hasWholeConfigGroup: !group.includePatterns,
          weight,
        });
      }
    }

    for (const [index, bin] of bins.entries()) {
      const runnerClass = bin.groups[0].runner.includes("-8vcpu-") ? "large" : "small";
      const distSuffix = bin.groups[0].requiresDist ? "-dist" : "";
      compactJobs.push({
        checkName: `checks-node-compact-${runnerClass}${distSuffix}-${index + 1}`,
        groups: bin.groups,
        requiresDist: bin.groups[0].requiresDist,
        runner: bin.groups[0].runner,
        shardName: `compact-${runnerClass}${distSuffix}-${index + 1}`,
        // Whole-config groups run entire suites; keep their generous timeout.
        ...(bin.hasWholeConfigGroup
          ? { timeoutMinutes: COMPACT_WHOLE_NODE_TEST_TIMEOUT_MINUTES }
          : {}),
        // Every compact bin runs its plans serially. Overlapping two Vitest
        // runs on one runner starves timing-sensitive tests on both runner
        // classes (worker-startup timeouts on 4 vCPU, UI-animation and
        // lock-timing flakes on 8 vCPU), and the packed weights are
        // contention-inflated so serializing is roughly wall-neutral.
        planConcurrency: 1,
      });
    }
  }

  return compactJobs.toSorted((a, b) => a.checkName.localeCompare(b.checkName));
}

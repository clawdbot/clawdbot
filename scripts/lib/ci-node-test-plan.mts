// Builds CI node/Vitest shard plans from the full suite configuration.
import { matchesGlob, relative } from "node:path";
import {
  agentVitestProjectOwners,
  embeddedAgentVitestProjectOwners,
} from "../../test/vitest/vitest.agents-paths.mjs";
import { commandsLightTestFiles } from "../../test/vitest/vitest.commands-light-paths.mjs";
import {
  gatewayServerExcludedTestFiles,
  gatewayServerIsolatedTestFiles,
  isGatewayServerBackedHttpTestFile,
  isGatewayServerTestFile,
} from "../../test/vitest/vitest.gateway-server-paths.mjs";
import { fullSuiteVitestShards } from "../../test/vitest/vitest.test-shards.mjs";
import { toolingIsolatedTestFiles } from "../../test/vitest/vitest.tooling-isolated-paths.mjs";
import { uiIsolatedTestFiles } from "../../test/vitest/vitest.ui-isolated-paths.mjs";
import {
  getUnitFastIsolatedTestFiles,
  getUnitFastTestFiles,
  getUnitFastTestFilesForIncludePatterns,
  getUnitFastTimerTestFiles,
} from "../../test/vitest/vitest.unit-fast-paths.mjs";
import { boundaryTestFiles, isUnitConfigTestFile } from "../../test/vitest/vitest.unit-paths.mjs";
import { readCompactGroupTimings } from "./ci-test-timings.mts";
import { listTrackedTestFiles } from "./list-test-files.mts";
import {
  resolveVitestPretestBuildMode,
  type VitestPretestBuildMode as NodeTestPretestBuildMode,
} from "./vitest-build-prerequisites.mts";

type NodeTestShardGroup = {
  shard_name: string;
  configs: string[];
  includePatterns?: string[];
  pretestBuildMode?: NodeTestPretestBuildMode;
  requiresDist: boolean;
  runner: string;
  env?: Record<string, string>;
};

type NodeTestShard = {
  checkName: string;
  shardName: string;
  configs: string[];
  runner: string;
  requiresDist: boolean;
  pretestBuildMode?: NodeTestPretestBuildMode;
  includePatterns?: string[];
  env?: Record<string, string>;
  groups?: NodeTestShardGroup[];
  timeoutMinutes?: number;
  planConcurrency?: number;
  predictedSeconds?: number;
};

type NodeTestPlanOptions = {
  includeReleaseOnlyPluginShards?: boolean;
  compact?: boolean;
  compactMode?: CompactNodeTestPlanMode;
  compactGroupCount?: number;
  compactWholeGroupCount?: number;
  runnerBackend?: string;
};

type CompactNodeTestPlanMode = "pull-request" | "push";

type PolicyTestWatch = {
  ownerGlobs?: readonly string[];
  testFile: string;
  watchGlobs: readonly string[];
};

// These tests read source trees instead of importing every file whose policy
// they enforce. Boundary and contract suites have dedicated always-on lanes;
// this inventory covers the remaining tests that changed targeting cannot
// discover from imports alone.
const policyTestWatches = [
  {
    testFile: "ui/src/components/web-awesome-migration.node.test.ts",
    watchGlobs: ["ui/src/**/*.ts"],
  },
  {
    testFile: "ui/src/styles/base-theme-tokens.node.test.ts",
    ownerGlobs: ["ui/src/**/*.css", "ui/public/themes/*.css"],
    watchGlobs: ["ui/src/**/*.css", "ui/src/**/*.ts", "ui/public/themes/*.css"],
  },
  {
    testFile: "ui/src/styles/base-theme-contrast.node.test.ts",
    ownerGlobs: ["ui/src/styles/base.css", "ui/public/themes/*.css"],
    watchGlobs: ["ui/src/styles/base.css", "ui/public/themes/*.css"],
  },
  {
    testFile: "ui/src/styles/cursor-policy.node.test.ts",
    ownerGlobs: ["ui/index.html", "ui/src/**/*.css"],
    watchGlobs: ["ui/index.html", "ui/src/**/*.css", "ui/src/**/*.ts"],
  },
  ...[
    "src/cron/service.stream-trigger.test.ts",
    "src/cron/service.stream-validation.test.ts",
    "src/cron/service/timer.timeout-watchdog.test.ts",
  ].map((testFile) => ({
    testFile,
    ownerGlobs: ["src/cron/failure-notification-text.ts"],
    watchGlobs: ["src/cron/failure-notification-text.ts"],
  })),
] satisfies readonly PolicyTestWatch[];

function normalizeChangedPath(changedPath: string): string {
  return changedPath.replaceAll("\\", "/").replace(/^\.\//u, "");
}

/** Resolve policy tests whose scanned source surface intersects this diff. */
export function resolvePolicyTestTargets(changedPaths: readonly string[]): string[] {
  const normalizedPaths = changedPaths.map(normalizeChangedPath);
  return policyTestWatches
    .filter(({ watchGlobs }) =>
      normalizedPaths.some((changedPath) =>
        watchGlobs.some((watchGlob) => matchesGlob(changedPath, watchGlob)),
      ),
    )
    .map(({ testFile }) => testFile);
}

/** True when the policy tests are the complete bounded owner for this path. */
export function isPolicyTestOwnedPath(changedPath: string): boolean {
  const normalizedPath = normalizeChangedPath(changedPath);
  return policyTestWatches.some(({ ownerGlobs }) =>
    ownerGlobs?.some((ownerGlob) => matchesGlob(normalizedPath, ownerGlob)),
  );
}

type CompactNodeTestShard = Omit<NodeTestShard, "configs" | "groups"> & {
  groups: NodeTestShardGroup[];
};

type NodeTestSplitShard = Omit<NodeTestShard, "checkName" | "runner" | "pretestBuildMode"> & {
  includeExternalConfigs?: boolean;
  runner?: string;
};

type CompactBin = {
  exclusive: boolean;
  groups: NodeTestShardGroup[];
  hasWholeConfigGroup: boolean;
  weight: number;
};

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
// The first embedded-agent file owns 157 serial tests and can stay quiet for
// more than five minutes on a cold GitHub-hosted fork runner. Keep the outer
// watchdog above the scoped 600-second hook budget so it cannot preempt Vitest.
const AGENTS_EMBEDDED_AGENT_ENV = {
  OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "660000",
};
const COMPACT_EMBEDDED_GROUP_NAMES = [
  "agentic-agents-embedded-base",
  "agentic-agents-embedded-incomplete-turn",
  "agentic-agents-embedded-overflow-compaction",
  "agentic-agents-embedded-run",
];
const MAX_BUNDLED_NODE_TEST_PATTERNS = 64;
// Compact bundles trade a little serial work for fewer ephemeral runner registrations.
// Keep runner classes and subprocess isolation intact while bounding each combined job.
// Default Blacksmith plans pack the Blacksmith base hints with 200s/276s
// admission caps. GitHub-hosted plans use direct hosted hints with 90s/95s
// packing caps. Hybrid keeps the expanded topology but packs its attempt-1
// Blacksmith rows with the refit Blacksmith estimates below.
const COMPACT_LARGE_NODE_TEST_JOB_SECONDS = 200;
const COMPACT_SMALL_NODE_TEST_JOB_SECONDS = 276;
const COMPACT_GITHUB_LARGE_NODE_TEST_JOB_SECONDS = 90;
const COMPACT_GITHUB_SMALL_NODE_TEST_JOB_SECONDS = 95;
const COMPACT_GITHUB_GROUP_SECONDS_SCALE = 1.6;
const COMPACT_HYBRID_GROUP_SECONDS_SCALE = 0.87;
// Split groups above this hosted prediction before packing. Hybrid reuses the
// hosted-derived splits so retries cannot reunite an oversized hosted group.
const COMPACT_GITHUB_MAX_PREDICTED_SECONDS = 150;
const COMPACT_GITHUB_NODE_TEST_JOB_CAP = 96;
const COMPACT_NODE_TEST_JOB_GROUPS = 10;
const COMPACT_TOOLING_NODE_TEST_GROUPS = 7;
const COMPACT_WHOLE_NODE_TEST_TIMEOUT_MINUTES = 120;
// Route measured queue-tail bins to existing 8-vCPU capacity after packing so
// the planner keeps the same groups, coverage, and runner-registration count.
const COMPACT_8VCPU_CHECK_NAMES = new Set([
  "checks-node-compact-small-2",
  "checks-node-compact-small-5",
  "checks-node-compact-small-8",
]);
const AUTO_REPLY_COMMANDS_STRIPES = 3;
const AGENTS_CORE_RUNNER_CLI_STRIPES = 3;
const AGENTIC_GATEWAY_CORE_STRIPES = 3;
const CORE_RUNTIME_MEDIA_UI_STRIPES = 3;
const CORE_UNIT_SRC_SECURITY_STRIPES = 3;
const UNIT_FAST_NODE_TEST_STRIPES = 2;
// Cold-start fallback when committed CI measurements are missing. Refresh
// config/ci-test-timings.json with pnpm ci:timings:refit, not these literals.
const COMPACT_GROUP_SECONDS_HINTS = new Map<string, number>([
  ["agentic-agents-core-auth", 30],
  ["agentic-agents-core-isolated", 18],
  ["agentic-agents-core-models", 41],
  ["agentic-agents-core-runner-cli-1", 6],
  ["agentic-agents-core-runner-cli-2", 13],
  ["agentic-agents-core-runner-cli-3", 7],
  ["agentic-agents-core-runner-commands", 28],
  ["agentic-agents-core-runner-embedded", 17],
  ["agentic-agents-core-runner-sessions", 14],
  ["agentic-agents-core-runtime", 106],
  ["agentic-agents-core-subagents", 20],
  ["agentic-agents-core-tools", 39],
  // The composite hint sets the job count before its independent configs are
  // striped across those jobs; its estimate is the sum of the split medians.
  ["agentic-agents-embedded", 166],
  ["agentic-agents-embedded-base", 81],
  ["agentic-agents-embedded-incomplete-turn", 19],
  ["agentic-agents-embedded-overflow-compaction", 20],
  ["agentic-agents-embedded-run", 46],
  ["agentic-agents-support", 165],
  ["agentic-agents-tools", 69],
  // The measured 131s pair split per config; apportioned by the hosted
  // per-config walls (139s/67s) until direct Blacksmith samples exist.
  ["agentic-cli", 88],
  ["agentic-cli-process", 43],
  ["agentic-command-support", 49],
  ["agentic-commands-agent-channel", 76],
  ["agentic-commands-doctor", 23],
  ["agentic-commands-doctor-auth", 19],
  ["agentic-commands-doctor-config-state", 67],
  ["agentic-commands-doctor-device", 2],
  ["agentic-commands-doctor-gateway", 3],
  ["agentic-commands-doctor-platform", 5],
  ["agentic-commands-doctor-plugins-tools", 13],
  ["agentic-commands-doctor-sessions-cron", 31],
  ["agentic-commands-doctor-shared", 37],
  ["agentic-commands-doctor-whatsapp", 1],
  ["agentic-commands-doctor-workspace", 1],
  ["agentic-commands-models", 32],
  ["agentic-commands-onboard-config", 49],
  ["agentic-commands-status-tools", 35],
  ["agentic-control-plane-agent-chat", 167],
  ["agentic-control-plane-auth-node", 166],
  ["agentic-control-plane-http-models", 41],
  ["agentic-control-plane-http-plugin-ws", 52],
  ["agentic-control-plane-runtime", 19],
  ["agentic-control-plane-runtime-config", 20],
  ["agentic-control-plane-runtime-cron", 22],
  ["agentic-control-plane-runtime-network", 1],
  ["agentic-control-plane-runtime-server", 23],
  ["agentic-control-plane-runtime-shared-token", 9],
  ["agentic-control-plane-runtime-state", 33],
  ["agentic-control-plane-runtime-ui-tools", 9],
  ["agentic-control-plane-startup-config", 5],
  ["agentic-control-plane-startup-core", 31],
  ["agentic-control-plane-startup-health-runtime", 11],
  ["agentic-control-plane-startup-restart-close", 10],
  ["agentic-gateway-core-1", 99],
  ["agentic-gateway-core-2", 99],
  ["agentic-gateway-core-3", 99],
  // One small file that pays a full cold module graph because it runs isolated.
  ["agentic-gateway-server-isolated", 30],
  ["agentic-gateway-methods", 157],
  ["agentic-plugin-sdk", 45],
  ["auto-reply-core-top-level", 27],
  ["auto-reply-reply-agent-runner", 60],
  ["auto-reply-reply-commands-1", 28],
  ["auto-reply-reply-commands-2", 9],
  ["auto-reply-reply-commands-3", 24],
  ["auto-reply-reply-dispatch", 15],
  ["auto-reply-reply-dispatch-core", 35],
  ["auto-reply-reply-dispatch-delivery", 32],
  ["auto-reply-reply-dispatch-lifecycle", 8],
  ["auto-reply-reply-session", 34],
  ["auto-reply-reply-state-routing", 63],
  // Apportioned from the split infra-process trio (see below).
  ["core-runtime-config", 113],
  ["core-runtime-cron-core", 25],
  ["core-runtime-cron-isolated-agent", 105],
  ["core-runtime-cron-service", 58],
  ["core-runtime-hooks", 19],
  ["core-runtime-infra-approval-exec", 28],
  ["core-runtime-infra-channel-plugin", 19],
  ["core-runtime-infra-cli-ui", 2],
  ["core-runtime-infra-core-utils", 3],
  ["core-runtime-infra-device", 8],
  ["core-runtime-infra-diagnostics-state", 24],
  ["core-runtime-infra-env-auth", 6],
  ["core-runtime-infra-events-runtime", 8],
  ["core-runtime-infra-file-safety", 2],
  ["core-runtime-infra-files-commands", 5],
  ["core-runtime-infra-gateway-lock-argv", 3],
  ["core-runtime-infra-gateway-processes", 1],
  ["core-runtime-infra-gateway-watch", 1],
  ["core-runtime-infra-heartbeat-core", 7],
  ["core-runtime-infra-heartbeat-runner", 59],
  ["core-runtime-infra-misc", 14],
  ["core-runtime-infra-misc-dedupe-disk", 1],
  ["core-runtime-infra-misc-os", 1],
  ["core-runtime-infra-misc-values", 2],
  ["core-runtime-infra-net-install", 11],
  ["core-runtime-infra-network-node", 3],
  ["core-runtime-infra-network-platform", 5],
  ["core-runtime-infra-outbound-actions", 37],
  ["core-runtime-infra-outbound-core", 59],
  // The measured 126s trio split; apportioned by the hosted per-config walls
  // (17s/157s) until direct Blacksmith samples exist.
  ["core-runtime-infra-process", 13],
  ["core-runtime-infra-provider-push", 13],
  ["core-runtime-infra-repo-tooling", 4],
  ["core-runtime-infra-storage-state", 104],
  ["core-runtime-infra-system-runtime", 36],
  ["core-runtime-media-ui-1", 93],
  ["core-runtime-media-ui-2", 93],
  ["core-runtime-media-ui-3", 93],
  ["core-runtime-media-ui-support", 100],
  ["core-runtime-secrets", 61],
  ["core-runtime-shared", 67],
  // This dist-only group is outside the sampled nondist logs and retains its
  // prior measured hint. The exclusive-bin cap keeps its lane lightly packed.
  ["core-runtime-tui-pty", 116],
  // Run 31789504347 attempt 1 put the old tooling cohort on the compact tail
  // at 267s. Seven balanced stripes project that three-way cohort to ~115s.
  ["core-tooling-1", 115],
  ["core-tooling-2", 115],
  ["core-tooling-3", 115],
  ["core-tooling-4", 115],
  ["core-tooling-5", 115],
  ["core-tooling-6", 115],
  ["core-tooling-7", 115],
  ["core-tooling-isolated", 37],
  ["core-unit-fast-1", 66],
  ["core-unit-fast-2", 64],
  // The measured 116s pair split per config; apportioned by the hosted
  // per-config walls (158s/32s) until direct Blacksmith samples exist.
  ["core-unit-fast-fake-timers", 20],
  ["core-unit-fast-isolated", 96],
  ["core-unit-src-security-1", 101],
  ["core-unit-src-security-2", 101],
  ["core-unit-src-security-3", 101],
  ["core-unit-src-security-support", 12],
  ["core-unit-support", 20],
]);

// Rounded mean of the same 8-vCPU groups across successful canonical-main
// compact runs 31684307744, 31683213137, 31682494259, 31682258389,
// 31681118857, 31680010311, 31678309660, 31678086868, and 31677305067.
// Means expose recurrent slow tails hidden by medians without moving the
// post-pack 4-vCPU runner advisory.
const COMPACT_LARGE_GROUP_STRIPE_SECONDS_HINTS = new Map<string, number>([
  ["agentic-agents-core-auth", 33],
  ["agentic-agents-core-models", 41],
  ["agentic-agents-core-runner-cli-1", 7],
  ["agentic-agents-core-runner-cli-2", 14],
  ["agentic-agents-core-runner-cli-3", 7],
  ["agentic-agents-core-runner-commands", 28],
  ["agentic-agents-core-runner-embedded", 20],
  ["agentic-agents-core-runner-sessions", 16],
  ["agentic-agents-core-runtime", 119],
  ["agentic-agents-core-subagents", 21],
  ["agentic-agents-core-tools", 47],
  ["agentic-agents-embedded-base", 79],
  ["agentic-agents-embedded-incomplete-turn", 20],
  ["agentic-agents-embedded-overflow-compaction", 21],
  ["agentic-agents-embedded-run", 47],
  ["agentic-agents-support", 165],
  ["agentic-control-plane-startup-core", 33],
  // Run 31691151297 measured 296.68s for gateway-core and 303.93s for unit-src.
  // Run 31694057974 measured the two isolated UI envelopes at 159.50s and
  // 120.55s. Rebalance those walls over the three-way LPT weights: 457/455/455,
  // 633/634/633, and 393/393/393 respectively.
  ["agentic-gateway-core-1", 99],
  ["agentic-gateway-core-2", 99],
  ["agentic-gateway-core-3", 99],
  ["agentic-gateway-methods", 153],
  ["auto-reply-reply-commands-1", 34],
  ["auto-reply-reply-commands-2", 11],
  ["auto-reply-reply-commands-3", 28],
  ["auto-reply-reply-dispatch", 18],
  ["auto-reply-reply-dispatch-core", 42],
  ["auto-reply-reply-dispatch-delivery", 38],
  ["auto-reply-reply-dispatch-lifecycle", 10],
  ["core-runtime-media-ui-1", 93],
  ["core-runtime-media-ui-2", 93],
  ["core-runtime-media-ui-3", 93],
  ["core-runtime-media-ui-support", 100],
  ["core-unit-fast-1", 68],
  ["core-unit-fast-2", 67],
  ["core-unit-fast-fake-timers", 21],
  ["core-unit-fast-isolated", 96],
  ["core-unit-src-security-1", 101],
  ["core-unit-src-security-2", 101],
  ["core-unit-src-security-3", 101],
  ["core-unit-src-security-support", 12],
]);

// Rounded medians from standard 4-core GitHub-hosted runs 31737316152,
// 31742781948, 31749838728, 31754493208, 31776290645, 31784022043, and
// 31784883914. Exclude failed samples and reject media-ui-3's 444s compact
// retry sample because its log records a 300s no-output timeout; its three
// healthy samples are 52-63s. Tooling uses the five-way projection above
// until the reshuffled groups have direct samples. Unmeasured groups use the
// scale above.
const COMPACT_GITHUB_GROUP_SECONDS_HINTS = new Map<string, number>([
  ["agentic-agents-core-auth", 50],
  ["agentic-agents-core-isolated", 23],
  ["agentic-agents-core-models", 72],
  ["agentic-agents-core-runner-cli-1", 16],
  ["agentic-agents-core-runner-cli-2", 25],
  ["agentic-agents-core-runner-cli-3", 23],
  ["agentic-agents-core-runner-commands", 55],
  ["agentic-agents-core-runner-embedded", 30],
  ["agentic-agents-core-runner-sessions", 23],
  ["agentic-agents-core-runtime", 185],
  ["agentic-agents-core-subagents", 29],
  ["agentic-agents-core-tools", 83],
  ["agentic-agents-embedded", 234],
  ["agentic-agents-embedded-base", 139],
  ["agentic-agents-embedded-incomplete-turn", 3],
  ["agentic-agents-embedded-overflow-compaction", 31],
  ["agentic-agents-embedded-run", 62],
  ["agentic-agents-support", 253],
  ["agentic-agents-tools", 124],
  // Measured per config inside run 31814517685's combined 206s wall.
  ["agentic-cli", 139],
  ["agentic-cli-process", 67],
  ["agentic-command-support", 67],
  ["agentic-commands-agent-channel", 121],
  ["agentic-commands-doctor", 33],
  ["agentic-commands-doctor-auth", 32],
  ["agentic-commands-doctor-config-state", 124],
  ["agentic-commands-doctor-device", 5],
  ["agentic-commands-doctor-gateway", 8],
  ["agentic-commands-doctor-platform", 7],
  ["agentic-commands-doctor-plugins-tools", 21],
  ["agentic-commands-doctor-sessions-cron", 60],
  ["agentic-commands-doctor-shared", 61],
  ["agentic-commands-doctor-whatsapp", 2],
  ["agentic-commands-doctor-workspace", 3],
  ["agentic-commands-models", 64],
  ["agentic-commands-onboard-config", 76],
  ["agentic-commands-status-tools", 57],
  ["agentic-control-plane-agent-chat", 232],
  ["agentic-control-plane-auth-node", 254],
  ["agentic-control-plane-http-models", 59],
  ["agentic-control-plane-http-plugin-ws", 86],
  ["agentic-control-plane-runtime", 31],
  ["agentic-control-plane-runtime-config", 31],
  ["agentic-control-plane-runtime-cron", 52],
  ["agentic-control-plane-runtime-network", 2],
  ["agentic-control-plane-runtime-server", 54],
  ["agentic-control-plane-runtime-shared-token", 28],
  ["agentic-control-plane-runtime-state", 55],
  ["agentic-control-plane-runtime-ui-tools", 31],
  ["agentic-control-plane-startup-config", 15],
  ["agentic-control-plane-startup-core", 51],
  ["agentic-control-plane-startup-health-runtime", 31],
  ["agentic-control-plane-startup-restart-close", 28],
  ["agentic-gateway-core-1", 128],
  ["agentic-gateway-core-2", 149],
  ["agentic-gateway-core-3", 141],
  ["agentic-gateway-methods", 169],
  ["agentic-plugin-sdk", 70],
  ["auto-reply-core-top-level", 43],
  ["auto-reply-reply-agent-runner", 114],
  ["auto-reply-reply-commands-1", 53],
  ["auto-reply-reply-commands-2", 26],
  ["auto-reply-reply-commands-3", 48],
  ["auto-reply-reply-dispatch", 30],
  ["auto-reply-reply-dispatch-core", 75],
  ["auto-reply-reply-dispatch-delivery", 70],
  ["auto-reply-reply-dispatch-lifecycle", 20],
  ["auto-reply-reply-session", 79],
  ["auto-reply-reply-state-routing", 34],
  // Measured per config inside run 31814517685's combined 175s infra wall.
  ["core-runtime-config", 157],
  ["core-runtime-cron-core", 44],
  ["core-runtime-cron-isolated-agent", 154],
  ["core-runtime-cron-service", 131],
  ["core-runtime-hooks", 31],
  ["core-runtime-infra-approval-exec", 45],
  ["core-runtime-infra-channel-plugin", 30],
  ["core-runtime-infra-cli-ui", 3],
  ["core-runtime-infra-core-utils", 7],
  ["core-runtime-infra-device", 13],
  ["core-runtime-infra-diagnostics-state", 34],
  ["core-runtime-infra-env-auth", 10],
  ["core-runtime-infra-events-runtime", 11],
  ["core-runtime-infra-file-safety", 4],
  ["core-runtime-infra-files-commands", 7],
  ["core-runtime-infra-gateway-lock-argv", 3],
  ["core-runtime-infra-gateway-processes", 1],
  ["core-runtime-infra-gateway-watch", 1],
  ["core-runtime-infra-heartbeat-core", 10],
  ["core-runtime-infra-heartbeat-runner", 106],
  ["core-runtime-infra-misc", 33],
  ["core-runtime-infra-misc-dedupe-disk", 1],
  ["core-runtime-infra-misc-os", 1],
  ["core-runtime-infra-misc-values", 2],
  ["core-runtime-infra-net-install", 17],
  ["core-runtime-infra-network-node", 5],
  ["core-runtime-infra-network-platform", 8],
  ["core-runtime-infra-outbound-actions", 53],
  ["core-runtime-infra-outbound-core", 112],
  // Measured per config inside run 31814517685's combined 175s wall.
  ["core-runtime-infra-process", 17],
  ["core-runtime-infra-provider-push", 29],
  ["core-runtime-infra-repo-tooling", 6],
  ["core-runtime-infra-storage-state", 235],
  ["core-runtime-infra-system-runtime", 69],
  ["core-runtime-media-ui-1", 97],
  ["core-runtime-media-ui-2", 78],
  ["core-runtime-media-ui-3", 54],
  ["core-runtime-media-ui-support", 101],
  ["core-runtime-secrets", 73],
  ["core-runtime-shared", 92],
  ["core-tooling-1", 115],
  ["core-tooling-2", 115],
  ["core-tooling-3", 115],
  ["core-tooling-4", 115],
  ["core-tooling-5", 115],
  ["core-tooling-6", 115],
  ["core-tooling-7", 115],
  ["core-tooling-isolated", 41],
  ["core-unit-fast-1", 85],
  ["core-unit-fast-2", 84],
  // Measured per config inside run 31814517685's combined 190s wall.
  ["core-unit-fast-fake-timers", 32],
  ["core-unit-fast-isolated", 158],
  ["core-unit-src-security-1", 132],
  ["core-unit-src-security-2", 131],
  ["core-unit-src-security-3", 132],
  ["core-unit-src-security-support", 20],
  ["core-unit-support", 32],
]);

// Hybrid-specific Blacksmith observations, plus the gateway-core-3 139.5s spike
// in 31938297538 that must stay singleton.
// Sum a shard's per-config Duration lines before taking a median; pooling them
// reads as a large over-prediction that is not there. Normalize each run by its
// own VM speed (median of every shard's duration over that shard's cross-run
// median) before comparing, or a slow draw looks like a hint miss.
// Values below are VM-normalized medians over runs 32316204633, 32317242374,
// 32318250756, and 32320063231 (2026-08-20). Across 100 groups the GitHub hints
// run 0.64x on Blacksmith, so only the ones that overshoot are pinned here:
// leaving these low packs partners onto the tallest bins, which set the wall.
const COMPACT_HYBRID_GROUP_SECONDS_HINTS = new Map<string, number>([
  ["agentic-agents-core-models", 81],
  ["agentic-cli-process", 110],
  ["agentic-commands-doctor", 83],
  ["agentic-gateway-core-3", 140],
  ["core-runtime-cron-service", 108],
  ["core-runtime-infra-process", 35],
]);

// Advisory per-file wall-clock hints (seconds) for stripe balancing, measured
// from single-file local runs (M4 Max) and static import-graph size. Packing
// only: a stale entry skews stripe balance but never correctness. Unlisted
// files use the default, which mostly reflects the per-file module-graph
// re-evaluation cost that dominates these serial suites.
const STRIPE_FILE_SECONDS_HINTS = new Map<string, number>([
  // cli-runner entries are CI wall clock (begin->checkmark deltas from the
  // compact runs above), refreshed by focused Testbox profiling where noted.
  ["src/agents/cli-runner.context-engine.test.ts", 6],
  // Fresh profile: 5.1s total, 3.8s import; retain a conservative packing hint.
  ["src/agents/cli-runner.reliability.test.ts", 8],
  ["src/agents/cli-runner.spawn.test.ts", 45],
  // The few CI-derived slow-file hints needed for the three new stripes are
  // rounded checkmark durations from canonical-main run 31691151297.
  ["src/auto-reply/reply/commands-export-session.test.ts", 8],
  ["src/auto-reply/reply/commands-gating.test.ts", 6],
  ["src/auto-reply/reply/commands-learn.test.ts", 8],
  ["src/auto-reply/reply/commands-plugins.install.test.ts", 6],
  ["src/auto-reply/reply/commands-status.test.ts", 12],
  ["src/auto-reply/reply/commands-system-prompt.test.ts", 8],
  ["src/gateway/dashboard-session-title.test.ts", 23],
  // Successful run 32172905415: 26.9s and 15.9s. Without direct hints the
  // hosted agent-chat splitter prices both at 3s and puts them in one stripe.
  ["src/gateway/server.sessions.create.test.ts", 27],
  ["src/gateway/server.chat.gateway-server-chat.test.ts", 16],
  // Storage-state stripe anchors: CI checkmark walls from compact run
  // 31814517685; without them the hosted split packs all three fat files
  // into one stripe (observed 204s vs the ~90s target in run 31856622489).
  ["src/infra/state-migrations.test.ts", 27],
  ["src/infra/sqlite-snapshot.test.ts", 24],
  ["src/infra/session-cost-usage.test.ts", 10],
  ["src/infra/state-migrations.audit-logs.test.ts", 7],
  ["src/gateway/managed-image-attachments.test.ts", 24],
  ["src/gateway/session-message-events.test.ts", 26],
  ["src/gateway/tool-resolution.test.ts", 43],
  ["src/scripts/test-projects.test.ts", 21],
  ["ui/src/components/app-sidebar.test.ts", 28],
  ["ui/src/pages/chat/chat-responsive.browser.test.ts", 30],
  // Focused cold proof is ~34s after right-sizing and concurrent crash phases.
  ["test/scripts/bench-sqlite-reliability.test.ts", 34],
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
const COMPACT_PUSH_EXCLUDED_SHARDS = new Set([
  "core-runtime-tui-pty",
  ...Array.from(
    { length: COMPACT_TOOLING_NODE_TEST_GROUPS },
    (_, index) => `core-tooling-${index + 1}`,
  ),
  "core-tooling-isolated",
]);
// Spawn/signal-timing suites (process-group waits, PTY smoke) flake when a
// concurrent sibling Vitest run competes for the 4 vCPU runner. Pack them
// into bins the shard runner executes at concurrency 1.
const EXCLUSIVE_COMPACT_GROUP_RE =
  /^core-tooling(?:-\d+(?:-hosted-\d+)?|-isolated)$|^core-runtime-tui-pty$/u;
// Exclusive bins run serially, so their packed estimate is their wall clock.
const COMPACT_EXCLUSIVE_JOB_SECONDS = 150;

function isExclusiveCompactGroup(group: NodeTestShardGroup): boolean {
  return EXCLUSIVE_COMPACT_GROUP_RE.test(group.shard_name);
}

// Spawn/signal/PTY-timing suites also flake under high in-process worker
// counts; pin them to the proven 2-worker budget while the job-level default
// scales with the runner class. infra-process spawns child processes per test
// and hit worker-startup timeouts under contention before serialization.
const PINNED_WORKER_COMPACT_GROUP_RE =
  /^core-tooling(?:-\d+(?:-hosted-\d+)?|-isolated)$|^core-runtime-tui-pty$|^core-runtime-infra-process$|^core-runtime-config$|^core-runtime-media-ui-(?:\d+|support)$|^agentic-cli(?:-process)?$|^agentic-gateway-(?:core-\d+|methods)$/u;
const PINNED_COMPACT_GROUP_ENV = { OPENCLAW_VITEST_MAX_WORKERS: "2" };

function applyCompactGroupWorkerPins(group: NodeTestShardGroup): NodeTestShardGroup {
  if (!PINNED_WORKER_COMPACT_GROUP_RE.test(group.shard_name)) {
    return group;
  }
  return { ...group, env: { ...group.env, ...PINNED_COMPACT_GROUP_ENV } };
}

function estimateDefaultCompactGroupSeconds(group: NodeTestShardGroup): number {
  const hint =
    readCompactGroupTimings("blacksmith")[group.shard_name] ??
    COMPACT_GROUP_SECONDS_HINTS.get(group.shard_name);
  if (hint !== undefined) {
    return hint;
  }
  if (Array.isArray(group.includePatterns)) {
    return Math.max(3, Math.round(group.includePatterns.length * DEFAULT_SECONDS_PER_TEST_FILE));
  }
  return DEFAULT_WHOLE_GROUP_SECONDS;
}

function usesExpandedRunnerProfile(runnerBackend: string | undefined): boolean {
  return runnerBackend === "github" || runnerBackend === "hybrid";
}

function estimateHybridCompactGroupSeconds(group: NodeTestShardGroup, seconds: number): number {
  // The 4,723s Blacksmith push hint sum measured 3,742.046s/3,756.674s
  // (79.230%/79.540%) in runs 31945998653/31949756966. A 0.87 scale keeps
  // 9.379% headroom above the higher ratio. With direct outlier hints, it sits
  // one point above the 0.86 packing cliff.
  return (
    COMPACT_HYBRID_GROUP_SECONDS_HINTS.get(group.shard_name) ??
    Math.round(seconds * COMPACT_HYBRID_GROUP_SECONDS_SCALE)
  );
}

function estimateCompactGroupSeconds(
  group: NodeTestShardGroup,
  runnerBackend: string | undefined,
): number {
  const defaultSeconds = estimateDefaultCompactGroupSeconds(group);
  // Hybrid attempt 1 runs on Blacksmith. It keeps the expanded topology for
  // hosted retries, but its packing weights must describe the runner that
  // normally executes the plan.
  if (runnerBackend === "hybrid") {
    return estimateHybridCompactGroupSeconds(group, defaultSeconds);
  }
  if (runnerBackend !== "github") {
    return defaultSeconds;
  }
  return (
    readCompactGroupTimings("github")[group.shard_name] ??
    COMPACT_GITHUB_GROUP_SECONDS_HINTS.get(group.shard_name) ??
    Math.round(defaultSeconds * COMPACT_GITHUB_GROUP_SECONDS_SCALE)
  );
}

function estimateCompactStripeSeconds(
  group: NodeTestShardGroup,
  runnerBackend: string | undefined,
): number {
  if (runnerBackend === "github") {
    return estimateCompactGroupSeconds(group, runnerBackend);
  }
  const blacksmithSeconds =
    COMPACT_LARGE_GROUP_STRIPE_SECONDS_HINTS.get(group.shard_name) ??
    estimateDefaultCompactGroupSeconds(group);
  return runnerBackend === "hybrid"
    ? estimateHybridCompactGroupSeconds(group, blacksmithSeconds)
    : blacksmithSeconds;
}

// Equal-weight sibling stripes can otherwise land in one bin and recreate the
// indivisible critical-path floor that striping removes.
function compactGiantStripeFamily(group: NodeTestShardGroup): string | undefined {
  return /^(agentic-gateway-core|core-runtime-media-ui|core-unit-src-security)-\d+$/u.exec(
    group.shard_name,
  )?.[1];
}

function expandCompactGroup(group: NodeTestShardGroup): NodeTestShardGroup[] {
  if (group.shard_name !== "agentic-agents-embedded") {
    return [group];
  }
  if (group.configs.length !== COMPACT_EMBEDDED_GROUP_NAMES.length) {
    throw new Error("embedded compact group names must cover every config");
  }

  const expandedGroups: NodeTestShardGroup[] = [];
  for (const [index, config] of group.configs.entries()) {
    const shardName = COMPACT_EMBEDDED_GROUP_NAMES[index];
    if (!shardName) {
      throw new Error("embedded compact group name is missing");
    }
    expandedGroups.push({
      ...group,
      configs: [config],
      shard_name: shardName,
    });
  }
  return expandedGroups;
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
  ["core-tooling-5", 1],
  ["core-tooling-6", 1],
  ["core-tooling-7", 1],
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
  "agentic-gateway-core-1",
  "agentic-gateway-core-2",
  "agentic-gateway-core-3",
  "agentic-gateway-methods",
  "auto-reply-reply-dispatch",
  "auto-reply-reply-dispatch-core",
  "auto-reply-reply-dispatch-delivery",
  "auto-reply-reply-dispatch-lifecycle",
  // The commands stripes and security suite are import-bound (30-45s of
  // module-graph import per file); the 8 vCPU class with a higher Vitest
  // worker budget cuts their wall clock roughly linearly.
  "auto-reply-reply-commands-1",
  "auto-reply-reply-commands-2",
  "auto-reply-reply-commands-3",
  "core-runtime-media-ui-1",
  "core-runtime-media-ui-2",
  "core-runtime-media-ui-3",
  "core-runtime-media-ui-support",
  "core-unit-fast-1",
  "core-unit-fast-2",
  "core-unit-fast-isolated",
  "core-unit-src-security-1",
  "core-unit-src-security-2",
  "core-unit-src-security-3",
  "core-unit-src-security-support",
]);
const RELEASE_ONLY_PLUGIN_SHARDS = new Set(["agentic-plugins"]);
function listTestFiles(rootDir: string): string[] {
  return listTrackedTestFiles(rootDir);
}

function createAutoReplyReplySplitShards(): NodeTestSplitShard[] {
  const files = listTestFiles("src/auto-reply/reply");
  const groups = {
    "auto-reply-reply-agent-runner": [] as string[],
    "auto-reply-reply-commands": [] as string[],
    "auto-reply-reply-dispatch": [] as string[],
    "auto-reply-reply-dispatch-core": [] as string[],
    "auto-reply-reply-dispatch-delivery": [] as string[],
    "auto-reply-reply-dispatch-lifecycle": [] as string[],
    "auto-reply-reply-session": [] as string[],
    "auto-reply-reply-state-routing": [] as string[],
  };
  const dispatchEntrypoints = new Map<string, keyof typeof groups>([
    ["dispatch-from-config.test.ts", "auto-reply-reply-dispatch-core"],
    ["dispatch-from-config.delivery.test.ts", "auto-reply-reply-dispatch-delivery"],
    ["dispatch-from-config.lifecycle.test.ts", "auto-reply-reply-dispatch-lifecycle"],
  ]);

  for (const file of files) {
    const name = relative("src/auto-reply/reply", file).replaceAll("\\", "/");
    const dispatchEntrypointGroup = dispatchEntrypoints.get(name);
    if (dispatchEntrypointGroup) {
      groups[dispatchEntrypointGroup].push(file);
      continue;
    }
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
        return createStripedBatches(
          includePatterns,
          AUTO_REPLY_COMMANDS_STRIPES,
          stripeFileWeight,
        ).map((batch, index) => ({
          configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
          includePatterns: batch,
          requiresDist: false,
          shardName: `${groupName}-${index + 1}`,
        }));
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

function resolveCommandShardName(file: string): string {
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

function createAgenticCommandSplitShards(): NodeTestSplitShard[] {
  const commandsLightTests = new Set(commandsLightTestFiles);
  const groups = new Map<string, string[]>();
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

function resolveAgentCoreShardName(file: string): string {
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

function createAgentCoreSplitShards(): NodeTestSplitShard[] {
  const isolatedTests = new Set(agentVitestProjectOwners.coreIsolated.include);
  const groups = new Map<string, string[]>();
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
        return createStripedBatches(
          includePatterns,
          AGENTS_CORE_RUNNER_CLI_STRIPES,
          stripeFileWeight,
        ).map((batch, index) => ({
          configs: [agentVitestProjectOwners.core.config],
          includePatterns: batch,
          requiresDist: false,
          shardName: `${shardName}-${index + 1}`,
        }));
      }
      return [
        {
          configs: [agentVitestProjectOwners.core.config],
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
      configs: [agentVitestProjectOwners.coreIsolated.config],
      includePatterns: agentVitestProjectOwners.coreIsolated.include,
      requiresDist: false,
      shardName: "agentic-agents-core-isolated",
    },
  ];
}

function resolveGatewayStartupShardName(file: string): string {
  const name = relative("src/gateway", file).replaceAll("\\", "/");
  if (name.startsWith("server-startup-config") || name.startsWith("server-startup-early")) {
    return "agentic-control-plane-startup-config";
  }
  if (
    name.startsWith("server-runtime") ||
    name.startsWith("server.health") ||
    name.startsWith("server.lazy")
  ) {
    return "agentic-control-plane-startup-health-runtime";
  }
  if (name.startsWith("server-restart") || name === "server-close.test.ts") {
    return "agentic-control-plane-startup-restart-close";
  }
  return "agentic-control-plane-startup-core";
}

function resolveGatewayServerShardName(file: string): string {
  const name = relative("src/gateway", file).replaceAll("\\", "/");
  if (
    isGatewayServerBackedHttpTestFile(file) ||
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
    name.startsWith("server.tools-catalog")
  ) {
    return "agentic-control-plane-runtime-ui-tools";
  }
  if (name.startsWith("server.")) {
    return "agentic-control-plane-runtime-state";
  }
  return "agentic-control-plane-runtime";
}

function createGatewayServerSplitShards(): NodeTestSplitShard[] {
  const groups = new Map<string, string[]>();
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

function resolveCronShardName(file: string): string {
  const name = relative("src/cron", file).replaceAll("\\", "/");
  if (name.startsWith("isolated-agent")) {
    return "core-runtime-cron-isolated-agent";
  }
  if (name.startsWith("service")) {
    return "core-runtime-cron-service";
  }
  return "core-runtime-cron-core";
}

function createCronSplitShards(): NodeTestSplitShard[] {
  const groups = new Map<string, string[]>();
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

function resolveInfraShardName(file: string): string {
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

function createInfraSplitShards(): NodeTestSplitShard[] {
  const groups = new Map<string, string[]>();
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
function createUnitFastSplitShards(): NodeTestSplitShard[] {
  const timerTestFiles = new Set(getUnitFastTimerTestFiles());
  const isolatedTestFiles = new Set(getUnitFastIsolatedTestFiles());
  const stripeFiles = getUnitFastTestFiles().filter(
    (file) => !timerTestFiles.has(file) && !isolatedTestFiles.has(file),
  );
  return [
    ...createStripedBatches(stripeFiles, UNIT_FAST_NODE_TEST_STRIPES, stripeFileWeight).map(
      (includePatterns, index) => ({
        shardName: `core-unit-fast-${index + 1}`,
        configs: ["test/vitest/vitest.unit-fast.config.ts"],
        includePatterns,
        requiresDist: false,
      }),
    ),
    // Split per config: the combined pair owned a ~190s hosted wall that no
    // bin packing could shorten, while the halves fit normal lanes.
    {
      shardName: "core-unit-fast-isolated",
      configs: ["test/vitest/vitest.unit-fast-isolated.config.ts"],
      requiresDist: false,
    },
    {
      shardName: "core-unit-fast-fake-timers",
      configs: ["test/vitest/vitest.unit-fast-fake-timers.config.ts"],
      requiresDist: false,
    },
  ];
}

// Tooling is test-time bound (~170s of spawned-process tests as one serial
// job). Full and PR-fallback plans consume these stripes; push compacts omit
// them. The compact packer keeps retained tooling in exclusive bins.
function createToolingSplitShards(): NodeTestSplitShard[] {
  return [
    ...createStripedBatches(
      listCompactToolingTestFiles(),
      COMPACT_TOOLING_NODE_TEST_GROUPS,
      stripeFileWeight,
    ).map((includePatterns, index) => ({
      shardName: `core-tooling-${index + 1}`,
      configs: [TOOLING_CONFIG],
      includePatterns,
      requiresDist: false,
    })),
    {
      shardName: "core-tooling-isolated",
      configs: ["test/vitest/vitest.tooling-docker.config.ts", TOOLING_ISOLATED_CONFIG],
      requiresDist: false,
    },
  ];
}

function isStripeEligibleTestFile(file: string, unitFastFiles: ReadonlySet<string>): boolean {
  return (
    !unitFastFiles.has(file) && !file.endsWith(".e2e.test.ts") && !file.endsWith(".live.test.ts")
  );
}

function createStripedSplitShards(params: {
  configs: string[];
  files: string[];
  includeExternalConfigs?: boolean;
  shardName: string;
  stripeCount: number;
}): NodeTestSplitShard[] {
  return createStripedBatches(params.files, params.stripeCount, stripeFileWeight).map(
    (includePatterns, index) => ({
      configs: params.configs,
      includeExternalConfigs: params.includeExternalConfigs,
      includePatterns,
      requiresDist: false,
      shardName: `${params.shardName}-${index + 1}`,
    }),
  );
}

function createCoreUnitSrcSecuritySplitShards(): NodeTestSplitShard[] {
  const unitFastFiles = new Set(getUnitFastTestFiles());
  const files = listTestFiles("src").filter(
    (file) =>
      isStripeEligibleTestFile(file, unitFastFiles) &&
      !file.startsWith("src/acp/") &&
      !file.startsWith("src/security/") &&
      isUnitConfigTestFile(file),
  );
  return [
    ...createStripedSplitShards({
      configs: ["test/vitest/vitest.unit-src.config.ts"],
      files,
      shardName: "core-unit-src-security",
      stripeCount: CORE_UNIT_SRC_SECURITY_STRIPES,
    }),
    {
      configs: ["test/vitest/vitest.unit-security.config.ts"],
      includeExternalConfigs: true,
      requiresDist: false,
      shardName: "core-unit-src-security-support",
    },
  ];
}

function createCoreRuntimeMediaUiSplitShards(): NodeTestSplitShard[] {
  const unitFastFiles = new Set(getUnitFastTestFiles());
  const isolatedUiFiles = new Set(uiIsolatedTestFiles);
  const files = listTestFiles("ui/src").filter(
    (file) => isStripeEligibleTestFile(file, unitFastFiles) && !isolatedUiFiles.has(file),
  );
  return [
    ...createStripedSplitShards({
      configs: ["test/vitest/vitest.ui.config.ts"],
      files,
      shardName: "core-runtime-media-ui",
      stripeCount: CORE_RUNTIME_MEDIA_UI_STRIPES,
    }),
    {
      configs: [
        "test/vitest/vitest.media.config.ts",
        "test/vitest/vitest.media-understanding.config.ts",
        "test/vitest/vitest.tui.config.ts",
        "test/vitest/vitest.ui-isolated.config.ts",
        "test/vitest/vitest.wizard.config.ts",
      ],
      requiresDist: false,
      shardName: "core-runtime-media-ui-support",
    },
  ];
}

function createAgenticGatewayCoreSplitShards(): NodeTestSplitShard[] {
  const unitFastFiles = new Set(getUnitFastTestFiles());
  const excludedGatewayFiles = new Set([
    ...gatewayServerExcludedTestFiles,
    ...gatewayServerIsolatedTestFiles,
  ]);
  const gatewayFiles = listTestFiles("src/gateway").filter(
    (file) =>
      isStripeEligibleTestFile(file, unitFastFiles) &&
      !file.startsWith("src/gateway/server-methods/") &&
      !isGatewayServerTestFile(file) &&
      !excludedGatewayFiles.has(file),
  );
  const packageFiles = ["packages/gateway-client/src", "packages/gateway-protocol/src"]
    .flatMap((rootDir) => listTestFiles(rootDir))
    .filter((file) => isStripeEligibleTestFile(file, unitFastFiles));
  return createStripedSplitShards({
    configs: [
      "test/vitest/vitest.gateway-core.config.ts",
      "test/vitest/vitest.gateway-client.config.ts",
    ],
    files: [...gatewayFiles, ...packageFiles],
    shardName: "agentic-gateway-core",
    stripeCount: AGENTIC_GATEWAY_CORE_STRIPES,
  });
}

const SPLIT_NODE_SHARDS = new Map<string, NodeTestSplitShard[]>([
  ["core-unit-fast", createUnitFastSplitShards()],
  ["core-tooling", createToolingSplitShards()],
  ["core-unit-src", createCoreUnitSrcSecuritySplitShards()],
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
      // runtime-config owns ~90% of the former three-config wall; keeping it
      // separate lets the hosted splitter stripe it while logging/process
      // stay a cheap pair.
      {
        shardName: "core-runtime-infra-process",
        configs: ["test/vitest/vitest.logging.config.ts", "test/vitest/vitest.process.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
      },
      {
        shardName: "core-runtime-config",
        configs: ["test/vitest/vitest.runtime-config.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
      },
      {
        shardName: "core-runtime-tui-pty",
        configs: ["test/vitest/vitest.tui-pty.config.ts"],
        env: {
          OPENCLAW_TUI_PTY_INCLUDE_LOCAL: "1",
          OPENCLAW_TUI_PTY_USE_BUILT_CLI: "1",
        },
        requiresDist: true,
        runner: "blacksmith-4vcpu-ubuntu-2404",
      },
      ...createCoreRuntimeMediaUiSplitShards(),
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
        shardName: "agentic-gateway-server-isolated",
        configs: ["test/vitest/vitest.gateway-server-isolated.config.ts"],
        requiresDist: false,
      },
      // Split per config: the combined pair owned a ~206s hosted wall that no
      // bin packing could shorten, while the halves fit normal lanes.
      {
        shardName: "agentic-cli",
        configs: ["test/vitest/vitest.cli.config.ts"],
        requiresDist: false,
      },
      {
        shardName: "agentic-cli-process",
        configs: ["test/vitest/vitest.cli-process.config.ts"],
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
        configs: embeddedAgentVitestProjectOwners.map((owner) => owner.config),
        env: AGENTS_EMBEDDED_AGENT_ENV,
        requiresDist: false,
      },
      {
        shardName: "agentic-agents-support",
        configs: [agentVitestProjectOwners.support.config],
        requiresDist: false,
      },
      {
        shardName: "agentic-agents-tools",
        configs: [agentVitestProjectOwners.tools.config],
        requiresDist: false,
      },
      ...createAgenticGatewayCoreSplitShards(),
      {
        shardName: "agentic-gateway-methods",
        configs: [
          "test/vitest/vitest.gateway-methods.config.ts",
          "test/vitest/vitest.gateway-methods-isolated.config.ts",
        ],
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

function formatNodeTestShardCheckName(shardName: string): string {
  const normalizedShardName = shardName.startsWith("core-unit-")
    ? `core-${shardName.slice("core-unit-".length)}`
    : shardName;
  return `checks-node-${normalizedShardName}`;
}

/** Create node test shard descriptors for CI, optionally excluding release-only plugin shards. */
export function createNodeTestShards(options: NodeTestPlanOptions = {}): NodeTestShard[] {
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

        const pretestBuildMode = resolveVitestPretestBuildMode([
          { configs: splitConfigs, includePatterns: splitShard.includePatterns },
        ]);

        return [
          {
            checkName: formatNodeTestShardCheckName(splitShard.shardName),
            shardName: splitShard.shardName,
            configs: splitConfigs,
            ...(splitShard.env ? { env: splitShard.env } : {}),
            ...(splitShard.includePatterns ? { includePatterns: splitShard.includePatterns } : {}),
            ...(pretestBuildMode ? { pretestBuildMode } : {}),
            runner: splitShard.runner ?? DEFAULT_NODE_TEST_RUNNER,
            requiresDist: splitShard.requiresDist,
          },
        ];
      });
    }

    const pretestBuildMode = resolveVitestPretestBuildMode([{ configs }]);
    return [
      {
        checkName: formatNodeTestShardCheckName(shard.name),
        shardName: shard.name,
        configs,
        ...(pretestBuildMode ? { pretestBuildMode } : {}),
        runner: DEFAULT_NODE_TEST_RUNNER,
        requiresDist: DIST_DEPENDENT_NODE_SHARD_NAMES.has(shard.name),
      },
    ];
  });
}

/** Select planner envelopes that produce the protected Vitest transform-cache seed. */
export function createVitestCacheWarmGroups(): Array<{
  configs: string[];
  env?: Record<string, string>;
  includePatterns?: string[];
  shard_name: string;
}> {
  const additionalShardNames = new Set([
    "agentic-agents-embedded",
    "agentic-gateway-methods",
    "auto-reply-reply-commands-3",
  ]);
  const allShards = createNodeTestShards();
  const coreShards = allShards.filter((candidate) =>
    candidate.shardName.startsWith("core-unit-fast"),
  );
  if (coreShards.length === 0) {
    throw new Error("core-unit-fast cache seed shards are missing");
  }
  const additionalShards = allShards.filter((candidate) =>
    additionalShardNames.has(candidate.shardName),
  );
  const foundAdditionalShardNames = new Set(additionalShards.map((shard) => shard.shardName));
  const missingShardNames = [...additionalShardNames].filter(
    (name) => !foundAdditionalShardNames.has(name),
  );
  if (missingShardNames.length > 0) {
    throw new Error(`cache seed shards are missing: ${missingShardNames.join(", ")}`);
  }
  return [...coreShards, ...additionalShards].flatMap((shard) =>
    shard.configs.map((config) => ({
      configs: [config],
      ...(shard.env ? { env: shard.env } : {}),
      ...(shard.includePatterns ? { includePatterns: shard.includePatterns } : {}),
      shard_name: `cache-warm:${shard.shardName}:${config}`,
    })),
  );
}

function resolveCiNodeTestRunner(shard: NodeTestShard): string {
  if (shard.runner !== DEFAULT_NODE_TEST_RUNNER) {
    return shard.runner;
  }
  return KEEP_LARGE_NODE_TEST_RUNNER.has(shard.shardName)
    ? DEFAULT_NODE_TEST_RUNNER
    : BUNDLED_NODE_TEST_RUNNER;
}

function bundleNameForConfigs(configs: string[]): string {
  const config = configs[0] ?? "node";
  return config
    .replace(/^test\/vitest\/vitest\./u, "")
    .replace(/\.config\.ts$/u, "")
    .replace(/[^a-z0-9-]+/giu, "-");
}

function compareFullNodeTestAdmissionOrder(a: NodeTestShard, b: NodeTestShard): number {
  const fallbackPriority = FULL_NODE_TEST_ADMISSION_PRIORITY.size;
  return (
    (FULL_NODE_TEST_ADMISSION_PRIORITY.get(a.shardName) ?? fallbackPriority) -
      (FULL_NODE_TEST_ADMISSION_PRIORITY.get(b.shardName) ?? fallbackPriority) ||
    a.checkName.localeCompare(b.checkName)
  );
}

function stripeFileWeight(file: string): number {
  return STRIPE_FILE_SECONDS_HINTS.get(file) ?? DEFAULT_STRIPE_FILE_SECONDS;
}

// Deterministic cost-aware batching (greedy LPT): heaviest values first, each
// into the currently lightest batch. Round-robin by discovery order can pack
// one whale next to another and leave sibling batches much lighter.
function createStripedBatches<T>(
  values: T[],
  batchCount: number,
  weightForValue: (value: T) => number,
  avoidBatchKeyForValue?: (value: T) => string | undefined,
): T[][] {
  if (batchCount < 1) {
    throw new Error("striped batch count must be positive");
  }
  const entries = values.map((value, index) => ({
    index,
    value,
    weight: weightForValue(value),
  }));
  entries.sort((a, b) => b.weight - a.weight || a.index - b.index);
  const batches: Array<{
    totalWeight: number;
    entries: Array<{ index: number; value: T; weight: number }>;
  }> = Array.from({ length: batchCount }, () => ({ totalWeight: 0, entries: [] }));
  const firstBatch = batches[0];
  if (!firstBatch) {
    throw new Error("striped batch allocation failed");
  }
  for (const entry of entries) {
    const avoidBatchKey = avoidBatchKeyForValue?.(entry.value);
    const eligibleBatches =
      avoidBatchKey === undefined
        ? batches
        : batches.filter((batch) =>
            batch.entries.every(
              (candidate) => avoidBatchKeyForValue?.(candidate.value) !== avoidBatchKey,
            ),
          );
    let target = eligibleBatches[0] ?? firstBatch;
    for (const batch of eligibleBatches) {
      if (batch.totalWeight < target.totalWeight) {
        target = batch;
      }
    }
    target.totalWeight += entry.weight;
    target.entries.push(entry);
  }
  // Keep discovery order inside each batch so include lists stay stable.
  return batches.map((batch) =>
    batch.entries.toSorted((a, b) => a.index - b.index).map((entry) => entry.value),
  );
}

function listCompactToolingTestFiles(): string[] {
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
export function createNodeTestShardBundles(
  options: NodeTestPlanOptions & { compactMode: CompactNodeTestPlanMode },
): CompactNodeTestShard[];
/** @deprecated Use compactMode so push and pull-request coverage stay explicit. */
export function createNodeTestShardBundles(
  options: NodeTestPlanOptions & { compact: true },
): CompactNodeTestShard[];
export function createNodeTestShardBundles(options?: NodeTestPlanOptions): NodeTestShard[];
export function createNodeTestShardBundles(
  options: NodeTestPlanOptions = {},
): NodeTestShard[] | CompactNodeTestShard[] {
  const compactMode =
    options.compactMode ?? (options.compact === true ? "pull-request" : undefined);
  if (compactMode !== undefined) {
    return createCompactNodeTestShardBundles(options, compactMode);
  }

  const shards = createNodeTestShards(options);
  const unbundled: NodeTestShard[] = [];
  const groups = new Map<
    string,
    {
      configs: string[];
      pretestBuildMode?: NodeTestPretestBuildMode;
      requiresDist: boolean;
      runner: string;
      shards: NodeTestShard[];
    }
  >();

  for (const shard of shards) {
    const runner = resolveCiNodeTestRunner(shard);
    const [config] = shard.configs;
    if (
      shard.requiresDist ||
      shard.configs.length !== 1 ||
      config === undefined ||
      !BUNDLEABLE_NODE_TEST_CONFIGS.has(config) ||
      !Array.isArray(shard.includePatterns) ||
      shard.includePatterns.length === 0
    ) {
      unbundled.push({ ...shard, runner });
      continue;
    }

    const key = JSON.stringify([shard.configs, shard.pretestBuildMode, shard.requiresDist, runner]);
    const group = groups.get(key) ?? {
      configs: shard.configs,
      ...(shard.pretestBuildMode ? { pretestBuildMode: shard.pretestBuildMode } : {}),
      requiresDist: shard.requiresDist,
      runner,
      shards: [],
    };
    group.shards.push(shard);
    groups.set(key, group);
  }

  const bundled: NodeTestShard[] = [];
  for (const group of groups.values()) {
    const bins: Array<{ includePatterns: string[] }> = [];
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
        ...(group.pretestBuildMode ? { pretestBuildMode: group.pretestBuildMode } : {}),
        runner: group.runner,
        requiresDist: group.requiresDist,
      });
    }
  }

  return [...unbundled, ...bundled].toSorted(compareFullNodeTestAdmissionOrder);
}

function listAgentSupportTestFiles(): string[] {
  const owner = agentVitestProjectOwners.support;
  return listTestFiles(owner.root).filter(
    (file) =>
      owner.include.some((pattern) => matchesGlob(file, pattern)) &&
      !owner.exclude.some((pattern) => matchesGlob(file, pattern)),
  );
}

// Whole-config groups the hosted splitter may stripe by file: each lister
// must enumerate exactly its config's include set so a stripe union stays a
// complete, non-overlapping partition of the suite.
const WHOLE_CONFIG_SPLIT_FILE_LISTERS = new Map<string, () => string[]>([
  ["agentic-agents-support", listAgentSupportTestFiles],
  ["agentic-gateway-methods", () => listTestFiles("src/gateway/server-methods")],
  ["core-runtime-config", () => listTestFiles("src/config")],
  // isolate:true gives every file a fresh module graph, so file stripes
  // cannot change behavior.
  ["core-unit-fast-isolated", getUnitFastIsolatedTestFiles],
]);

function splitOversizedGithubCompactGroup(
  group: NodeTestShardGroup,
  runnerBackend: string | undefined,
): Array<{ group: NodeTestShardGroup; seconds: number }> {
  // Hybrid retries run hosted, so retain hosted-derived striping even though
  // Blacksmith timings own its attempt-1 packing weights.
  const githubSeconds = estimateCompactGroupSeconds(group, "github");
  const profileSeconds = estimateCompactGroupSeconds(group, runnerBackend);
  if (githubSeconds <= COMPACT_GITHUB_MAX_PREDICTED_SECONDS) {
    return [{ group, seconds: profileSeconds }];
  }

  const includePatterns =
    group.includePatterns ?? WHOLE_CONFIG_SPLIT_FILE_LISTERS.get(group.shard_name)?.();
  if (!includePatterns || includePatterns.length === 0) {
    return [{ group, seconds: profileSeconds }];
  }

  const stripeCount = Math.ceil(githubSeconds / COMPACT_GITHUB_MAX_PREDICTED_SECONDS);
  const splitSeconds = Math.ceil(profileSeconds / stripeCount);
  return createStripedBatches(includePatterns, stripeCount, stripeFileWeight).map(
    (patterns, index) => ({
      group: {
        ...group,
        includePatterns: patterns,
        shard_name: `${group.shard_name}-hosted-${index + 1}`,
      },
      seconds: splitSeconds,
    }),
  );
}

function createCompactNodeTestShardBundles(
  options: NodeTestPlanOptions,
  compactMode: CompactNodeTestPlanMode,
): CompactNodeTestShard[] {
  const shards = createNodeTestShards(options).filter(
    (shard) => compactMode !== "push" || !COMPACT_PUSH_EXCLUDED_SHARDS.has(shard.shardName),
  );
  const groupsByRunner = new Map<string, NodeTestShardGroup[]>();
  const synthesizedSplitSeconds = new Map<string, number>();

  for (const shard of shards) {
    const runner = resolveCiNodeTestRunner(shard);
    const key = JSON.stringify([runner, shard.requiresDist]);
    const groups = groupsByRunner.get(key) ?? [];
    const group = applyCompactGroupWorkerPins({
      configs: shard.configs,
      ...(shard.env ? { env: shard.env } : {}),
      ...(shard.includePatterns ? { includePatterns: shard.includePatterns } : {}),
      ...(shard.pretestBuildMode ? { pretestBuildMode: shard.pretestBuildMode } : {}),
      requiresDist: shard.requiresDist,
      runner,
      shard_name: shard.shardName,
    });
    const plannedGroups = usesExpandedRunnerProfile(options.runnerBackend)
      ? splitOversizedGithubCompactGroup(group, options.runnerBackend)
      : [{ group, seconds: estimateCompactGroupSeconds(group, options.runnerBackend) }];
    for (const planned of plannedGroups) {
      groups.push(planned.group);
      // Synthesized hosted stripes need their divided parent weight. Native
      // groups must reach the runner-specific stripe estimator during rebalance.
      if (planned.group.shard_name !== group.shard_name) {
        synthesizedSplitSeconds.set(planned.group.shard_name, planned.seconds);
      }
    }
    groupsByRunner.set(key, groups);
  }

  const compactJobs: CompactNodeTestShard[] = [];
  const estimateGroupSeconds = (group: NodeTestShardGroup) =>
    synthesizedSplitSeconds.get(group.shard_name) ??
    estimateCompactGroupSeconds(group, options.runnerBackend);
  const estimateStripeSeconds = (group: NodeTestShardGroup) =>
    synthesizedSplitSeconds.get(group.shard_name) ??
    estimateCompactStripeSeconds(group, options.runnerBackend);
  for (const groups of groupsByRunner.values()) {
    // First-fit decreasing sets the existing registration count from the
    // composite groups and their runtime cap.
    const bins: CompactBin[] = [];
    const sortedGroups = groups.toSorted(
      (a, b) =>
        estimateGroupSeconds(b) - estimateGroupSeconds(a) ||
        a.shard_name.localeCompare(b.shard_name),
    );
    for (const group of sortedGroups) {
      const weight = estimateGroupSeconds(group);
      const exclusive = isExclusiveCompactGroup(group);
      const secondsCap = exclusive
        ? COMPACT_EXCLUSIVE_JOB_SECONDS
        : usesExpandedRunnerProfile(options.runnerBackend)
          ? group.runner.includes("-8vcpu-")
            ? COMPACT_GITHUB_LARGE_NODE_TEST_JOB_SECONDS
            : COMPACT_GITHUB_SMALL_NODE_TEST_JOB_SECONDS
          : group.runner.includes("-8vcpu-")
            ? COMPACT_LARGE_NODE_TEST_JOB_SECONDS
            : COMPACT_SMALL_NODE_TEST_JOB_SECONDS;
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

    // First-fit above determines the bounded worker count. Re-striping the
    // expanded embedded group avoids full early bins and nearly empty tails.
    const expandedGroups = groups.flatMap(expandCompactGroup);
    const regularGroups = expandedGroups
      .filter((group) => !isExclusiveCompactGroup(group))
      .toSorted((a, b) => a.shard_name.localeCompare(b.shard_name));
    const regularBinCount = bins.filter((bin) => !bin.exclusive).length;
    const regularBatches = createStripedBatches(
      regularGroups,
      regularBinCount,
      estimateStripeSeconds,
      compactGiantStripeFamily,
    );
    if (regularBatches.some((batch) => batch.length > COMPACT_NODE_TEST_JOB_GROUPS)) {
      throw new Error("striped compact job exceeds its group capacity");
    }
    const regularBins = regularBatches.map((batch) => ({
      exclusive: false,
      groups: batch,
      hasWholeConfigGroup: batch.some((group) => !group.includePatterns),
      weight: batch.reduce((sum, group) => sum + estimateStripeSeconds(group), 0),
    }));
    const exclusiveBins = bins.filter((bin) => bin.exclusive);
    bins.splice(0, bins.length, ...regularBins, ...exclusiveBins);

    for (const [index, bin] of bins.entries()) {
      const [firstGroup] = bin.groups;
      if (!firstGroup) {
        throw new Error("compact node test bin cannot be empty");
      }
      const runnerClass = firstGroup.runner.includes("-8vcpu-") ? "large" : "small";
      const distSuffix = firstGroup.requiresDist ? "-dist" : "";
      const checkName = `checks-node-compact-${runnerClass}${distSuffix}-${index + 1}`;
      const runner = COMPACT_8VCPU_CHECK_NAMES.has(checkName)
        ? DEFAULT_NODE_TEST_RUNNER
        : firstGroup.runner;
      for (const group of bin.groups) {
        group.runner = runner;
      }
      compactJobs.push({
        checkName,
        groups: bin.groups,
        ...(bin.groups.some((group) => group.pretestBuildMode === "private-qa")
          ? { pretestBuildMode: "private-qa" }
          : bin.groups.some((group) => group.pretestBuildMode === "runtime")
            ? { pretestBuildMode: "runtime" }
            : {}),
        requiresDist: firstGroup.requiresDist,
        runner,
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
        predictedSeconds: bin.weight,
      });
    }
  }

  if (
    usesExpandedRunnerProfile(options.runnerBackend) &&
    compactJobs.length > COMPACT_GITHUB_NODE_TEST_JOB_CAP
  ) {
    throw new Error(
      `compact GitHub node test plan exceeds ${COMPACT_GITHUB_NODE_TEST_JOB_CAP} jobs`,
    );
  }

  return compactJobs.toSorted((a, b) => a.checkName.localeCompare(b.checkName));
}

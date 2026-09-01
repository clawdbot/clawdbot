// Dependency-free scheduling facts shared by native CI planning and local project runs.
import { createHash } from "node:crypto";

export type VitestShardTimingSpec = {
  config: string;
  env?: NodeJS.ProcessEnv;
  includePatterns?: readonly string[] | null;
  watchMode?: boolean;
};

const SHARD_NAME_ENV_KEY = "OPENCLAW_VITEST_SHARD_NAME";

function sanitizeTimingLabel(value: unknown): string {
  return String(value)
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hashIncludePatterns(includePatterns: readonly string[]): string {
  return createHash("sha1").update(JSON.stringify(includePatterns)).digest("hex").slice(0, 12);
}

export function resolveShardTimingKey(spec: VitestShardTimingSpec): string {
  if (!Array.isArray(spec.includePatterns) || spec.includePatterns.length === 0) {
    return spec.config;
  }

  const shardName = sanitizeTimingLabel(spec.env?.[SHARD_NAME_ENV_KEY] ?? "");
  if (shardName) {
    return `${spec.config}#${shardName}`;
  }

  return `${spec.config}#include-${spec.includePatterns.length}-${hashIncludePatterns(
    spec.includePatterns,
  )}`;
}

// Advisory per-file wall-clock hints (seconds) for stripe balancing, measured
// from single-file local runs (M4 Max) and static import-graph size. Packing
// only: a stale entry skews stripe balance but never correctness. Unlisted
// files use the default, which mostly reflects the per-file module-graph
// re-evaluation cost that dominates these serial suites.
const STRIPE_FILE_SECONDS_HINTS = new Map<string, number>([
  // Serial file-boundary intervals from run 33364935118, including import/setup.
  // Runtime prerequisites are charged once per batch, separately from test work.
  ["test/e2e/qa-lab/runtime/gateway-support-export-runtime.test.ts", 6],
  ["test/scripts/plugin-release-git-lifecycle.test.ts", 35],
  ["test/scripts/vitest-report-owner.test.ts", 71],
  ["test/scripts/pr-main-refresh.test.ts", 30],
  ["test/plugin-npm-package-manifest.test.ts", 26],
  ["test/scripts/ci-node-test-plan.test.ts", 24],
  ["test/scripts/run-vitest-state-cleanup.test.ts", 127],
  ["test/scripts/ci-platform-checkout.test.ts", 75],
  ["test/scripts/watch-pr-ci.test.ts", 54],
  // cli-runner entries are CI wall clock (begin->checkmark deltas from the
  // compact runs), refreshed by focused Testbox profiling where noted.
  ["src/agents/cli-runner.context-engine.test.ts", 6],
  // Fresh profile: 5.1s total, 3.8s import; retain a conservative packing hint.
  ["src/agents/cli-runner.reliability.test.ts", 8],
  ["src/agents/cli-runner.spawn.test.ts", 45],
  // Median serial file-boundary walls from main runs 33441176559/33441320436;
  // case sums overcount the help file's concurrent cases.
  ["src/cli/acp-cli-exit.process.test.ts", 6],
  ["src/cli/cli-process-child.test-helpers.test.ts", 2],
  ["src/cli/cron-output.process.test.ts", 23],
  ["src/cli/gateway-backed-exit.process.test.ts", 105],
  ["src/cli/gateway-cli/run-loop.direct-stop-active-work.process.test.ts", 4],
  ["src/cli/gateway-cli/shutdown-hard-exit.process.test.ts", 1],
  ["src/cli/help-exit.process.test.ts", 27],
  ["src/cli/hooks-cli.process.test.ts", 12],
  ["src/cli/mcp-cli.import-boundary.test.ts", 4],
  ["src/cli/plugins-authoring.process.test.ts", 10],
  // The few CI-derived slow-file hints needed for the three new stripes are
  // rounded checkmark durations from canonical-main run 31691151297.
  ["src/auto-reply/reply/commands-export-session.test.ts", 8],
  ["src/auto-reply/reply/commands-gating.test.ts", 6],
  ["src/auto-reply/reply/commands-learn.test.ts", 8],
  ["src/auto-reply/reply/commands-plugins.install.test.ts", 6],
  ["src/auto-reply/reply/commands-status.test.ts", 12],
  ["src/auto-reply/reply/commands-system-prompt.test.ts", 8],
  // Embedded base stripe anchors: per-test sums from main run 33319465485's
  // 258.07s group wall. Three files own 169s of it, so without these the
  // equal-weight default packs them into one stripe and rebuilds the whale.
  ["src/agents/embedded-agent-runner/compact.hooks.test.ts", 39],
  ["src/agents/embedded-agent-runner/model.test.ts", 13],
  ["src/agents/embedded-agent-runner/run.compaction-runtime.test.ts", 53],
  ["src/agents/embedded-agent-runner/run.harness-auth-failover.test.ts", 8],
  ["src/agents/embedded-agent-runner/run.shared-integration.test.ts", 77],
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
  ["test/scripts/test-projects-routing.test.ts", 21],
  ["ui/src/components/app-sidebar.test.ts", 28],
  ["ui/src/pages/chat/chat-responsive.browser.test.ts", 30],
  // Focused cold proof is ~34s after right-sizing and concurrent crash phases.
  ["test/scripts/bench-sqlite-reliability.test.ts", 34],
  ["test/scripts/bundled-plugin-install-uninstall-probe.test.ts", 4],
  ["test/scripts/changed-lanes.test.ts", 5],
  // Updated process-fixture walls include imports/setup from run 33364935118.
  ["test/scripts/ci-git-owner.test.ts", 187],
  // Successful hosted run 33388762505: retain the newer lifecycle measurements.
  ["test/scripts/openclaw-performance-git-lifecycle.test.ts", 305],
  ["test/scripts/ci-linux-git.test.ts", 204],
  ["test/scripts/pr-merge-outcome.test.ts", 159],
  ["test/scripts/ci-workflow-guards.test.ts", 38],
  ["test/scripts/crabbox-wrapper.test.ts", 19],
  ["test/scripts/find-reusable-release-validation.test.ts", 8],
  ["test/scripts/install-sh.test.ts", 6],
  ["test/scripts/kitchen-sink-rpc-walk.test.ts", 5],
  ["test/scripts/managed-child-process.test.ts", 42],
  ["test/scripts/openclaw-live-updater.test.ts", 18],
  ["test/scripts/parallels-smoke-model.test.ts", 8],
  ["test/scripts/plugin-clawhub-release.test.ts", 5],
  ["test/scripts/plugin-gateway-gauntlet.test.ts", 5],
  ["test/scripts/plugin-sdk-surface-report.test.ts", 6],
  ["test/scripts/pr-operation-lock.test.ts", 27],
  ["test/scripts/test-projects.test.ts", 20],
  ["test/scripts/vitest-worker-artifacts.test.ts", 188],
  ["test/scripts/vitest-worker-artifacts.transforms.test.ts", 76],
]);
const DEFAULT_STRIPE_FILE_SECONDS = 3;
// Run 33364935118: 494 unlisted tooling files used 945.94s including imports/setup.
const DEFAULT_TOOLING_STRIPE_FILE_SECONDS = 2;

export function estimateVitestToolingFileSeconds(file: string): number {
  return STRIPE_FILE_SECONDS_HINTS.get(file) ?? DEFAULT_TOOLING_STRIPE_FILE_SECONDS;
}

export function estimateVitestTestFileSeconds(file: string): number {
  return STRIPE_FILE_SECONDS_HINTS.get(file) ?? DEFAULT_STRIPE_FILE_SECONDS;
}

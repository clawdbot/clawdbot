// Dependency-free scheduling facts shared by native CI planning and local project runs.
import { createHash } from "node:crypto";
import type { VitestPretestBuildMode } from "./vitest-build-prerequisites.mts";

// Separate build steps in runs 33364762120/33364935118: runtime median 100s;
// private-QA 104s. Test-group measurements exclude this once-per-job prerequisite.
export const VITEST_PRETEST_BUILD_SECONDS: Record<VitestPretestBuildMode, number> = {
  runtime: 100,
  "private-qa": 104,
};

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

function hashIncludePatterns(patterns: readonly string[]): string {
  return createHash("sha1").update(JSON.stringify(patterns.toSorted())).digest("hex").slice(0, 12);
}

type CompactSplitTimingGenerationSpec = {
  configs: readonly string[];
  env?: Readonly<Record<string, string>>;
  parentShardName: string;
  stripes: readonly (readonly string[])[];
};

export type CompactSplitTimingKey = {
  expectedParts: number;
  generationKey: string;
  part: number;
  selectorKey: string;
};

export function parseCompactSplitTimingKey(value: string): CompactSplitTimingKey | undefined {
  const match =
    /^(.+#selector-\d+-[a-f0-9]{12})#generation-([a-f0-9]{12})#part-(\d+)-of-(\d+)#include-\d+-[a-f0-9]{12}$/u.exec(
      value,
    );
  if (!match) {
    return undefined;
  }
  const part = Number(match[3]);
  const expectedParts = Number(match[4]);
  if (part < 1 || part > expectedParts) {
    return undefined;
  }
  return {
    expectedParts,
    generationKey: `${match[1]}#generation-${match[2]}#parts-${expectedParts}`,
    part,
    selectorKey: match[1]!,
  };
}

export function createCompactSplitTimingGeneration(params: CompactSplitTimingGenerationSpec): {
  selectorKey: string;
  timingKeys: string[];
} {
  const parentIncludePatterns = params.stripes.flat();
  if (new Set(parentIncludePatterns).size !== parentIncludePatterns.length) {
    throw new Error(`split timing generation repeats files for ${params.parentShardName}`);
  }
  const selector = JSON.stringify({
    configs: [...params.configs],
    env: Object.entries(params.env ?? {}).toSorted(([left], [right]) => left.localeCompare(right)),
    includePatterns: parentIncludePatterns.toSorted(),
  });
  const selectorDigest = createHash("sha1").update(selector).digest("hex").slice(0, 12);
  const selectorKey = `${params.parentShardName}#selector-${parentIncludePatterns.length}-${selectorDigest}`;
  const generationDigest = createHash("sha1")
    .update(JSON.stringify(params.stripes.map((patterns) => patterns.toSorted())))
    .digest("hex")
    .slice(0, 12);
  return {
    selectorKey,
    timingKeys: params.stripes.map(
      (patterns, index) =>
        `${selectorKey}#generation-${generationDigest}#part-${index + 1}-of-${params.stripes.length}#include-${patterns.length}-${hashIncludePatterns(patterns)}`,
    ),
  };
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

// Advisory per-file cost hints (seconds) for stripe balancing, from file walls,
// serial case costs, and static import-graph size. Packing
// only: a stale entry skews stripe balance but never correctness. Unlisted
// files use the default, which mostly reflects the per-file module-graph
// re-evaluation cost that dominates these serial suites.
const STRIPE_FILE_SECONDS_HINTS = new Map<string, number>([
  // Serial file-boundary intervals from run 33364935118, including import/setup.
  // Runtime prerequisites are charged once per batch, separately from test work.
  ["test/e2e/qa-lab/runtime/gateway-support-export-runtime.test.ts", 6],
  ["test/scripts/plugin-release-git-lifecycle.test.ts", 35],
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
  // The cold source proof in run 33492093127 took 198.88s; keep it alone.
  ["src/cli/gateway-backed-exit.process.test.ts", 200],
  ["src/cli/gateway-cli/run-loop.direct-stop-active-work.process.test.ts", 4],
  ["src/cli/gateway-cli/shutdown-hard-exit.process.test.ts", 1],
  ["src/cli/help-exit.process.test.ts", 27],
  ["src/cli/hooks-cli.process.test.ts", 12],
  ["src/cli/mcp-cli.import-boundary.test.ts", 4],
  ["src/cli/plugins-authoring.process.test.ts", 10],
  // Body sums from run 33492093127, rounded up with startup/import allowance.
  ["src/cli/claws-authoring-state.process.test.ts", 6],
  ["src/cli/cold-command-plugin-imports.process.test.ts", 20],
  ["src/cli/doctor-output.process.test.ts", 90],
  ["src/cli/mcp-cli.probe-exit.process.test.ts", 7],
  ["src/cli/one-shot-exit.test.ts", 25],
  ["src/cli/update-cli/update-command-lease.test.ts", 86],
  ["src/cli/update-finalization-output.process.test.ts", 25],
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
  // Two-run median case-body anchors from main runs 33504478720/33509347578.
  // These balance files; membership-specific wrapper spans own admission.
  ["src/gateway/server.sessions.create.test.ts", 52],
  ["src/gateway/server.sessions.archive-worktree-lifecycle.test.ts", 34],
  ["src/gateway/server.sessions.delete-worktree-lifecycle.test.ts", 31],
  ["src/gateway/server.chat.gateway-server-chat-b.test.ts", 37],
  ["src/gateway/server.chat.gateway-server-chat.test.ts", 22],
  ["src/gateway/server.sessions.create.projects.test.ts", 15],
  // The same runs exposed the 3s fallback on support's worktree owners. Keep
  // these as relative LPT weights, not whole-parent admission.
  ["src/agents/worktrees/service.gc.test.ts", 41],
  ["src/agents/worktrees/service.test.ts", 43],
  ["src/agents/worktrees/service.configured-root.test.ts", 24],
  ["src/agents/worktrees/service.input-files.test.ts", 21],
  ["src/agents/worktrees/service.canonical-paths.test.ts", 17],
  ["src/agents/worktrees/service.remove-lease.test.ts", 16],
  ["src/agents/sessions/agent-session-code-mode-source.test.ts", 28],
  ["src/agents/worktrees/run-lease.test.ts", 13],
  // Main runs 33537556582/33537739443/33543106647: median case-body sums.
  // Relative weights distribute files; complete generation spans own admission.
  ["src/agents/cli-runner/prepare.test.ts", 42],
  ["src/agents/command/attempt-execution.cli.test.ts", 14],
  ["src/agents/harness/selection.test.ts", 10],
  ["src/agents/main-session-recovery/main-session-restart-recovery.test.ts", 17],
  ["src/agents/runtime-plan/prepare-auth.test.ts", 11],
  ["src/agents/subagents/registry/subagent-control.retirement.test.ts", 10],
  ["src/agents/subagents/spawn/subagent-spawn.authority.test.ts", 10],
  ["src/agents/worktrees/service.capacity.test.ts", 19],
  ["src/agents/worktrees/service.diagnostics.test.ts", 18],
  ["src/agents/worktrees/service.naming.test.ts", 10],
  ["src/agents/worktrees/service.provisioned.test.ts", 24],
  ["src/agents/worktrees/service.run-end-cleanup.test.ts", 11],
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
  // Blacksmith PR runs 33532741896/33545657559 recorded 127.288s/135.808s wrapper
  // spans; canonical push plans omit this tooling workload.
  ["test/scripts/openclaw-performance-git-lifecycle.test.ts", 136],
  ["test/scripts/ci-linux-git.test.ts", 204],
  // Historical single-file wall from PR run 33576929814; this file has since grown.
  ["test/scripts/pr-merge-outcome.test.ts", 206],
  // Relative serial case costs from PR runs 33571672257/33576929814.
  // These mixed invocations do not report complete file walls.
  ["test/scripts/vitest-report-owner.test.ts", 203],
  ["test/scripts/write-plugin-sdk-entry-dts.test.ts", 74],
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

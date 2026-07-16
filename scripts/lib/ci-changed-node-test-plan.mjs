import { existsSync } from "node:fs";
import path from "node:path";
import { detectChangedLanes } from "../changed-lanes.mjs";
import {
  buildVitestRunPlans,
  findUnmatchedExplicitTestTargets,
  hasImportGraphImpactOnTargets,
  isTestFileTarget,
  resolveChangedTestTargetPlan,
} from "../test-projects.test-support.mjs";
import { createNodeTestShards } from "./ci-node-test-plan.mjs";
import { buildPluginSdkEntrySources, publicPluginSdkEntrypoints } from "./plugin-sdk-entries.mjs";

const DEFAULT_NODE_TEST_RUNNER = "blacksmith-8vcpu-ubuntu-2404";
const MAX_CHANGED_NODE_TEST_TARGETS = 96;
// Each target runs in its own child process (isolation contract), so bound the
// serial tail per job; the shard runner overlaps two children at a time.
const CHANGED_NODE_TEST_TARGETS_PER_JOB = 12;
const BOUNDARY_NODE_TEST_CONFIG = "test/vitest/vitest.boundary.config.ts";
const publicPluginSdkEntrySources = Object.values(
  buildPluginSdkEntrySources(publicPluginSdkEntrypoints),
);

const fullNodeTestShards = createNodeTestShards({ includeReleaseOnlyPluginShards: false });
const configsRequiringFullSuiteMetadata = new Set(
  fullNodeTestShards
    .filter((shard) => shard.env || shard.shardName.startsWith("core-tooling"))
    .flatMap((shard) => shard.configs),
);
const splitNodeTestConfigs = new Set(
  fullNodeTestShards.filter((shard) => shard.includePatterns).flatMap((shard) => shard.configs),
);

function isTestOnlyPath(changedPath) {
  return isTestFileTarget(changedPath) || changedPath.startsWith("test/");
}

/**
 * True when any changed path can influence built dist/packaging bytes.
 * Test-only diffs cannot change what `build:ci-artifacts` produces, so the
 * manifest may skip the build-artifacts lane for them.
 */
export function hasBuildArtifactAffectingChange(changedPaths) {
  return changedPaths.some((changedPath) => !isTestOnlyPath(changedPath));
}

// Surfaces the CI smoke scenarios exercise outside the core runtime import
// graph: the qa-lab harness and scenario data, the packaged-CLI build inputs,
// the control UI (playwright scenario), the two channels the smoke profile
// drives (matrix, telegram), and workspace packages whose package-specifier
// imports the relative import graph cannot see. The QA lane's own
// orchestration (this planner, the CI workflow, composite actions) is also
// QA-impacting: changes to the gate must not be able to skip the gated lane.
const QA_SMOKE_SURFACE_RE =
  /^(?:extensions\/(?:matrix|qa-lab|telegram)|packages|qa|ui)\/|^scripts\/(?:build-all\.mjs|package-openclaw-for-docker\.mjs)$|^scripts\/lib\/ci-changed-node-test-plan\.mjs$|^\.github\/(?:workflows\/ci\.yml$|actions\/)|^(?:openclaw\.mjs|package\.json|pnpm-lock\.yaml|npm-shrinkwrap\.json|pnpm-workspace\.yaml|tsdown\.config\.ts)$/u;
// The smoke profile runs the packaged CLI end to end, so its runtime blast
// radius is exactly the CLI entry's import graph (dynamic imports included).
const QA_SMOKE_RUNTIME_ENTRY = "src/index.ts";

/**
 * True when a changed path can influence the QA smoke scenarios: it touches
 * the smoke surface directly, or the packaged CLI's import graph reaches it.
 * Diffs outside both are invisible to the smoke profile, so the manifest may
 * skip that lane regardless of whether test targeting fired.
 */
export function hasQaSmokeAffectingChange(changedPaths, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  if (changedPaths.some((changedPath) => QA_SMOKE_SURFACE_RE.test(changedPath))) {
    return true;
  }
  const sourcePaths = changedPaths.filter(
    (changedPath) => changedPath.startsWith("src/") && !isTestFileTarget(changedPath),
  );
  if (sourcePaths.length === 0) {
    return false;
  }
  // Deleted sources cannot be graphed; fail safe to running the smoke lane.
  if (sourcePaths.some((changedPath) => !existsSync(path.join(cwd, changedPath)))) {
    return true;
  }
  return hasImportGraphImpactOnTargets(sourcePaths, [QA_SMOKE_RUNTIME_ENTRY], cwd);
}

function createBoundaryShard() {
  // Boundary tests scan the source tree (including test files) and build
  // their own fixtures; they do not consume the built dist artifact. When the
  // build-artifacts lane is skipped, this shard keeps that coverage.
  return {
    checkName: "checks-node-changed-boundary",
    configs: [BOUNDARY_NODE_TEST_CONFIG],
    requiresDist: false,
    runner: DEFAULT_NODE_TEST_RUNNER,
    shardName: "changed-boundary",
  };
}

/**
 * Builds bounded PR jobs from precise changed-test targets.
 * Null means the caller must fail safe to the compact full-suite plan.
 */
export function createChangedNodeTestShards(changedPaths, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return null;
  }

  const livePaths = [];
  const deletedPaths = [];
  for (const changedPath of changedPaths) {
    (existsSync(path.join(cwd, changedPath)) ? livePaths : deletedPaths).push(changedPath);
  }
  // Deleted test files cannot regress runtime behavior, so they never block
  // targeting. Deleted source files cannot be import-graphed from the merged
  // tree and no live-path heuristic proves their consumers are covered, so
  // any source deletion keeps the full-suite plan.
  if (deletedPaths.some((deletedPath) => !isTestFileTarget(deletedPath))) {
    return null;
  }

  // Workspace package consumers often use package specifiers, which the
  // relative import graph cannot connect back to the changed package source.
  if (changedPaths.some((changedPath) => changedPath.startsWith("packages/"))) {
    return null;
  }

  // Package-specifier consumers are invisible to the relative import graph.
  // Fail safe when a core change reaches a public SDK entrypoint indirectly.
  if (
    detectChangedLanes(changedPaths).extensionImpactFromCore ||
    (livePaths.some((changedPath) => changedPath.startsWith("src/")) &&
      hasImportGraphImpactOnTargets(livePaths, publicPluginSdkEntrySources, cwd))
  ) {
    return null;
  }

  const resolveTargetPlan = (paths) =>
    resolveChangedTestTargetPlan(paths, {
      broad: true,
      combineSiblingWithImportGraph: true,
      cwd,
      forceFullImportGraph: true,
      includeExtensionImpact: false,
    });
  const plan =
    livePaths.length > 0 ? resolveTargetPlan(livePaths) : { mode: "targets", targets: [] };
  // Aggregate resolution must not let one precise path hide another path that
  // contributes no tests. Partial plans silently drop coverage.
  if (
    livePaths.some((changedPath) => {
      const changedPathPlan = resolveTargetPlan([changedPath]);
      return changedPathPlan.mode !== "targets" || changedPathPlan.targets.length === 0;
    })
  ) {
    return null;
  }
  if (plan.mode !== "targets") {
    return null;
  }
  const targets = [...new Set(plan.targets)];
  if (
    targets.length > MAX_CHANGED_NODE_TEST_TARGETS ||
    targets.some(
      (target) =>
        /^test\/vitest\/vitest\.full-.*\.config\.ts$/u.test(target) ||
        splitNodeTestConfigs.has(target),
    )
  ) {
    return null;
  }

  if (
    targets.some(
      (target) =>
        !isTestFileTarget(target) || findUnmatchedExplicitTestTargets([target], cwd).length > 0,
    )
  ) {
    return null;
  }

  const targetPlans = targets.map((target) => ({
    plans: buildVitestRunPlans([target], cwd),
    target,
  }));
  if (
    targetPlans.some(
      ({ plans }) => plans.length === 0 || plans.some((targetPlan) => !targetPlan.includePatterns),
    )
  ) {
    return null;
  }
  // Preserve special shard setup (for example Go and TUI PTY coverage) by using
  // the compact plan until targeted jobs can carry per-config prerequisites.
  if (
    targetPlans.some(({ plans }) =>
      plans.some(({ config }) => configsRequiringFullSuiteMetadata.has(config)),
    )
  ) {
    return null;
  }

  // Boundary-config targets run as regular nondist targets: the boundary
  // suite scans the checked-out tree and never consumes the built dist.
  const orderedTargets = targetPlans.map(({ target }) => target);
  const targetChunks = [];
  for (
    let offset = 0;
    offset < orderedTargets.length;
    offset += CHANGED_NODE_TEST_TARGETS_PER_JOB
  ) {
    targetChunks.push(orderedTargets.slice(offset, offset + CHANGED_NODE_TEST_TARGETS_PER_JOB));
  }
  const shards = [
    ...targetChunks.map((chunk, index) => {
      const suffix = targetChunks.length === 1 ? "" : `-${index + 1}`;
      return {
        checkName: `checks-node-changed${suffix}`,
        configs: [],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: `changed${suffix}`,
        targets: chunk,
      };
    }),
    ...(hasBuildArtifactAffectingChange(changedPaths) ? [] : [createBoundaryShard()]),
  ];
  return shards.length > 0 ? shards : null;
}

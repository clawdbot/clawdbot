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
const DIST_DEPENDENT_CONFIGS = new Set(["test/vitest/vitest.boundary.config.ts"]);
const MAX_CHANGED_NODE_TEST_TARGETS = 20;
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

/**
 * Builds one bounded PR job from precise changed-test targets.
 * Null means the caller must fail safe to the compact full-suite plan.
 */
export function createChangedNodeTestShards(changedPaths, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return null;
  }

  // Deletions cannot be reconstructed reliably from the post-merge tree.
  if (changedPaths.some((changedPath) => !existsSync(path.join(cwd, changedPath)))) {
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
    (changedPaths.some((changedPath) => changedPath.startsWith("src/")) &&
      hasImportGraphImpactOnTargets(changedPaths, publicPluginSdkEntrySources, cwd))
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
  const plan = resolveTargetPlan(changedPaths);
  // Aggregate resolution must not let one precise path hide another path that
  // contributes no tests. Partial plans silently drop coverage.
  if (
    changedPaths.some((changedPath) => {
      const changedPathPlan = resolveTargetPlan([changedPath]);
      return changedPathPlan.mode !== "targets" || changedPathPlan.targets.length === 0;
    })
  ) {
    return null;
  }
  if (
    plan.mode !== "targets" ||
    plan.targets.length === 0 ||
    plan.targets.length > MAX_CHANGED_NODE_TEST_TARGETS ||
    plan.targets.some(
      (target) =>
        /^test\/vitest\/vitest\.full-.*\.config\.ts$/u.test(target) ||
        splitNodeTestConfigs.has(target),
    )
  ) {
    return null;
  }

  if (
    plan.targets.some(
      (target) =>
        !isTestFileTarget(target) || findUnmatchedExplicitTestTargets([target], cwd).length > 0,
    )
  ) {
    return null;
  }

  const targetPlans = plan.targets.map((target) => ({
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

  const nonDistTargets = targetPlans
    .filter(({ plans }) => plans.some(({ config }) => !DIST_DEPENDENT_CONFIGS.has(config)))
    .map(({ target }) => target);
  const distTargets = targetPlans
    .filter(({ plans }) => plans.some(({ config }) => DIST_DEPENDENT_CONFIGS.has(config)))
    .map(({ target }) => target);

  return [
    ...(nonDistTargets.length > 0
      ? [
          {
            checkName: "checks-node-changed",
            configs: [],
            requiresDist: false,
            runner: DEFAULT_NODE_TEST_RUNNER,
            shardName: "changed",
            targets: nonDistTargets,
          },
        ]
      : []),
    ...(distTargets.length > 0
      ? [
          {
            checkName: "checks-node-changed-dist",
            configs: ["test/vitest/vitest.boundary.config.ts"],
            requiresDist: true,
            runner: DEFAULT_NODE_TEST_RUNNER,
            shardName: "changed-dist",
            targets: distTargets,
          },
        ]
      : []),
  ];
}

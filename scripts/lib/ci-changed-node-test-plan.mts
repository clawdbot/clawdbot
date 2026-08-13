import { existsSync } from "node:fs";
import path from "node:path";
import { detectChangedLanes } from "../changed-lanes.mts";
import {
  buildVitestRunPlans,
  findUnmatchedExplicitTestTargets,
  hasImportGraphImpactOnTargets,
  isTestFileTarget,
  isTestSupportFileTarget,
  resolveChangedTestTargetPlan,
} from "../test-projects.test-support.mts";
import {
  createNodeTestShards,
  isPolicyTestOwnedPath,
  resolvePolicyTestTargets,
} from "./ci-node-test-plan.mts";
import {
  createExtensionTestProcessTargetChunks,
  resolveExtensionTestConfig,
} from "./extension-test-plan.mts";
import { buildPluginSdkEntrySources, publicPluginSdkEntrypoints } from "./plugin-sdk-entries.mts";

type ChangedNodeTestShard = {
  checkName: string;
  configs: string[];
  includePatterns?: string[];
  planConcurrency?: number;
  requiresDist: boolean;
  runner: string;
  shardName: string;
  targets?: string[];
};
type CwdOptions = { cwd?: string };

const DEFAULT_NODE_TEST_RUNNER = "blacksmith-8vcpu-ubuntu-2404";
const MAX_CHANGED_NODE_TEST_TARGETS = 96;
// Each target runs in its own child process (isolation contract), so bound the
// serial tail per job; the shard runner overlaps two children at a time.
const CHANGED_NODE_TEST_TARGETS_PER_JOB = 12;
// Memory Core targets perform real SQLite/indexing work. Two concurrent Vitest
// processes starve each other on 4-vCPU runners and push otherwise healthy
// integration tests past the global timeout.
const SERIAL_CHANGED_TARGET_RE = /^extensions\/memory-core\//u;
const BOUNDARY_NODE_TEST_CONFIG = "test/vitest/vitest.boundary.config.ts";
const publicPluginSdkEntrySources = Object.values(
  buildPluginSdkEntrySources(publicPluginSdkEntrypoints),
);

const fullNodeTestShards = createNodeTestShards({
  includeReleaseOnlyPluginShards: false,
});
const configsRequiringFullSuiteMetadata = new Set(
  fullNodeTestShards
    .filter((shard) => shard.env || shard.shardName.startsWith("core-tooling"))
    .flatMap((shard) => shard.configs),
);
const splitNodeTestConfigs = new Set(
  fullNodeTestShards.filter((shard) => shard.includePatterns).flatMap((shard) => shard.configs),
);

function isTestOnlyPath(changedPath: string) {
  return (
    isTestFileTarget(changedPath) ||
    isTestSupportFileTarget(changedPath) ||
    changedPath.startsWith("test/")
  );
}

// Inputs `build:ci-artifacts` consumes: runtime/plugin/package sources plus
// the build pipeline itself (mirrors the build-all cache key in ci.yml).
// Paths outside this set — repo scripts, workflows, qa scenarios, docs mixes —
// cannot change dist or bundled plugin asset bytes.
const BUILD_INPUT_RE =
  /^(?:src|extensions|packages)\/|^(?:openclaw\.mjs|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$|^tsconfig[^/]*\.json$|^scripts\/(?:build-[^/]+|runtime-postbuild\.mts|write-plugin-sdk-entry-dts\.ts)$|^scripts\/lib\/(?:copy-assets\.ts|plugin-sdk-entries\.mts)$/u;

/**
 * True when a changed path can influence built dist/packaging bytes: a
 * non-test build-input source or the build pipeline itself. Diffs entirely
 * outside that set (tests, repo scripts, workflows, qa scenarios) let the
 * manifest skip the build-artifacts lane.
 */
export function hasBuildArtifactAffectingChange(changedPaths: string[]) {
  return changedPaths.some(
    (changedPath) => BUILD_INPUT_RE.test(changedPath) && !isTestOnlyPath(changedPath),
  );
}

// Surfaces the CI smoke scenarios exercise outside the core runtime import
// graph: the qa-lab harness and scenario data, the packaged-CLI build inputs,
// the control UI (playwright scenario), the two channels the smoke profile
// drives (matrix, telegram), and workspace packages whose package-specifier
// imports the relative import graph cannot see. The QA lane's own
// orchestration (this planner, the CI workflow, composite actions) is also
// QA-impacting: changes to the gate must not be able to skip the gated lane.
const QA_SMOKE_SURFACE_RE =
  /^(?:extensions\/(?:matrix|qa-lab|telegram)|packages|qa|ui)\/|^scripts\/(?:build-all\.mts|package-openclaw-for-docker\.mts)$|^scripts\/lib\/ci-changed-node-test-plan\.mts$|^\.github\/(?:workflows\/ci\.yml$|actions\/)|^(?:openclaw\.mjs|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsdown\.config\.ts)$/u;
// The smoke profile runs the packaged CLI end to end, so its runtime blast
// radius is exactly the CLI entry's import graph (dynamic imports included).
const QA_SMOKE_RUNTIME_ENTRY = "src/index.ts";

/**
 * True when a changed path can influence the QA smoke scenarios: it touches
 * the smoke surface directly, or the packaged CLI's import graph reaches it.
 * Diffs outside both are invisible to the smoke profile, so the manifest may
 * skip that lane regardless of whether test targeting fired.
 */
export function hasQaSmokeAffectingChange(changedPaths: string[], options: CwdOptions = {}) {
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

// Surfaces the prompt-snapshot check exercises outside its generator's
// relative import graph: the snapshot fixtures and generator scripts, the
// codex extension (its test API loads through a dynamic bundled-plugin module
// id the graph walk cannot see), and the gate's own orchestration — changes
// to the gate must not be able to skip the gated lane.
const PROMPT_SNAPSHOT_SURFACE_RE =
  /^(?:test\/(?:helpers\/agents|fixtures\/agents\/prompt-snapshots)|extensions\/codex|packages)\/|^scripts\/(?:generate-prompt-snapshots\.ts|prompt-snapshot-files\.[cm]?[jt]s)$|^scripts\/lib\/ci-changed-node-test-plan\.mts$|^\.github\/(?:workflows\/ci\.yml$|actions\/)|^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/u;
// The generator renders real prompt-layer stacks, so its runtime blast radius
// is the snapshot helper's import graph (auto-reply prompts, channel typing,
// plugin-sdk agent harness, codex catalog fixtures).
const PROMPT_SNAPSHOT_ENTRY = "test/helpers/agents/happy-path-prompt-snapshots.ts";

/**
 * True when a changed path can influence generated prompt snapshots: it
 * touches the snapshot surface directly, or the generator's import graph
 * reaches it. Diffs outside both cannot change generator output, so the
 * manifest may skip the check lane.
 */
export function hasPromptSnapshotAffectingChange(changedPaths: string[], options: CwdOptions = {}) {
  const cwd = options.cwd ?? process.cwd();
  if (changedPaths.some((changedPath) => PROMPT_SNAPSHOT_SURFACE_RE.test(changedPath))) {
    return true;
  }
  const sourcePaths = changedPaths.filter(
    (changedPath) => changedPath.startsWith("src/") && !isTestFileTarget(changedPath),
  );
  if (sourcePaths.length === 0) {
    return false;
  }
  // Deleted sources cannot be graphed; fail safe to running the check.
  if (sourcePaths.some((changedPath) => !existsSync(path.join(cwd, changedPath)))) {
    return true;
  }
  return hasImportGraphImpactOnTargets(sourcePaths, [PROMPT_SNAPSHOT_ENTRY], cwd);
}

// The lifecycle proof crosses dynamic Gateway method registration, doctor
// migrations, shared session coordination, the public session SDK, and the
// built CLI. Keep those owners on the direct surface; use the import graph only
// inside the embedded-runner neighborhood, whose session reachability is not
// apparent from filenames.
const SQLITE_SESSION_LIFECYCLE_PREFIX_RE =
  /^(?:src\/(?:agents\/(?:sessions\/|[^/]*(?:session|transcript|compaction)[^/]*)|commands\/doctor-session-|config\/sessions\/|gateway\/(?:agent-turn\/agent-session-persist|server-chat\.(?:load-gateway-session-row|persist-session-lifecycle)|server-methods\/sessions|server\.sessions|session-|sessions-)|plugin-sdk\/session-|sessions\/|state\/openclaw-agent-(?:db|schema))|\.github\/actions\/setup-node-env\/)/u;
const SQLITE_SESSION_LIFECYCLE_EXACT_RE =
  /^(?:src\/config\/sessions\.ts|test\/helpers\/(?:openclaw-test-instance|sqlite-sessions-transcripts-flip-proof(?:-assertions)?)\.ts|test\/scripts\/(?:sqlite-sessions-transcripts-flip-proof(?:\.built-cli)?\.e2e\.test|vitest-e2e-global-setup\.test)\.ts|test\/vitest\/vitest\.e2e\.(?:config|global-setup)\.ts|scripts\/lib\/ci-changed-node-test-plan\.mts|\.github\/workflows\/ci\.yml|openclaw\.mjs|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/u;
const SQLITE_SESSION_LIFECYCLE_ENTRY =
  "test/scripts/sqlite-sessions-transcripts-flip-proof.e2e.test.ts";
const SQLITE_SESSION_LIFECYCLE_IMPORT_CANDIDATE_RE = /^src\/agents\/embedded-agent-runner\/run\//u;

/**
 * True when a changed path touches a SQLite session lifecycle owner or reaches
 * the proof from the embedded-runner neighborhood.
 */
export function hasSqliteSessionLifecycleAffectingChange(
  changedPaths: string[],
  options: CwdOptions = {},
) {
  const cwd = options.cwd ?? process.cwd();
  if (
    changedPaths.some(
      (changedPath) =>
        (!isTestFileTarget(changedPath) && SQLITE_SESSION_LIFECYCLE_PREFIX_RE.test(changedPath)) ||
        SQLITE_SESSION_LIFECYCLE_EXACT_RE.test(changedPath),
    )
  ) {
    return true;
  }
  const sourcePaths = changedPaths.filter(
    (changedPath) =>
      SQLITE_SESSION_LIFECYCLE_IMPORT_CANDIDATE_RE.test(changedPath) &&
      !isTestFileTarget(changedPath),
  );
  // Deleted sources cannot be graphed; fail safe to running the lifecycle proof.
  if (sourcePaths.some((changedPath) => !existsSync(path.join(cwd, changedPath)))) {
    return true;
  }
  if (sourcePaths.length === 0) {
    return false;
  }
  return hasImportGraphImpactOnTargets(sourcePaths, [SQLITE_SESSION_LIFECYCLE_ENTRY], cwd);
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

function resolvePreciseChangedTargets(
  changedPaths: string[],
  cwd: string,
  additionalTargets: string[] = [],
) {
  const resolveTargetPlan = (paths: string[]) =>
    resolveChangedTestTargetPlan(paths, {
      broad: true,
      combineSiblingWithImportGraph: true,
      cwd,
      forceFullImportGraph: true,
      includeExtensionImpact: false,
    });
  const plan =
    changedPaths.length > 0
      ? resolveTargetPlan(changedPaths)
      : { mode: "targets" as const, targets: [] };
  // Aggregate resolution must not let one precise path hide another path that
  // contributes no tests. Partial plans silently drop coverage.
  if (
    changedPaths.some((changedPath) => {
      const changedPathPlan = resolveTargetPlan([changedPath]);
      return changedPathPlan.mode !== "targets" || changedPathPlan.targets.length === 0;
    }) ||
    plan.mode !== "targets"
  ) {
    return null;
  }
  const targets = [...new Set([...plan.targets, ...additionalTargets])];
  if (
    targets.length > MAX_CHANGED_NODE_TEST_TARGETS ||
    targets.some(
      (target) =>
        /^test\/vitest\/vitest\.full-.*\.config\.ts$/u.test(target) ||
        splitNodeTestConfigs.has(target),
    ) ||
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
  return targetPlans.map(({ target }) => target);
}

function createChangedTargetShards(
  targets: string[],
  names: { checkName: string; shardName: string },
) {
  const targetChunks: string[][] = [];
  for (let offset = 0; offset < targets.length; offset += CHANGED_NODE_TEST_TARGETS_PER_JOB) {
    targetChunks.push(targets.slice(offset, offset + CHANGED_NODE_TEST_TARGETS_PER_JOB));
  }
  return targetChunks.map((chunk, index) => {
    const suffix = targetChunks.length === 1 ? "" : `-${index + 1}`;
    const shard: ChangedNodeTestShard = {
      checkName: `${names.checkName}${suffix}`,
      configs: [],
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
      shardName: `${names.shardName}${suffix}`,
      targets: chunk,
    };
    if (chunk.some((target) => SERIAL_CHANGED_TARGET_RE.test(target))) {
      shard.planConcurrency = 1;
    }
    return shard;
  });
}

function resolveChangedExtensionRoots(changedPaths: string[]) {
  return [
    ...new Set(
      changedPaths.flatMap((changedPath) => {
        const [, extensionId] = changedPath.split("/");
        return extensionId ? [`extensions/${extensionId}`] : [];
      }),
    ),
  ];
}

function createChangedExtensionConfigShards(extensionRoots: string[]) {
  const rootsByConfig = new Map<string, string[]>();
  for (const root of extensionRoots) {
    const config = resolveExtensionTestConfig(root);
    rootsByConfig.set(config, [...(rootsByConfig.get(config) ?? []), root]);
  }
  const plans: Array<{ config: string; includePatterns?: string[]; roots: string[] }> = [
    ...rootsByConfig,
  ].flatMap(([config, roots]) => {
    const chunks = createExtensionTestProcessTargetChunks(config, roots);
    return chunks.length > 1
      ? chunks.map((includePatterns) => ({ config, includePatterns, roots }))
      : [{ config, roots }];
  });
  return plans.map(({ config, includePatterns, roots }, index) => {
    const suffix = plans.length === 1 ? "" : `-${index + 1}`;
    const shard: ChangedNodeTestShard = {
      checkName: `checks-node-changed-extensions-config${suffix}`,
      configs: [config],
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
      shardName: `changed-extensions-config${suffix}`,
    };
    if (includePatterns) {
      shard.includePatterns = includePatterns;
    }
    if (roots.some((root) => SERIAL_CHANGED_TARGET_RE.test(`${root}/`))) {
      shard.planConcurrency = 1;
    }
    return shard;
  });
}

/**
 * The fail-safe cause leaves the non-extension diff's extension impact unbounded,
 * so whole extension configs are required; precise targets would under-cover.
 */
export function createChangedExtensionFallbackShards(
  changedPaths: string[],
  options: CwdOptions = {},
): ChangedNodeTestShard[] {
  const cwd = options.cwd ?? process.cwd();
  const extensionPaths = changedPaths.filter((changedPath) =>
    changedPath.startsWith("extensions/"),
  );
  if (extensionPaths.length === 0) {
    return [];
  }
  const relevantPaths = extensionPaths.filter(
    (changedPath) => existsSync(path.join(cwd, changedPath)) || !isTestFileTarget(changedPath),
  );
  if (relevantPaths.length === 0) {
    return [];
  }
  return createChangedExtensionConfigShards(resolveChangedExtensionRoots(relevantPaths));
}

/**
 * Builds bounded PR jobs from precise changed-test targets.
 * Null means the caller must fail safe to the compact full-suite plan.
 */
export function createChangedNodeTestShards(
  changedPaths: string[],
  options: CwdOptions = {},
): ChangedNodeTestShard[] | null {
  const cwd = options.cwd ?? process.cwd();
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return null;
  }

  const livePaths: string[] = [];
  const deletedPaths: string[] = [];
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

  const policyTargetsByPath = new Map(
    livePaths.map((changedPath) => [changedPath, resolvePolicyTestTargets([changedPath])]),
  );
  const regularLivePaths = livePaths.filter((changedPath) => !isPolicyTestOwnedPath(changedPath));

  // Workspace package consumers often use package specifiers, which the
  // relative import graph cannot connect back to the changed package source.
  if (changedPaths.some((changedPath) => changedPath.startsWith("packages/"))) {
    return null;
  }

  // Package-specifier consumers are invisible to the relative import graph.
  // Fail safe when a core change reaches a public SDK entrypoint indirectly.
  if (
    detectChangedLanes(changedPaths).extensionImpactFromCore ||
    (regularLivePaths.some((changedPath) => changedPath.startsWith("src/")) &&
      hasImportGraphImpactOnTargets(regularLivePaths, publicPluginSdkEntrySources, cwd))
  ) {
    return null;
  }

  const targets = resolvePreciseChangedTargets(
    regularLivePaths,
    cwd,
    [...policyTargetsByPath.values()].flat(),
  );
  if (targets === null) {
    return null;
  }

  // Boundary-config targets run as regular nondist targets: the boundary
  // suite scans the checked-out tree and never consumes the built dist.
  const shards = [
    ...createChangedTargetShards(targets, {
      checkName: "checks-node-changed",
      shardName: "changed",
    }),
    ...(hasBuildArtifactAffectingChange(changedPaths) ? [] : [createBoundaryShard()]),
  ];
  return shards.length > 0 ? shards : null;
}

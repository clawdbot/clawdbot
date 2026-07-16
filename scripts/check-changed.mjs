// Runs the changed-file check lanes selected by `scripts/changed-lanes.mjs`.
import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  LIVE_DOCKER_AUTH_SHELL_TARGETS,
  detectChangedLanesForPaths,
  listChangedPathsFromGit,
  listStagedChangedPaths,
} from "./changed-lanes.mjs";
import { booleanFlag, parseFlagArgs, stringFlag } from "./lib/arg-utils.mjs";
import { getChangedPathFacts, normalizeChangedPath } from "./lib/changed-path-facts.mjs";
import { printTimingSummary } from "./lib/check-timing-summary.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  acquireLocalHeavyCheckLockSync,
  resolveLocalHeavyCheckEnv,
} from "./lib/local-heavy-check-runtime.mjs";
import { runManagedCommand } from "./lib/managed-child-process.mjs";
import { createSparseTsgoSkipEnv } from "./lib/tsgo-sparse-guard.mjs";

const SHRINKWRAP_POLICY_PATH_RE =
  /^(?:npm-shrinkwrap\.json|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|scripts\/generate-npm-shrinkwrap\.mjs|extensions\/[^/]+\/(?:package\.json|npm-shrinkwrap\.json))$/u;
const PROMPT_SNAPSHOT_CHECK_PATH_RE =
  /^(?:scripts\/(?:generate-prompt-snapshots\.ts|prompt-snapshot-files\.ts|sync-codex-model-prompt-fixture\.ts)|test\/helpers\/agents\/(?:happy-path-prompt-snapshots|prompt-snapshot-paths)\.ts|test\/fixtures\/agents\/prompt-snapshots\/.+)$/u;
const PROMPT_SNAPSHOT_OWNER_TEST_PATH_RE =
  /^(?:scripts\/(?:generate-prompt-snapshots\.ts|prompt-snapshot-files\.ts|sync-codex-model-prompt-fixture\.ts)|test\/helpers\/agents\/(?:happy-path-prompt-snapshots|prompt-snapshot-paths)\.ts|test\/fixtures\/agents\/prompt-snapshots\/codex-model-catalog\/.+)$/u;
const RUNTIME_SIDECAR_BASELINE_PATH_RE =
  /^(?:scripts\/generate-runtime-sidecar-paths-baseline\.ts|scripts\/lib\/bundled-runtime-sidecar-paths\.json|src\/plugins\/runtime-sidecar-paths(?:-baseline)?\.ts)$/u;
const SQLITE_SESSION_SCHEMA_BASELINE_PATH_RE =
  /^(?:src\/state\/openclaw-agent-schema\.sql|scripts\/(?:generate-sqlite-session-schema-baseline\.ts|lib\/sqlite-session-schema-baseline\.ts)|test\/scripts\/sqlite-session-schema-baseline\.test\.ts|docs\/\.generated\/sqlite-session-transcript-schema-baseline\.sha256)$/u;
const PLUGIN_SDK_API_BASELINE_PATH_RE =
  /^(?:src\/|packages\/|extensions\/|pnpm-lock\.yaml$|tsconfig\.json$|scripts\/(?:generate-plugin-sdk-api-baseline\.ts|lib\/plugin-sdk-(?:doc-metadata\.ts|entries\.mjs|entrypoints\.json|private-local-only-subpaths\.json))|docs\/\.generated\/plugin-sdk-api-baseline\.sha256$)/u;
const PLUGIN_SDK_SURFACE_PATH_RE =
  /^(?:package\.json$|src\/plugin-sdk\/|scripts\/(?:plugin-sdk-surface-report\.mjs|sync-plugin-sdk-exports\.mjs|lib\/plugin-sdk-(?:declaration-budget\.mjs|deprecated-barrel-subpaths\.json|deprecated-public-subpaths\.json|entries\.mjs|entrypoints\.json|private-local-only-subpaths\.json)))/u;
const DEPRECATION_HYGIENE_PATH_RE =
  /^(?:package\.json$|src\/|extensions\/|packages\/|scripts\/(?:check-deprecated-api-usage\.mjs$|plugin-boundary-report\.ts$|lib\/plugin-sdk))/u;
const CANVAS_A2UI_NATIVE_RESOURCE_PATH_RE =
  /^(?:pnpm-lock\.yaml$|apps\/shared\/OpenClawKit\/Sources\/OpenClawKit\/Resources\/CanvasA2UI\/|extensions\/canvas\/(?:package\.json$|scripts\/bundle-a2ui\.mjs$|src\/host\/a2ui(?:\/(?:index\.html|a2ui\.bundle\.js|\.bundle\.hash)$|-app\/))|scripts\/(?:bundle-a2ui|sync-native-a2ui)\.mjs$)/u;
const CONTROL_UI_I18N_VERIFY_PATH_RE =
  /^(?:package\.json$|ui\/src\/|scripts\/(?:control-ui-i18n(?:-(?:report|verify))?\.ts|lib\/control-ui-i18n-[^/]+\.ts)$|test\/scripts\/control-ui-i18n[^/]*\.test\.ts$)/u;
const CORE_OXLINT_TS_CONFIG = "config/tsconfig/oxlint.core.json";
const EXTENSIONS_OXLINT_TS_CONFIG = "config/tsconfig/oxlint.extensions.json";
const SCRIPTS_OXLINT_TS_CONFIG = "config/tsconfig/oxlint.scripts.json";
const TARGETED_LINT_PATH_LIMIT = 8;
const LINTABLE_CORE_PATH_RE = /^(?:src|ui|packages)\/.+\.[cm]?[jt]sx?$/u;
const LINTABLE_EXTENSION_PATH_RE = /^extensions\/[^/]+\/.+\.[cm]?[jt]sx?$/u;
const LINTABLE_SCRIPT_PATH_RE = /^scripts\/.+\.[cm]?[jt]sx?$/u;
const MARKDOWN_LINT_OPTIMIZATION_NEUTRAL_PATH_RE = /^(?:docs\/|README\.md$|.*\.mdx?$)/u;
const CORE_LINT_OPTIMIZATION_NEUTRAL_PATH_RE =
  /^(?:scripts|test\/scripts)\/|^\.github\/workflows\/ci\.yml$/u;
const EXTENSION_LINT_OPTIMIZATION_NEUTRAL_PATH_RE =
  /^(?:test\/scripts\/|\.github\/workflows\/ci\.yml$)/u;
const SCRIPT_LINT_OPTIMIZATION_NEUTRAL_PATH_RE =
  /^(?:test\/scripts\/|\.github\/workflows\/ci\.yml$)/u;
const ANDROID_VERSION_SYNC_PATHS = new Set([
  "apps/android/CHANGELOG.md",
  "apps/android/Config/Version.properties",
  "apps/android/fastlane/metadata/android/en-US/release_notes.txt",
  "apps/android/version.json",
]);
const MACOS_APP_CI_PATH_RE =
  /^(?:apps\/(?:macos|macos-mlx-tts|shared|swabble)\/|Swabble\/|scripts\/(?:codesign-mac-app|create-dmg|notarize-mac-artifact|package-mac-app|package-mac-dist)\.sh$|scripts\/lib\/(?:plistbuddy|swift-toolchain)\.sh$|test\/scripts\/(?:codesign-mac-app|create-dmg|notarize-mac-artifact|package-mac-app|package-mac-dist)\.test\.ts$)/u;
let corepackPnpmShimDir;
let corepackPnpmShimCleanupRegistered = false;
let shrinkwrapPackageDirsForChangedPaths;

async function ensureChangedCheckRuntimeDependencies(paths) {
  if (!shouldRunShrinkwrapGuard(paths) || shrinkwrapPackageDirsForChangedPaths) {
    return;
  }
  ({ shrinkwrapPackageDirsForChangedPaths } = await import("./generate-npm-shrinkwrap.mjs"));
}

// Imported consumers expect the synchronous planning API. Direct CLI execution
// delays package-backed imports until after lane and remote-routing selection.
if (!isDirectRun()) {
  await ensureChangedCheckRuntimeDependencies(["package.json"]);
}

export function createChangedCheckChildEnv(baseEnv = process.env) {
  const resolvedBaseEnv = resolveLocalHeavyCheckEnv(baseEnv);
  return {
    ...resolvedBaseEnv,
    OPENCLAW_OXLINT_SKIP_LOCK: "1",
    OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: "1",
    OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1",
  };
}

function isTruthyEnvFlag(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

function hasAndroidVersionSyncPath(paths) {
  return paths.some((changedPath) =>
    ANDROID_VERSION_SYNC_PATHS.has(normalizeChangedPath(changedPath)),
  );
}

function hasMacosAppCiPath(paths) {
  return paths.some((changedPath) => MACOS_APP_CI_PATH_RE.test(normalizeChangedPath(changedPath)));
}

function executableExistsOnPath(command, env = process.env) {
  const pathValue = env.PATH ?? env.Path ?? "";
  const pathExts =
    process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const searchPath of pathValue.split(path.delimiter)) {
    if (!searchPath) {
      continue;
    }
    for (const ext of pathExts) {
      try {
        accessSync(path.join(searchPath, `${command}${ext}`), constants.X_OK);
        return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

function shouldSkipAppLintForMissingSwiftlint(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const swiftlintAvailable = options.swiftlintAvailable ?? executableExistsOnPath("swiftlint", env);
  return platform !== "darwin" && !swiftlintAvailable;
}

export function changedCheckLocalDependenciesReady(cwd = process.cwd()) {
  const nodeModules = path.join(cwd, "node_modules");
  return (
    existsSync(path.join(nodeModules, ".modules.yaml")) &&
    existsSync(path.join(nodeModules, ".bin", "oxfmt")) &&
    existsSync(path.join(nodeModules, "typescript", "package.json"))
  );
}

export function changedCheckRequiresRemote(result) {
  if (!result || result.paths.length === 0) {
    return false;
  }
  if (
    shouldRunSqliteSessionSchemaBaselineCheck(result.paths) ||
    shouldRunPluginSdkApiBaselineCheck(result.paths)
  ) {
    return true;
  }
  if (result.docsOnly) {
    return false;
  }
  return Object.entries(result.lanes).some(
    ([lane, enabled]) => enabled && lane !== "docs" && lane !== "releaseMetadata",
  );
}

export function shouldDelegateChangedCheckToCrabbox(argv = [], env = process.env, options = {}) {
  if (isTruthyEnvFlag(env.OPENCLAW_CHECK_CHANGED_REMOTE_CHILD)) {
    return false;
  }
  if (isTruthyEnvFlag(env.CI) || isTruthyEnvFlag(env.GITHUB_ACTIONS)) {
    return false;
  }
  if (argv.includes("--dry-run")) {
    return false;
  }
  const result = options.result;
  if (!result) {
    return true;
  }
  if (result.paths.length === 0) {
    return false;
  }
  if (isTruthyEnvFlag(env.OPENCLAW_TESTBOX)) {
    return true;
  }
  // Release metadata plans diff the supplied commits after classification. A missing
  // ref needs the hydrated remote checkout even when the explicit path itself is cheap.
  if (result.lanes.releaseMetadata && options.diffRefsReady === false) {
    return true;
  }
  return (
    changedCheckRequiresRemote(result) ||
    !changedCheckLocalDependenciesReady(options.cwd ?? process.cwd())
  );
}

function changedCheckDiffRefsReady({ base, head, cwd = process.cwd() }) {
  for (const ref of [base, head]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        cwd,
        stdio: "ignore",
      });
    } catch {
      return false;
    }
  }
  return true;
}

export function buildChangedCheckCrabboxArgs(argv = [], options = {}) {
  const delegatedArgv = buildDelegatedChangedCheckArgv(argv, options);
  return [
    "crabbox:run",
    "--",
    "--provider",
    "blacksmith-testbox",
    "--blacksmith-org",
    "openclaw",
    "--blacksmith-workflow",
    ".github/workflows/ci-check-testbox.yml",
    "--blacksmith-job",
    "check",
    "--blacksmith-ref",
    "main",
    "--idle-timeout",
    "90m",
    "--ttl",
    "240m",
    "--timing-json",
    "--",
    "env",
    "OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1",
    "OPENCLAW_CHANGED_LANES_RAW_SYNC=1",
    "CI=1",
    "PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false",
    "corepack",
    "pnpm",
    "check:changed",
    ...delegatedArgv,
  ];
}

function buildDelegatedChangedCheckArgv(argv, options = {}) {
  const args = parseArgs(argv);
  if (!args.staged || args.paths.length > 0) {
    return argv;
  }
  const stagedPaths = listStagedChangedPaths(options.cwd);
  const next = [];
  if (args.timed) {
    next.push("--timed");
  }
  if (stagedPaths.length === 0) {
    next.push("--no-changes");
    return next;
  }
  next.push("--base", "HEAD", "--head", "HEAD");
  next.push("--", ...stagedPaths);
  return next;
}

export function shouldRunShrinkwrapGuard(paths) {
  return paths.some((changedPath) => SHRINKWRAP_POLICY_PATH_RE.test(changedPath));
}

export function shouldRunPromptSnapshotCheck(paths) {
  return paths.some((changedPath) => PROMPT_SNAPSHOT_CHECK_PATH_RE.test(changedPath));
}

export function shouldRunPromptSnapshotOwnerTest(paths) {
  return paths.some((changedPath) => PROMPT_SNAPSHOT_OWNER_TEST_PATH_RE.test(changedPath));
}

export function shouldRunControlUiI18nVerify(paths) {
  return paths.some((changedPath) =>
    CONTROL_UI_I18N_VERIFY_PATH_RE.test(normalizeChangedPath(changedPath)),
  );
}

export function shouldRunRuntimeSidecarBaselineCheck(paths) {
  return paths.some((changedPath) => RUNTIME_SIDECAR_BASELINE_PATH_RE.test(changedPath));
}

/** Returns whether changed files can affect the sessions/transcripts SQLite schema baseline. */
export function shouldRunSqliteSessionSchemaBaselineCheck(paths) {
  return paths.some((changedPath) =>
    SQLITE_SESSION_SCHEMA_BASELINE_PATH_RE.test(normalizeChangedPath(changedPath)),
  );
}

/** Returns whether changed files can alter the published Plugin SDK API contract. */
export function shouldRunPluginSdkApiBaselineCheck(paths) {
  return paths.some((changedPath) => {
    const normalizedPath = normalizeChangedPath(changedPath);
    return (
      !getChangedPathFacts(normalizedPath).isTestOnly &&
      PLUGIN_SDK_API_BASELINE_PATH_RE.test(normalizedPath)
    );
  });
}

/** Returns whether changed files can alter Plugin SDK exports or surface budgets. */
export function shouldRunPluginSdkSurfaceChecks(paths) {
  return paths.some((changedPath) =>
    PLUGIN_SDK_SURFACE_PATH_RE.test(normalizeChangedPath(changedPath)),
  );
}

/** Returns whether changed files can alter deprecated API or plugin-boundary results. */
export function shouldRunDeprecationHygieneChecks(paths) {
  return paths.some((changedPath) =>
    DEPRECATION_HYGIENE_PATH_RE.test(normalizeChangedPath(changedPath)),
  );
}

export function shouldRunCanvasA2uiNativeResourceCheck(paths) {
  return paths.some((changedPath) =>
    CANVAS_A2UI_NATIVE_RESOURCE_PATH_RE.test(normalizeChangedPath(changedPath)),
  );
}

export function shouldRunAppcastOwnerTest(paths) {
  return paths.some((changedPath) => normalizeChangedPath(changedPath) === "appcast.xml");
}

export function shouldRunTestTempCreationReport(paths) {
  return paths.some(
    (changedPath) => getChangedPathFacts(normalizeChangedPath(changedPath)).isChangedLaneTest,
  );
}

export function createShrinkwrapGuardCommand(paths) {
  if (!shouldRunShrinkwrapGuard(paths)) {
    return null;
  }
  if (!shrinkwrapPackageDirsForChangedPaths) {
    throw new Error("changed-check shrinkwrap runtime dependencies were not loaded");
  }
  const packageDirs = shrinkwrapPackageDirsForChangedPaths(paths);
  if (packageDirs.length === 0) {
    return null;
  }
  return {
    name:
      packageDirs.length === 1
        ? "npm shrinkwrap guard"
        : `npm shrinkwrap guard (${packageDirs.length} packages)`,
    bin: "node",
    args: [
      "scripts/generate-npm-shrinkwrap.mjs",
      "--check",
      ...packageDirs.flatMap((packageDir) => ["--package-dir", packageDir]),
    ],
  };
}

async function runChangedCheckViaCrabbox(argv = [], env = process.env) {
  console.error("[check:changed] delegating to Blacksmith Testbox via `pnpm crabbox:run`.");
  return await runManagedCommand({
    bin: "pnpm",
    args: buildChangedCheckCrabboxArgs(argv),
    env,
  });
}

export function createChangedCheckPlan(result, options = {}) {
  const commands = [];
  const baseEnv = createChangedCheckChildEnv(options.env ?? process.env);
  const add = (name, args, env) => {
    if (!commands.some((command) => command.name === name && sameArgs(command.args, args))) {
      commands.push({ name, args, ...(env ? { env } : {}) });
    }
  };
  const addCommand = (name, bin, args, env) => {
    if (
      !commands.some(
        (command) => command.name === name && command.bin === bin && sameArgs(command.args, args),
      )
    ) {
      commands.push({ name, bin, args, ...(env ? { env } : {}) });
    }
  };
  const addTypecheck = (name, args) => add(name, args, createSparseTsgoSkipEnv(baseEnv));
  const addLint = (name, args) => add(name, args, baseEnv);
  const addTestTempCreationReport = () => {
    if (!shouldRunTestTempCreationReport(result.paths)) {
      return;
    }
    addCommand(
      "test temp creation report (warning-only)",
      "node",
      [
        "scripts/report-test-temp-creations.mjs",
        ...(options.staged
          ? ["--staged"]
          : ["--base", options.base ?? "origin/main", "--head", options.head ?? "HEAD"]),
      ],
      baseEnv,
    );
  };

  add("conflict markers", ["check:no-conflict-markers"]);
  if (
    result.paths.some((filePath) =>
      /^(?:src\/|ui\/src\/|packages\/|extensions\/|\.oxlintrc\.json$|config\/max-lines-baseline\.txt$|scripts\/check-max-lines-ratchet\.mjs$)/u.test(
        filePath,
      ),
    )
  ) {
    add("max-lines suppression ratchet", [
      "check:max-lines-ratchet",
      ...(options.staged ? ["--staged"] : []),
      "--base",
      options.staged ? "HEAD" : (options.base ?? "origin/main"),
    ]);
  }
  add("changelog attributions", ["check:changelog-attributions"]);
  add("guarded extension wildcard re-exports", ["lint:extensions:no-guarded-wildcard-reexports"]);
  add("plugin-sdk wildcard re-exports", ["lint:extensions:no-plugin-sdk-wildcard-reexports"]);
  add("duplicate scan target coverage", ["dup:check:coverage"]);
  add("dependency pin guard", ["deps:pins:check"]);
  if (result.paths.length > 0) {
    add("format changed files", [
      "format:check",
      "--no-error-on-unmatched-pattern",
      "--",
      ...result.paths,
    ]);
  }
  const shrinkwrapGuardCommand = createShrinkwrapGuardCommand(result.paths);
  if (shrinkwrapGuardCommand) {
    addCommand(
      shrinkwrapGuardCommand.name,
      shrinkwrapGuardCommand.bin,
      shrinkwrapGuardCommand.args,
      baseEnv,
    );
  }
  if (shouldRunPromptSnapshotCheck(result.paths)) {
    add("prompt snapshot drift", ["prompt:snapshots:check"]);
  }
  if (shouldRunPromptSnapshotOwnerTest(result.paths)) {
    add(
      "prompt snapshot owner test",
      ["test:serial", "test/scripts/prompt-snapshots.test.ts"],
      baseEnv,
    );
  }
  if (shouldRunRuntimeSidecarBaselineCheck(result.paths)) {
    add("runtime sidecar baseline", ["runtime-sidecars:check"]);
    add(
      "runtime sidecar owner test",
      ["test:serial", "src/plugins/bundled-plugin-metadata.test.ts"],
      baseEnv,
    );
  }
  if (shouldRunSqliteSessionSchemaBaselineCheck(result.paths)) {
    add("SQLite sessions/transcripts schema baseline", ["sqlite:sessions-schema:check"]);
  }
  if (shouldRunPluginSdkApiBaselineCheck(result.paths)) {
    add("Plugin SDK API baseline", ["plugin-sdk:api:check"]);
  }
  if (!result.lanes.releaseMetadata && shouldRunPluginSdkSurfaceChecks(result.paths)) {
    add("Plugin SDK package exports", ["plugin-sdk:check-exports"]);
    add("Plugin SDK surface budget", ["plugin-sdk:surface:check"]);
  }
  if (result.lanes.all || shouldRunDeprecationHygieneChecks(result.paths)) {
    add("deprecated API usage", ["check:deprecated-api-usage"]);
    // After 2026-07-24, lapsed compatibility windows intentionally fail this gate
    // until their scheduled deletion PRs land.
    add("plugin boundaries", ["plugins:boundary-report:ci"]);
  }
  if (shouldRunCanvasA2uiNativeResourceCheck(result.paths)) {
    addCommand(
      "Canvas A2UI native resource sync",
      "node",
      ["scripts/sync-native-a2ui.mjs", "--check"],
      baseEnv,
    );
  }
  if (shouldRunAppcastOwnerTest(result.paths)) {
    add(
      "appcast owner tests",
      ["test:serial", "test/appcast.test.ts", "test/scripts/make-appcast.test.ts"],
      baseEnv,
    );
  }
  add("package patch guard", ["deps:patches:check"]);

  if (result.docsOnly) {
    return {
      commands,
      summary: "docs-only",
    };
  }

  addTestTempCreationReport();

  const lanes = result.lanes;
  const runAll = lanes.all;
  const shouldRunAndroidVersionSync = hasAndroidVersionSyncPath(result.paths);

  if (lanes.releaseMetadata) {
    add("release metadata guard", [
      "release-metadata:check",
      ...(options.staged
        ? ["--staged"]
        : ["--base", options.base ?? "origin/main", "--head", options.head ?? "HEAD"]),
    ]);
    add("Android version sync", ["android:version:check"]);
    add("iOS version sync", ["ios:version:check"]);
    add("config schema baseline", ["config:schema:check"]);
    add("config docs baseline", ["config:docs:check"]);
    add("root dependency ownership", ["deps:root-ownership:check"]);
    return {
      commands,
      summary: "release metadata",
    };
  }

  if (shouldRunAndroidVersionSync) {
    add("Android version sync", ["android:version:check"]);
  }

  if (runAll) {
    add("database-first legacy-store guard", ["check:database-first-legacy-stores"]);
    add("media download helper guard", ["check:media-download-helpers"]);
    add("runtime sidecar loader guard", ["check:runtime-sidecar-loaders"]);
    addTypecheck("typecheck all", ["tsgo:all"]);
    addLint("lint", ["lint"]);
    add("runtime import cycles", ["check:import-cycles"]);
    return {
      commands,
      summary: "all",
    };
  }

  if (shouldRunControlUiI18nVerify(result.paths)) {
    addLint("Control UI i18n catalog", ["lint:ui:i18n"]);
  }

  if (lanes.core) {
    addTypecheck("typecheck core", ["tsgo:core"]);
  }
  if (lanes.coreTests) {
    addTypecheck("typecheck core tests", ["tsgo:core:test"]);
  }
  if (lanes.ui) {
    addTypecheck("typecheck UI", ["tsgo:ui"]);
  }
  if (lanes.extensions) {
    addTypecheck("typecheck extensions", ["tsgo:extensions"]);
  }
  if (lanes.extensionTests) {
    addTypecheck("typecheck extension tests", ["tsgo:extensions:test"]);
  }
  if (lanes.scripts) {
    addTypecheck("typecheck scripts", ["tsgo:scripts"]);
  }
  if (lanes.testRoot) {
    addTypecheck("typecheck test root", ["tsgo:test:root"]);
  }

  if (lanes.core || lanes.coreTests || lanes.ui) {
    const coreLintCommand = createTargetedCoreLintCommand(result.paths, baseEnv);
    if (coreLintCommand) {
      addCommand(
        coreLintCommand.name,
        coreLintCommand.bin,
        coreLintCommand.args,
        coreLintCommand.env,
      );
    } else {
      addLint("lint core", ["lint:core"]);
    }
  }
  if (
    lanes.liveDockerTooling &&
    result.paths.some((changedPath) => getChangedPathFacts(changedPath).surface === "source")
  ) {
    addTypecheck("typecheck core tests", ["tsgo:core:test"]);
    addLint("lint core", ["lint:core"]);
  }
  if (lanes.extensions || lanes.extensionTests) {
    const extensionLintCommand = createTargetedExtensionLintCommand(result.paths, baseEnv);
    if (extensionLintCommand) {
      addCommand(
        extensionLintCommand.name,
        extensionLintCommand.bin,
        extensionLintCommand.args,
        extensionLintCommand.env,
      );
    } else {
      addLint("lint extensions", ["lint:extensions"]);
    }
  }
  if (lanes.tooling || lanes.liveDockerTooling) {
    const scriptLintCommand = createTargetedScriptLintCommand(result.paths, baseEnv);
    if (scriptLintCommand) {
      addLint("lint docker-e2e", ["lint:docker-e2e"]);
      addLint("raw HTTP/2 import guard", ["lint:tmp:no-raw-http2-imports"]);
      addCommand(
        scriptLintCommand.name,
        scriptLintCommand.bin,
        scriptLintCommand.args,
        scriptLintCommand.env,
      );
    } else {
      addLint("lint scripts", ["lint:scripts"]);
    }
  }
  if (lanes.apps && shouldSkipAppLintForMissingSwiftlint({ ...options, env: baseEnv })) {
    addCommand(
      "lint apps (swiftlint unavailable on this host)",
      "node",
      [
        "-e",
        "console.error('[check:changed] Swift app lint skipped: swiftlint is unavailable on this non-macOS host; macOS CI owns SwiftLint coverage.')",
      ],
      baseEnv,
    );
  } else if (lanes.apps) {
    addLint("lint apps", ["lint:apps"]);
  }
  if (hasMacosAppCiPath(result.paths)) {
    add("macOS app CI tests", ["test:macos:ci"], baseEnv);
  }

  if (lanes.core || lanes.extensions) {
    add("database-first legacy-store guard", ["check:database-first-legacy-stores"]);
    add("media download helper guard", ["check:media-download-helpers"]);
    add("runtime sidecar loader guard", ["check:runtime-sidecar-loaders"]);
    add("runtime import cycles", ["check:import-cycles"]);
  }
  if (lanes.core) {
    add("webhook body guard", ["lint:webhook:no-low-level-body-read"]);
    add("pairing store guard", ["lint:auth:no-pairing-store-group"]);
    add("pairing account guard", ["lint:auth:pairing-account-scope"]);
  }

  if (lanes.liveDockerTooling) {
    addCommand("live Docker shell syntax", "bash", ["-n", ...LIVE_DOCKER_AUTH_SHELL_TARGETS]);
    addCommand("live Docker scheduler dry run", "node", ["scripts/test-docker-all.mjs"], {
      ...baseEnv,
      OPENCLAW_DOCKER_ALL_DRY_RUN: "1",
      OPENCLAW_DOCKER_ALL_LIVE_MODE: "only",
    });
  }

  return {
    commands,
    summary: Object.entries(lanes)
      .filter(([, enabled]) => enabled)
      .map(([lane]) => lane)
      .join(", "),
  };
}

export function createTargetedCoreLintCommand(paths, env = process.env, options = {}) {
  return createTargetedOxlintCommand({
    env,
    label: "core",
    lintablePathRe: LINTABLE_CORE_PATH_RE,
    neutralPathRe: CORE_LINT_OPTIMIZATION_NEUTRAL_PATH_RE,
    paths,
    tsconfig: CORE_OXLINT_TS_CONFIG,
    ...options,
  });
}

export function createTargetedExtensionLintCommand(paths, env = process.env, options = {}) {
  return createTargetedOxlintCommand({
    env,
    label: "extension",
    lintablePathRe: LINTABLE_EXTENSION_PATH_RE,
    neutralPathRe: EXTENSION_LINT_OPTIMIZATION_NEUTRAL_PATH_RE,
    paths,
    tsconfig: EXTENSIONS_OXLINT_TS_CONFIG,
    ...options,
  });
}

export function createTargetedScriptLintCommand(paths, env = process.env, options = {}) {
  return createTargetedOxlintCommand({
    env,
    label: "script",
    lintablePathRe: LINTABLE_SCRIPT_PATH_RE,
    neutralPathRe: SCRIPT_LINT_OPTIMIZATION_NEUTRAL_PATH_RE,
    paths,
    tsconfig: SCRIPTS_OXLINT_TS_CONFIG,
    ...options,
  });
}

function createTargetedOxlintCommand({
  env = process.env,
  fileExists = existsSync,
  label,
  lintablePathRe,
  neutralPathRe,
  paths,
  tsconfig,
}) {
  if (
    paths.some(
      (changedPath) =>
        !lintablePathRe.test(changedPath) &&
        !neutralPathRe.test(changedPath) &&
        !MARKDOWN_LINT_OPTIMIZATION_NEUTRAL_PATH_RE.test(changedPath),
    )
  ) {
    return null;
  }
  const targets = paths
    .filter((changedPath) => lintablePathRe.test(changedPath))
    .toSorted((left, right) => left.localeCompare(right));
  if (targets.length === 0 || targets.length > TARGETED_LINT_PATH_LIMIT) {
    return null;
  }
  if (!targets.every((target) => fileExists(target))) {
    return null;
  }
  return {
    name: targets.length === 1 ? `lint ${label} changed file` : `lint ${label} changed files`,
    bin: "node",
    args: ["scripts/run-oxlint.mjs", "--tsconfig", tsconfig, ...targets],
    env,
  };
}

async function runChangedCheck(result, options = {}) {
  if (result.paths.length === 0) {
    console.error("[check:changed] no changed paths; nothing to run");
    return 0;
  }
  await ensureChangedCheckRuntimeDependencies(result.paths);
  const baseEnv = resolveLocalHeavyCheckEnv(options.env ?? process.env);
  const childEnv = createChangedCheckChildEnv(baseEnv);
  const plan = createChangedCheckPlan(result, {
    ...options,
    env: childEnv,
  });
  const releaseLock = options.dryRun
    ? () => {}
    : acquireLocalHeavyCheckLockSync({
        cwd: process.cwd(),
        env: baseEnv,
        toolName: "check:changed",
      });

  try {
    printPlan(result, plan, options);

    if (options.dryRun) {
      return 0;
    }

    const timings = [];
    for (const command of plan.commands) {
      const status = await runPlanCommand(command, timings);
      if (status !== 0) {
        printSummary(timings, options);
        return status;
      }
    }

    printSummary(timings, options);
    return 0;
  } finally {
    releaseLock();
  }
}

function sameArgs(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function printPlan(result, plan, options) {
  const prefix = options.dryRun ? "[check:changed:dry-run]" : "[check:changed]";
  console.error(`${prefix} lanes=${plan.summary || "none"}`);
  if (result.extensionImpactFromCore) {
    console.error(`${prefix} extension-impacting surface; extension typecheck included`);
  }
  for (const reason of result.reasons) {
    console.error(`${prefix} ${reason}`);
  }
  if (options.dryRun) {
    for (const command of plan.commands) {
      console.error(`${prefix} would run: ${formatPlanCommand(command)}`);
    }
  }
}

async function runPnpm(command, timings) {
  return await runCommand(createPnpmManagedCommand(command), timings);
}

async function runPlanCommand(command, timings) {
  if (command.bin) {
    return await runCommand(command, timings);
  }
  return await runPnpm(command, timings);
}

function formatPlanCommand(command) {
  const argv = command.bin ? [command.bin, ...command.args] : ["pnpm", ...command.args];
  return argv.map(formatShellToken).join(" ");
}

function formatShellToken(token) {
  return /^[A-Za-z0-9_./:@=-]+$/u.test(token) ? token : `'${token.replaceAll("'", "'\\''")}'`;
}

export function createPnpmManagedCommand(command, env = process.env) {
  const commandEnv = command.env ?? resolveLocalHeavyCheckEnv(env);
  if (isTruthyEnvFlag(commandEnv.CI) || isTruthyEnvFlag(commandEnv.GITHUB_ACTIONS)) {
    const shimmedEnv = prependCorepackPnpmShim(commandEnv);
    return {
      ...command,
      bin: "corepack",
      args: ["pnpm", ...command.args],
      env: shimmedEnv,
    };
  }
  return { ...command, bin: "pnpm", env: commandEnv };
}

function prependCorepackPnpmShim(env) {
  const shimDir = ensureCorepackPnpmShimDir();
  return {
    ...env,
    PATH: [shimDir, env.PATH ?? env.Path ?? ""].filter(Boolean).join(path.delimiter),
  };
}

function ensureCorepackPnpmShimDir() {
  if (corepackPnpmShimDir) {
    return corepackPnpmShimDir;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-corepack-pnpm-"));
  const pnpmPath = path.join(dir, "pnpm");
  writeFileSync(pnpmPath, '#!/bin/sh\nexec corepack pnpm "$@"\n', "utf8");
  chmodSync(pnpmPath, 0o755);
  writeFileSync(path.join(dir, "pnpm.cmd"), "@echo off\r\ncorepack pnpm %*\r\n", "utf8");
  corepackPnpmShimDir = dir;
  registerCorepackPnpmShimCleanup();
  return dir;
}

function registerCorepackPnpmShimCleanup() {
  if (corepackPnpmShimCleanupRegistered) {
    return;
  }
  corepackPnpmShimCleanupRegistered = true;
  process.once("exit", cleanupCorepackPnpmShimDir);
}

export function cleanupCorepackPnpmShimDir() {
  if (!corepackPnpmShimDir) {
    return;
  }
  const dir = corepackPnpmShimDir;
  corepackPnpmShimDir = undefined;
  rmSync(dir, { recursive: true, force: true });
}

async function runCommand(command, timings) {
  const startedAt = performance.now();
  console.error(`\n[check:changed] ${command.name}`);
  let status = 1;
  try {
    status = await runManagedCommand({
      bin: command.bin,
      args: command.args,
      env: command.env ?? resolveLocalHeavyCheckEnv(),
    });
  } catch (error) {
    console.error(error);
  }

  timings.push({
    name: command.name,
    durationMs: performance.now() - startedAt,
    status,
  });
  return status;
}

function printSummary(timings, options) {
  printTimingSummary("check:changed", timings, { skipWhenAllOk: !options.timed });
}

function parseArgs(argv) {
  const separatorIndex = argv.indexOf("--");
  const flagArgv = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
  const explicitPaths =
    separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1).map(normalizeChangedPath);
  const args = {
    base: "origin/main",
    head: "HEAD",
    staged: false,
    dryRun: false,
    timed: false,
    noChanges: false,
    help: false,
    paths: [],
  };
  const parsed = parseFlagArgs(
    flagArgv,
    args,
    [
      stringFlag("--base", "base"),
      stringFlag("--head", "head"),
      booleanFlag("--staged", "staged"),
      booleanFlag("--dry-run", "dryRun"),
      booleanFlag("--timed", "timed"),
      booleanFlag("--no-changes", "noChanges"),
      booleanFlag("--help", "help"),
      booleanFlag("-h", "help"),
    ],
    {
      onUnhandledArg(arg, target) {
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        target.paths.push(normalizeChangedPath(arg));
        return "handled";
      },
    },
  );
  parsed.paths.push(...explicitPaths);
  return parsed;
}

function printUsage() {
  process.stdout.write(
    [
      "Usage: node scripts/check-changed.mjs [options] [-- <paths...>]",
      "",
      "Options:",
      "  --base <ref>     Base ref for changed paths (default: origin/main)",
      "  --head <ref>     Head ref for changed paths (default: HEAD)",
      "  --staged         Check staged paths instead of git diff paths",
      "  --dry-run        Print the planned checks without running them",
      "  --timed          Print timing summary",
      "  --no-changes     Treat the changed path set as empty",
      "  -h, --help       Show this help",
      "",
    ].join("\n"),
  );
}

function isDirectRun() {
  return isDirectRunUrl(process.argv[1], import.meta.url);
}

if (isDirectRun()) {
  const argv = process.argv.slice(2);
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  if (args.help) {
    printUsage();
    process.exitCode = 0;
  } else {
    let paths;
    try {
      paths = args.noChanges
        ? []
        : args.paths.length > 0
          ? args.paths
          : args.staged
            ? listStagedChangedPaths()
            : listChangedPathsFromGit({ base: args.base, head: args.head });
    } catch (error) {
      // A sparse/fresh checkout may not have the requested base ref yet. The remote
      // workflow fetches it, so preserve explicit/default delegation instead of dying locally.
      if (!shouldDelegateChangedCheckToCrabbox(argv, process.env)) {
        throw error;
      }
      process.exitCode = await runChangedCheckViaCrabbox(argv, process.env);
    }
    if (paths) {
      const result = detectChangedLanesForPaths({
        paths,
        base: args.base,
        head: args.head,
        staged: args.staged,
      });
      if (
        shouldDelegateChangedCheckToCrabbox(argv, process.env, {
          cwd: process.cwd(),
          result,
          diffRefsReady: result.lanes.releaseMetadata
            ? args.staged ||
              changedCheckDiffRefsReady({
                base: args.base,
                head: args.head,
              })
            : undefined,
        })
      ) {
        process.exitCode = await runChangedCheckViaCrabbox(argv, process.env);
      } else {
        process.exitCode = await runChangedCheck(result, {
          ...args,
          explicitPaths: args.paths.length > 0,
        });
      }
    }
  }
}

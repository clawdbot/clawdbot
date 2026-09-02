// Runs the changed-file check lanes selected by `scripts/changed-lanes.mts`.
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
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  LIVE_DOCKER_AUTH_SHELL_TARGETS,
  detectChangedLanesForPaths,
  hasDeadcodeScannedSource,
  hasProtocolEventCoverageInput,
  listChangedPathsFromGit,
  listStagedChangedPaths,
} from "./changed-lanes.mts";
import type { ChangedLaneResult } from "./changed-lanes.mts";
import { detectChangedScope, isMacosToolingPath } from "./ci-changed-scope.mjs";
import {
  booleanFlag,
  isOpenEndedTruthyValue,
  parseFlagArgs,
  stringFlag,
} from "./lib/arg-utils.mts";
import { getChangedPathFacts, normalizeChangedPath } from "./lib/changed-path-facts.mjs";
import { printTimingSummary } from "./lib/check-timing-summary.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { runWithFailedTrailer } from "./lib/failed-trailer.mts";
import { resolveLocalCheckEnv } from "./lib/local-check-runtime.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";
import { listGeneratedExtensionAssetSources } from "./lib/static-extension-assets.mts";
import { createSparseTsgoSkipEnv } from "./lib/tsgo-sparse-guard.mts";
import type { createChangedCoreTestCheck } from "./run-tsgo-core-test-shards.mts";

type ChangedCheckCommand = {
  coreTestCheck?: "checkBoundary" | "checkTypes";
  name: string;
  args: string[];
  bin?: string;
  env?: NodeJS.ProcessEnv;
};

type ChangedCheckPlanOptions = {
  env?: NodeJS.ProcessEnv;
  staged?: boolean;
  base?: string;
  head?: string;
  platform?: NodeJS.Platform;
  swiftlintAvailable?: boolean;
};

type TargetedLintOptions = {
  fileExists?: (path: string) => boolean;
};

type ChangedCheckDelegateOptions = {
  result?: ChangedLaneResult;
  diffRefsReady?: boolean;
};

type ChangedCheckRunOptions = ChangedCheckPlanOptions & {
  dryRun?: boolean;
  timed?: boolean;
  explicitPaths?: boolean;
};

type ChangedCheckTiming = Parameters<typeof printTimingSummary>[1][number];

type TargetedOxlintCommandOptions = TargetedLintOptions & {
  env?: NodeJS.ProcessEnv;
  label: string;
  lintablePathRe: RegExp;
  neutralPathRe: RegExp;
  paths: string[];
  tsconfig: string;
};

type NpmLockPackageDirsResolver = (changedPaths: string[]) => string[];
type TargetedLintCommand = NonNullable<ReturnType<typeof createTargetedOxlintCommand>>;

const NPM_LOCK_POLICY_PATH_RE =
  /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|scripts\/generate-npm-package-lock\.mts|(?:extensions|packages)\/[^/]+(?:\/.*)?\/package\.json)$/u;
const PROMPT_SNAPSHOT_CHECK_PATH_RE =
  /^(?:scripts\/(?:generate-prompt-snapshots\.ts|prompt-snapshot-files\.ts|sync-codex-model-prompt-fixture\.ts)|test\/helpers\/agents\/(?:happy-path-prompt-snapshots|prompt-snapshot-paths)\.ts|test\/fixtures\/agents\/prompt-snapshots\/.+)$/u;
const PROMPT_SNAPSHOT_OWNER_TEST_PATH_RE =
  /^(?:scripts\/(?:generate-prompt-snapshots\.ts|prompt-snapshot-files\.ts|sync-codex-model-prompt-fixture\.ts)|test\/helpers\/agents\/(?:happy-path-prompt-snapshots|prompt-snapshot-paths)\.ts|test\/fixtures\/agents\/prompt-snapshots\/codex-model-catalog\/.+)$/u;
const RUNTIME_SIDECAR_BASELINE_PATH_RE =
  /^(?:scripts\/generate-runtime-sidecar-paths-baseline\.ts|scripts\/lib\/bundled-runtime-sidecar-paths\.json|src\/plugins\/runtime-sidecar-paths(?:-baseline)?\.ts)$/u;
// Doctor-contract declaration truth depends on arbitrary plugin source (artifacts
// re-export from src), so any non-test extension module or plugin manifest change
// must re-prove the src/plugins-owned declaration and closure-guard tests that the
// extension lanes would otherwise never select.
const DOCTOR_CONTRACT_OWNER_TEST_PATH_RE =
  /^extensions\/[^/]+\/(?:openclaw\.plugin\.json$|(?!.*\.test\.).*\.(?:c|m)?[jt]s$)/u;
const SQLITE_SESSION_SCHEMA_BASELINE_PATH_RE =
  /^(?:src\/state\/openclaw-agent-schema\.sql|scripts\/(?:generate-sqlite-session-schema-baseline\.ts|lib\/sqlite-session-schema-baseline\.ts)|test\/scripts\/sqlite-session-schema-baseline\.test\.ts|docs\/\.generated\/sqlite-session-transcript-schema-baseline\.sha256)$/u;
const PLUGIN_SDK_SURFACE_PATH_RE =
  /^(?:package\.json$|src\/plugin-sdk\/|packages\/plugin-sdk\/|extensions\/(?:tsconfig\.package-boundary\.paths\.json|xai\/tsconfig\.json)$|scripts\/(?:plugin-sdk-surface-report\.mts|sync-plugin-sdk-exports\.mts|lib\/plugin-sdk-(?:declaration-budget\.mts|deprecated-barrel-subpaths\.json|deprecated-public-subpaths\.json|entries\.mts|entrypoints\.json|private-local-only-subpaths\.json)))/u;
const DEPRECATION_HYGIENE_PATH_RE =
  /^(?:package\.json$|src\/|extensions\/|packages\/|scripts\/(?:check-deprecated-api-usage\.mts$|plugin-boundary-report\.ts$|lib\/plugin-sdk))/u;
const WRAPPER_SHADOWING_PATH_RE =
  /^(?:package\.json$|src\/|scripts\/(?:check-(?:export-name-collisions|wrapper-shadowing)\.mts$|lib\/ts-guard-utils\.mts$))/u;
const EXTENSION_TEST_CORE_IMPORT_PATH_RE =
  /^(?:extensions\/|test\/helpers\/|scripts\/(?:check-no-extension-test-core-imports|check-file-utils)\.ts$|scripts\/check-changed\.m[jt]s$)/u;
const CONTROL_UI_I18N_VERIFY_PATH_RE =
  /^(?:package\.json$|ui\/(?:src\/|config\/control-ui-locales\.ts$)|scripts\/(?:control-ui-i18n(?:-(?:report|verify))?\.ts|lib\/(?:control-ui-i18n-[^/]+\.ts|control-ui-i18n-config\.json))$|test\/scripts\/control-ui-i18n[^/]*\.test\.ts$)/u;
const SHRINK_RATCHET_OWNER_PATH = "scripts/lib/shrink-ratchet.mts";
const CORE_OXLINT_TS_CONFIG = "config/tsconfig/oxlint.core.json";
const EXTENSIONS_OXLINT_TS_CONFIG = "extensions/tsconfig.json";
const SCRIPTS_OXLINT_TS_CONFIG = "config/tsconfig/oxlint.scripts.json";
const ROOT_TEST_TS_CONFIG = "test/tsconfig/tsconfig.test.root.json";
const TARGETED_LINT_PATH_LIMIT = 8;
const LINTABLE_CORE_PATH_RE = /^(?:src|ui|packages)\/.+\.[cm]?[jt]sx?$/u;
const LINTABLE_EXTENSION_PATH_RE = /^extensions\/[^/]+\/.+\.[cm]?[jt]sx?$/u;
const LINTABLE_SCRIPT_PATH_RE = /^scripts\/.+\.[cm]?[jt]sx?$/u;
const LINTABLE_UI_STYLE_PATH_RE = /^ui\/(?:src\/.+\.(?:css|ts)|public\/themes\/[^/]+\.css)$/u;
const MARKDOWN_LINT_OPTIMIZATION_NEUTRAL_PATH_RE = /^(?:docs\/|README\.md$|.*\.mdx?$)/u;
const CORE_LINT_OPTIMIZATION_NEUTRAL_PATH_RE =
  /^(?:scripts|test\/scripts)\/|^\.github\/workflows\/ci\.yml$|^ui\/(?:src\/.+|public\/themes\/[^/]+)\.css$/u;
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
const SWIFT_BUILD_CACHE_METADATA_TEST_PATH = "test/scripts/swift-build-cache-metadata.test.ts";
const MACOS_APP_CI_PATH_RE =
  /^(?:apps\/(?:macos\/(?!Tests\/.+\.swift$)|(?:macos-mlx-tts|shared|swabble)\/)|Swabble\/|src\/(?:shared\/worker-bundle-hash\.ts|worker\/workspace-rsync-receiver\.ts|gateway\/worker-environments\/workspace-(?:accepted-(?:remote-script|sync)|mutation-remote-script|rsync-path\.test|sync(?:-helpers)?)\.ts)$)/u;
let corepackPnpmShimDir: string | undefined;
let corepackPnpmShimCleanupRegistered = false;
let cachedGeneratedExtensionAssetPaths: Set<string> | undefined;
let npmLockPackageDirsForChangedPaths: NpmLockPackageDirsResolver | undefined;

async function ensureChangedCheckRuntimeDependencies(paths: string[]) {
  if (!shouldRunNpmLockGuard(paths) || npmLockPackageDirsForChangedPaths) {
    return;
  }
  ({ npmLockPackageDirsForChangedPaths } = await import("./generate-npm-package-lock.mts"));
}

// Imported consumers expect the synchronous planning API. Direct CLI execution
// delays package-backed imports until after lane and remote-routing selection.
if (!isDirectRun()) {
  await ensureChangedCheckRuntimeDependencies(["package.json"]);
}

function createChangedCheckChildEnv(baseEnv: NodeJS.ProcessEnv = process.env) {
  return resolveLocalCheckEnv(baseEnv);
}

function hasAndroidVersionSyncPath(paths: string[]) {
  return paths.some((changedPath) =>
    ANDROID_VERSION_SYNC_PATHS.has(normalizeChangedPath(changedPath)),
  );
}

function hasMacosAppCiPath(paths: string[]) {
  // The metadata test has its own command; production edits still need native app proof.
  // Swift test-target sources do not feed the packaged app; native CI still covers them.
  return paths.some((changedPath) => {
    const normalized = normalizeChangedPath(changedPath);
    return (
      normalized !== SWIFT_BUILD_CACHE_METADATA_TEST_PATH &&
      (MACOS_APP_CI_PATH_RE.test(normalized) || isMacosToolingPath(normalized))
    );
  });
}

function executableExistsOnPath(command: string, env: NodeJS.ProcessEnv = process.env) {
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

function shouldSkipAppLintForMissingSwiftlint(options: ChangedCheckPlanOptions = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const swiftlintAvailable = options.swiftlintAvailable ?? executableExistsOnPath("swiftlint", env);
  return platform !== "darwin" && !swiftlintAvailable;
}

export function shouldDelegateChangedCheckToCrabbox(
  argv: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  options: ChangedCheckDelegateOptions = {},
) {
  if (isOpenEndedTruthyValue(env.OPENCLAW_CHECK_CHANGED_REMOTE_CHILD)) {
    return false;
  }
  if (isOpenEndedTruthyValue(env.CI) || isOpenEndedTruthyValue(env.GITHUB_ACTIONS)) {
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
  if (isOpenEndedTruthyValue(env.OPENCLAW_TESTBOX)) {
    return true;
  }
  // Release metadata plans diff the supplied commits after classification. A missing
  // ref needs the hydrated remote checkout even when the explicit path itself is cheap.
  if (result.lanes.releaseMetadata && options.diffRefsReady === false) {
    return true;
  }
  return false;
}

function changedCheckDiffRefsReady({
  base,
  head,
  cwd = process.cwd(),
}: {
  base: string;
  head: string;
  cwd?: string;
}) {
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

export function buildChangedCheckCrabboxArgs(argv: string[] = [], options: { cwd?: string } = {}) {
  const delegatedArgv = buildDelegatedChangedCheckArgv(argv, options);
  return [
    "scripts/crabbox-wrapper.mjs",
    "run",
    "--workload",
    "ci-fast",
    // Keep workload-routed calls provider-neutral. Blacksmith reads its workflow
    // defaults from .crabbox.yaml; cloud fallbacks must not receive its flags.
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

function buildDelegatedChangedCheckArgv(argv: string[], options: { cwd?: string } = {}) {
  const args = parseArgs(argv);
  if (!args.staged || args.paths.length > 0) {
    return argv;
  }
  const stagedPaths = listStagedChangedPaths(options.cwd);
  const timedArgs = args.timed ? ["--timed"] : [];
  if (stagedPaths.length === 0) {
    return [...timedArgs, "--no-changes"];
  }
  return [...timedArgs, "--base", "HEAD", "--head", "HEAD", "--", ...stagedPaths];
}

export function shouldRunNpmLockGuard(paths: string[]) {
  return paths.some((changedPath) => NPM_LOCK_POLICY_PATH_RE.test(changedPath));
}

export function shouldRunPromptSnapshotCheck(paths: string[]) {
  return paths.some((changedPath) => PROMPT_SNAPSHOT_CHECK_PATH_RE.test(changedPath));
}

export function shouldRunPromptSnapshotOwnerTest(paths: string[]) {
  return paths.some((changedPath) => PROMPT_SNAPSHOT_OWNER_TEST_PATH_RE.test(changedPath));
}

export function shouldRunControlUiI18nVerify(paths: string[]) {
  return paths.some((changedPath) =>
    CONTROL_UI_I18N_VERIFY_PATH_RE.test(normalizeChangedPath(changedPath)),
  );
}

export function shouldRunRuntimeSidecarBaselineCheck(paths: string[]) {
  return paths.some((changedPath) => RUNTIME_SIDECAR_BASELINE_PATH_RE.test(changedPath));
}

/** Returns whether changed files can drift bundled doctor-contract declarations or closures. */
export function shouldRunDoctorContractOwnerTests(paths: string[]) {
  return paths.some((changedPath) =>
    DOCTOR_CONTRACT_OWNER_TEST_PATH_RE.test(normalizeChangedPath(changedPath)),
  );
}

/** Returns whether changed files can affect the sessions/transcripts SQLite schema baseline. */
export function shouldRunSqliteSessionSchemaBaselineCheck(paths: string[]) {
  return paths.some((changedPath) =>
    SQLITE_SESSION_SCHEMA_BASELINE_PATH_RE.test(normalizeChangedPath(changedPath)),
  );
}

/** Returns whether changed files can alter Plugin SDK exports or surface budgets. */
export function shouldRunPluginSdkSurfaceChecks(paths: string[]) {
  return paths.some((changedPath) =>
    PLUGIN_SDK_SURFACE_PATH_RE.test(normalizeChangedPath(changedPath)),
  );
}

/** Returns whether changed files can alter deprecated API or plugin-boundary results. */
export function shouldRunDeprecationHygieneChecks(paths: string[]) {
  return paths.some((changedPath) =>
    DEPRECATION_HYGIENE_PATH_RE.test(normalizeChangedPath(changedPath)),
  );
}

/** Returns whether changed files can alter wrapper-shadowing results. */
export function shouldRunWrapperShadowingCheck(paths: string[]) {
  return paths.some((changedPath) =>
    WRAPPER_SHADOWING_PATH_RE.test(normalizeChangedPath(changedPath)),
  );
}

export function shouldRunAppcastOwnerTest(paths: string[]) {
  return paths.some((changedPath) => normalizeChangedPath(changedPath) === "appcast.xml");
}

export function shouldRunTestTempCreationReport(paths: string[]) {
  return paths.some(
    (changedPath) => getChangedPathFacts(normalizeChangedPath(changedPath)).isChangedLaneTest,
  );
}

export function createNpmLockGuardCommand(paths: string[]) {
  if (!shouldRunNpmLockGuard(paths)) {
    return null;
  }
  if (!npmLockPackageDirsForChangedPaths) {
    throw new Error("changed-check npm-lock runtime dependencies were not loaded");
  }
  const packageDirs = npmLockPackageDirsForChangedPaths(paths);
  if (packageDirs.length === 0) {
    return null;
  }
  return {
    name:
      packageDirs.length === 1
        ? "npm package-lock guard"
        : `npm package-lock guard (${packageDirs.length} packages)`,
    bin: "node",
    args: [
      "--import",
      "tsx",
      "scripts/generate-npm-package-lock.mts",
      ...packageDirs.flatMap((packageDir) => ["--package-dir", packageDir]),
    ],
  };
}

// Enough of the wrapper tail to hold its run summary; the rest is streamed, not kept.
const DELEGATION_OUTPUT_TAIL_LIMIT = 64 * 1024;

/**
 * Signatures of a failure that happened before the remote command was dispatched:
 * the broker or its API was unreachable, no lease was ever obtained, or workload
 * routing exhausted its provider chain (every provider doctor failed).
 */
const BACKEND_UNAVAILABLE_SIGNATURES = [
  /request failed: \w+ "https?:\/\/[^"]*blacksmith[^"]*"/iu,
  /context deadline exceeded/iu,
  /(?:no such host|dial tcp|connection refused|network is unreachable)/iu,
  /failed to (?:acquire|create|warm|start)\b[^\n]*\b(?:lease|testbox)/iu,
  // crabbox-wrapper prints this and exits before dispatching anything remote.
  /\[crabbox\] no ready provider for workload=/u,
];

/**
 * Whether a failed delegation provably never ran our command.
 *
 * Fails closed on purpose. A missing final summary alone cannot prove the remote
 * never started — a wrapper that crashes or loses its output transport after
 * dispatch looks identical — so this requires a positive pre-dispatch signature
 * and treats everything else as a real failure. Getting this backwards is the
 * dangerous direction: some lanes (prompt snapshots) are Linux-only truth, so a
 * local rerun on macOS could turn an unknown or failing gate green.
 *
 * `command-exit` vetoes regardless: it only appears once the command reached the
 * box, so it is proof a verdict exists and must be propagated as-is.
 */
export function delegationFailedBeforeRunning(output: string) {
  if (/"errorKind"\s*:\s*"command-exit"/u.test(output)) {
    return false;
  }
  return BACKEND_UNAVAILABLE_SIGNATURES.some((signature) => signature.test(output));
}

async function runChangedCheckViaCrabbox(
  argv: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
) {
  console.error("[check:changed] delegating through Crabbox workload routing.");
  let tail = "";
  const exitCode = await runManagedCommand({
    bin: "node",
    args: buildChangedCheckCrabboxArgs(argv),
    env,
    stdio: ["inherit", "pipe", "pipe"],
    onReady: (child) => {
      for (const stream of [child.stdout, child.stderr]) {
        stream?.on("data", (chunk: Buffer) => {
          tail = (tail + chunk.toString("utf8")).slice(-DELEGATION_OUTPUT_TAIL_LIMIT);
          // Inherited stdio used to get OS backpressure for free. Piping means we
          // have to reapply it, or a verbose delegated run buffers its whole
          // output in this process when stderr is an async pipe (typical in CI).
          if (!process.stderr.write(chunk)) {
            stream.pause();
            process.stderr.once("drain", () => stream.resume());
          }
        });
      }
    },
  });
  return {
    exitCode,
    backendUnavailable: exitCode !== 0 && delegationFailedBeforeRunning(tail),
  };
}

export function createChangedCheckPlan(
  result: ChangedLaneResult,
  options: ChangedCheckPlanOptions = {},
) {
  const commands: ChangedCheckCommand[] = [];
  const broadAudits = new Set<ChangedCheckCommand>();
  const typechecks = new Set<ChangedCheckCommand>();
  const baseEnv: NodeJS.ProcessEnv = createChangedCheckChildEnv(options.env ?? process.env);
  const generatedExtensionAssetPaths = result.paths.some((changedPath) =>
    LINTABLE_EXTENSION_PATH_RE.test(changedPath),
  )
    ? (cachedGeneratedExtensionAssetPaths ??= new Set(listGeneratedExtensionAssetSources()))
    : new Set<string>();
  const add = (name: string, args: string[], env?: NodeJS.ProcessEnv) => {
    const existing = commands.find(
      (command) => command.name === name && sameArgs(command.args, args),
    );
    if (existing) {
      return existing;
    }
    const command = { name, args, ...(env ? { env } : {}) };
    commands.push(command);
    return command;
  };
  const addCommand = (name: string, bin: string, args: string[], env?: NodeJS.ProcessEnv) => {
    const existing = commands.find(
      (command) => command.name === name && command.bin === bin && sameArgs(command.args, args),
    );
    if (existing) {
      return existing;
    }
    const command = { name, bin, args, ...(env ? { env } : {}) };
    commands.push(command);
    return command;
  };
  const addTypecheck = (name: string, args: string[]) =>
    typechecks.add(add(name, args, createSparseTsgoSkipEnv(baseEnv)));
  const finishPlan = (summary: string) => {
    // Full lint shards exclude test/. Keep changed root sources covered even
    // when another path selects the all-lane early return, without widening lint.
    let rootTestTargets = result.paths.filter(
      (file) => getChangedPathFacts(file).isRootTestSource && existsSync(file),
    );
    if (rootTestTargets.length > 0) {
      // --tsconfig affects import resolution, not native semantic discovery or
      // target selection. Expand the canonical roots before passing explicit files.
      const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
      const config = ts.getParsedCommandLineOfConfigFile(
        path.resolve(ROOT_TEST_TS_CONFIG),
        {},
        {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic(diagnostic) {
            throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
          },
        },
      );
      if (!config || config.errors.length > 0) {
        throw new Error(
          `Invalid ${ROOT_TEST_TS_CONFIG}: ${config?.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n")}`,
        );
      }
      const roots = new Set(config.fileNames.map((file) => path.resolve(file)));
      rootTestTargets = rootTestTargets.filter((file) => roots.has(path.resolve(file)));
    }
    for (let offset = 0; offset < rootTestTargets.length; offset += TARGETED_LINT_PATH_LIMIT) {
      const batch = rootTestTargets.slice(offset, offset + TARGETED_LINT_PATH_LIMIT);
      addCommand(
        batch.length === 1 ? "lint test root changed file" : "lint test root changed files",
        "node",
        ["scripts/run-oxlint.mjs", "--tsconfig", ROOT_TEST_TS_CONFIG, ...batch],
        baseEnv,
      );
    }
    const end = commands.findLastIndex((command) => typechecks.has(command)) + 1;
    const prefix = commands.slice(0, end);
    // These audits produce diagnostics, not compiler inputs. Defer them without
    // moving compiler prerequisites or overlapping their resource-heavy processes.
    return {
      commands: [
        ...prefix.filter((command) => !broadAudits.has(command)),
        ...prefix.filter((command) => broadAudits.has(command)),
        ...commands.slice(end),
      ],
      summary,
    };
  };
  const addLint = (name: string, args: string[]) => add(name, args, baseEnv);
  const addTargetedLint = (
    createCommand: (
      paths: string[],
      env?: NodeJS.ProcessEnv,
      options?: TargetedLintOptions,
    ) => TargetedLintCommand | null,
    lintablePathRe: RegExp,
    fallbackName: string,
    fallbackArgs: string[],
    ignoredPaths?: Set<string>,
    fallbackWithoutTargets = true,
  ) => {
    const candidatePaths = ignoredPaths
      ? result.paths.filter((changedPath) => !ignoredPaths.has(changedPath))
      : result.paths;
    const targets = candidatePaths.filter((changedPath) => lintablePathRe.test(changedPath));
    const otherPaths = candidatePaths.filter((changedPath) => !lintablePathRe.test(changedPath));
    const targetedCommands: TargetedLintCommand[] = [];

    for (let offset = 0; offset < targets.length; offset += TARGETED_LINT_PATH_LIMIT) {
      const command = createCommand(
        [...otherPaths, ...targets.slice(offset, offset + TARGETED_LINT_PATH_LIMIT)],
        baseEnv,
      );
      if (!command) {
        addLint(fallbackName, fallbackArgs);
        return false;
      }
      targetedCommands.push(command);
    }

    if (targetedCommands.length === 0) {
      if (fallbackWithoutTargets) {
        addLint(fallbackName, fallbackArgs);
      }
      return !fallbackWithoutTargets;
    }
    for (const command of targetedCommands) {
      addCommand(command.name, command.bin, command.args, command.env);
    }
    return true;
  };
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

  if (result.lanes.all || hasProtocolEventCoverageInput(result.paths)) {
    addCommand(
      "mobile protocol event coverage",
      "node",
      ["scripts/check-protocol-event-coverage.mjs"],
      baseEnv,
    );
  }
  add("conflict markers", ["check:no-conflict-markers"]);
  if (
    result.paths.some(
      (filePath) =>
        filePath === SHRINK_RATCHET_OWNER_PATH ||
        /^(?:src\/|ui\/src\/|packages\/|extensions\/|\.oxlintrc\.json$|config\/(?:env-var-count-budget|max-lines-baseline)\.txt$|scripts\/check-(?:env-var-count|max-lines-ratchet)\.mts$)/u.test(
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
  if (
    result.paths.some(
      (filePath) =>
        filePath === SHRINK_RATCHET_OWNER_PATH ||
        /^(?:src\/|ui\/src\/|packages\/|extensions\/|config\/assertion-safety-baseline\.txt$|scripts\/check-assertion-safety-ratchet\.mts$|scripts\/lib\/type-assertion-guard-scope\.mjs$|scripts\/oxlint-boundary-guards\.mjs$)/u.test(
          filePath,
        ),
    )
  ) {
    add("assertion SAFETY comment ratchet", [
      "check:assertion-safety",
      ...(options.staged ? ["--staged"] : []),
      "--base",
      options.staged ? "HEAD" : (options.base ?? "origin/main"),
    ]);
  }
  add("changelog attributions", ["check:changelog-attributions"]);
  add("doctor deprecation registry", ["check:doctor-deprecation-registry"]);
  add("guarded extension wildcard re-exports", ["lint:extensions:no-guarded-wildcard-reexports"]);
  add("plugin-sdk wildcard re-exports", ["lint:extensions:no-plugin-sdk-wildcard-reexports"]);
  if (
    result.lanes.all ||
    result.paths.some((changedPath) => EXTENSION_TEST_CORE_IMPORT_PATH_RE.test(changedPath))
  ) {
    add("extension test core imports", ["lint:plugins:no-extension-test-core-imports"]);
  }
  add("duplicate scan target coverage", ["dup:check:coverage"]);
  broadAudits.add(add("coercion helper declaration guard", ["check:coercion-helpers"]));
  add("dependency pin guard", ["deps:pins:check"]);
  if (result.paths.length > 0) {
    add("format changed files", [
      "format:check",
      "--no-error-on-unmatched-pattern",
      "--",
      ...result.paths,
    ]);
  }
  const npmLockGuardCommand = createNpmLockGuardCommand(result.paths);
  if (npmLockGuardCommand) {
    addCommand(
      npmLockGuardCommand.name,
      npmLockGuardCommand.bin,
      npmLockGuardCommand.args,
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
  if (shouldRunDoctorContractOwnerTests(result.paths)) {
    add(
      "doctor contract declaration + closure guard tests",
      [
        "test:serial",
        "src/plugins/doctor-contract-declarations.test.ts",
        "src/plugins/doctor-contract-closure-guard.test.ts",
      ],
      baseEnv,
    );
  }
  if (result.lanes.all || result.lanes.bundledChannelConfigMetadata) {
    add("bundled channel config metadata", ["check:bundled-channel-config-metadata"]);
  }
  if (shouldRunSqliteSessionSchemaBaselineCheck(result.paths)) {
    add("SQLite sessions/transcripts schema baseline", ["sqlite:sessions-schema:check"]);
  }
  if (!result.lanes.releaseMetadata && shouldRunPluginSdkSurfaceChecks(result.paths)) {
    add("Plugin SDK package exports", ["plugin-sdk:check-exports"]);
    add("Plugin SDK surface budget", ["plugin-sdk:surface:check"]);
  }
  if (result.lanes.all || shouldRunDeprecationHygieneChecks(result.paths)) {
    broadAudits.add(add("deprecated API usage", ["check:deprecated-api-usage"]));
    // After 2026-07-24, lapsed compatibility windows intentionally fail this gate
    // until their scheduled deletion PRs land.
    add("plugin boundaries", ["plugins:boundary-report:ci"]);
  }
  if (result.lanes.all || shouldRunWrapperShadowingCheck(result.paths)) {
    add("wrapper shadowing", ["check:wrapper-shadowing"]);
  }
  if (shouldRunAppcastOwnerTest(result.paths)) {
    add(
      "appcast owner tests",
      ["test:serial", "test/appcast.test.ts", "test/scripts/make-appcast.test.ts"],
      baseEnv,
    );
  }
  if (
    result.paths.some(
      (changedPath) =>
        changedPath === "scripts/swift-build-cache-metadata.py" ||
        changedPath === SWIFT_BUILD_CACHE_METADATA_TEST_PATH,
    )
  ) {
    add(
      "Swift build cache metadata tests",
      ["test:serial", SWIFT_BUILD_CACHE_METADATA_TEST_PATH],
      baseEnv,
    );
  }
  add("package patch guard", ["deps:patches:check"]);
  if (
    hasDeadcodeScannedSource(result.paths) &&
    !isOpenEndedTruthyValue(baseEnv.OPENCLAW_CHECK_CHANGED_SKIP_DEADCODE)
  ) {
    broadAudits.add(
      addCommand(
        "dead export scan (skip with OPENCLAW_CHECK_CHANGED_SKIP_DEADCODE=1)",
        "node",
        ["--import", "tsx", "scripts/check-deadcode-exports.mts"],
        baseEnv,
      ),
    );
  }

  if (result.docsOnly) {
    return finishPlan("docs-only");
  }

  addTestTempCreationReport();

  const lanes = result.lanes;
  const runAll = lanes.all;
  const shouldRunAndroidVersionSync = hasAndroidVersionSyncPath(result.paths);

  // Typechecking alone accepts extension imports; the graph guard also covers
  // shared test/tooling dependencies that core tests can pull into their graph.
  const changedTestPaths = result.paths.filter(
    (file) => getChangedPathFacts(file).surface !== "docs",
  );
  const narrowCoreTests =
    !runAll &&
    !lanes.core &&
    !lanes.ui &&
    !lanes.tooling &&
    !lanes.liveDockerTooling &&
    changedTestPaths.length > 0 &&
    changedTestPaths.every((file) => /^(?:src|ui|packages)\/.+\.test\.tsx?$/u.test(file));
  if (runAll || lanes.core || lanes.coreTests || lanes.ui || lanes.tooling) {
    add("core tsgo graph boundary", ["lint:tmp:tsgo-core-boundary"]);
    if (narrowCoreTests) {
      commands.at(-1)!.coreTestCheck = "checkBoundary";
    }
  }

  if (runAll || lanes.scripts || result.paths.includes("scripts/check-script-erasability.mjs")) {
    add("script TypeScript erasability", ["check:script-erasability"]);
  }

  if (lanes.releaseMetadata) {
    add("release metadata guard", [
      "release-metadata:check",
      ...(options.staged
        ? ["--staged"]
        : ["--base", options.base ?? "origin/main", "--head", options.head ?? "HEAD"]),
    ]);
    add("Android version sync", ["android:version:check"]);
    add("config schema baseline", ["config:schema:check"]);
    add("config docs baseline", ["config:docs:check"]);
    add("root dependency ownership", ["deps:root-ownership:check"]);
    return finishPlan("release metadata");
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
    return finishPlan("all");
  }

  if (shouldRunControlUiI18nVerify(result.paths)) {
    addLint("Control UI i18n catalog", ["lint:ui:i18n"]);
  }
  if (lanes.core) {
    addTypecheck("typecheck core", ["tsgo:core"]);
  }
  if (lanes.coreTests) {
    addTypecheck("typecheck core tests", ["tsgo:core:test"]);
    if (narrowCoreTests) {
      commands.at(-1)!.coreTestCheck = "checkTypes";
    }
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
    // CSS is covered by targeted Stylelint below. Other non-Oxlint core/UI
    // inputs keep the full lane so changed checks do not silently drop lint.
    const fallbackWithoutTargets = result.paths.some((changedPath) => {
      const surface = getChangedPathFacts(changedPath).surface;
      return (
        (surface === "source" || surface === "package" || surface === "ui") &&
        !CORE_LINT_OPTIMIZATION_NEUTRAL_PATH_RE.test(changedPath) &&
        !MARKDOWN_LINT_OPTIMIZATION_NEUTRAL_PATH_RE.test(changedPath)
      );
    });
    addTargetedLint(
      createTargetedCoreLintCommand,
      LINTABLE_CORE_PATH_RE,
      "lint core",
      ["lint:core"],
      undefined,
      fallbackWithoutTargets,
    );
  }
  if (lanes.ui) {
    const targets = result.paths
      .filter(
        (changedPath) => LINTABLE_UI_STYLE_PATH_RE.test(changedPath) && existsSync(changedPath),
      )
      .toSorted((left, right) => left.localeCompare(right));
    for (let offset = 0; offset < targets.length; offset += TARGETED_LINT_PATH_LIMIT) {
      const batch = targets.slice(offset, offset + TARGETED_LINT_PATH_LIMIT);
      addCommand(
        batch.length === 1 ? "lint UI changed style file" : "lint UI changed style files",
        "node",
        ["--import", "tsx", "scripts/run-stylelint.mts", ...batch],
        baseEnv,
      );
    }
  }
  if (
    lanes.liveDockerTooling &&
    result.paths.some((changedPath) => getChangedPathFacts(changedPath).surface === "source")
  ) {
    add("core tsgo graph boundary", ["lint:tmp:tsgo-core-boundary"]);
    addTypecheck("typecheck core tests", ["tsgo:core:test"]);
    addLint("lint core", ["lint:core"]);
  }
  if (lanes.extensions || lanes.extensionTests) {
    // Generated plugin outputs have their own asset-integrity gate and are
    // intentionally ignored by oxlint; manifests still need full-lane fallback.
    if (
      !result.paths.some((changedPath) => generatedExtensionAssetPaths.has(changedPath)) ||
      result.paths.some(
        (changedPath) =>
          getChangedPathFacts(changedPath).surface === "extension" &&
          !generatedExtensionAssetPaths.has(changedPath),
      )
    ) {
      addTargetedLint(
        createTargetedExtensionLintCommand,
        LINTABLE_EXTENSION_PATH_RE,
        "lint extensions",
        ["lint:extensions"],
        generatedExtensionAssetPaths,
      );
    }
  }
  if (lanes.tooling || lanes.liveDockerTooling) {
    if (
      addTargetedLint(createTargetedScriptLintCommand, LINTABLE_SCRIPT_PATH_RE, "lint scripts", [
        "lint:scripts",
      ])
    ) {
      addLint("lint docker-e2e", ["lint:docker-e2e"]);
      addLint("raw HTTP/2 import guard", ["lint:tmp:no-raw-http2-imports"]);
    }
  }
  if (lanes.apps) {
    const appScopes = result.paths
      .filter((changedPath) => getChangedPathFacts(changedPath).surface === "app")
      .map((changedPath) => detectChangedScope([changedPath]));
    // Shared Apple sources select Android consumer CI, but Gradle ktlint owns
    // only Android-exclusive app paths. Classify each path so mixed diffs retain both.
    if (
      appScopes.some(
        ({ runAndroid, runMacos, runIosBuild }) => runAndroid && !runMacos && !runIosBuild,
      )
    ) {
      addLint("lint Android", ["android:lint"]);
    }
    if (appScopes.some(({ runMacos, runIosBuild }) => runMacos || runIosBuild)) {
      if (shouldSkipAppLintForMissingSwiftlint({ ...options, env: baseEnv })) {
        addCommand(
          "lint apps (swiftlint unavailable on this host)",
          "node",
          [
            "-e",
            "console.error('[check:changed] Swift app lint skipped: swiftlint is unavailable on this non-macOS host; macOS CI owns SwiftLint coverage.')",
          ],
          baseEnv,
        );
      } else {
        addLint("lint apps", ["lint:apps"]);
      }
    }
  }
  if (hasMacosAppCiPath(result.paths)) {
    add("macOS app CI tests", ["test:macos:ci"], baseEnv);
  }
  if (lanes.apps || lanes.core) {
    addCommand(
      "native state schema version guard",
      "node",
      ["scripts/check-native-state-schema-version.mjs"],
      baseEnv,
    );
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

  return finishPlan(
    Object.entries(lanes)
      .filter(([, enabled]) => enabled)
      .map(([lane]) => lane)
      .join(", "),
  );
}

export function createTargetedCoreLintCommand(
  paths: string[],
  env: NodeJS.ProcessEnv = process.env,
  options: TargetedLintOptions = {},
) {
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

export function createTargetedExtensionLintCommand(
  paths: string[],
  env: NodeJS.ProcessEnv = process.env,
  options: TargetedLintOptions = {},
) {
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

export function createTargetedScriptLintCommand(
  paths: string[],
  env: NodeJS.ProcessEnv = process.env,
  options: TargetedLintOptions = {},
) {
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
}: TargetedOxlintCommandOptions) {
  if (
    paths.some(
      (changedPath) =>
        !lintablePathRe.test(changedPath) &&
        !LINTABLE_CORE_PATH_RE.test(changedPath) &&
        !LINTABLE_EXTENSION_PATH_RE.test(changedPath) &&
        !LINTABLE_SCRIPT_PATH_RE.test(changedPath) &&
        !getChangedPathFacts(changedPath).isRootTestSource &&
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

async function runChangedCheck(result: ChangedLaneResult, options: ChangedCheckRunOptions = {}) {
  if (result.paths.length === 0) {
    console.error("[check:changed] no changed paths; nothing to run");
    return 0;
  }
  await ensureChangedCheckRuntimeDependencies(result.paths);
  const baseEnv = resolveLocalCheckEnv(options.env ?? process.env);
  const childEnv = createChangedCheckChildEnv(baseEnv);
  const plan = createChangedCheckPlan(result, {
    ...options,
    env: childEnv,
  });

  printPlan(result, plan, options);

  if (options.dryRun) {
    return 0;
  }

  const coreTestCheck = plan.commands.some((command) => command.coreTestCheck)
    ? (await import("./run-tsgo-core-test-shards.mts")).createChangedCoreTestCheck(
        result.paths.filter((file) => getChangedPathFacts(file).surface !== "docs"),
        createSparseTsgoSkipEnv(childEnv),
      )
    : undefined;
  const timings: ChangedCheckTiming[] = [];
  for (const command of plan.commands) {
    const status = await runPlanCommand(command, timings, coreTestCheck);
    if (status !== 0) {
      printSummary(timings, options);
      return status;
    }
  }

  printSummary(timings, options);
  return 0;
}

function sameArgs(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function printPlan(
  result: ChangedLaneResult,
  plan: ReturnType<typeof createChangedCheckPlan>,
  options: ChangedCheckRunOptions,
) {
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

async function runPnpm(command: ChangedCheckCommand, timings: ChangedCheckTiming[]) {
  return await runCommand(createPnpmManagedCommand(command), timings);
}

async function runPlanCommand(
  command: ChangedCheckCommand,
  timings: ChangedCheckTiming[],
  coreTestCheck?: ReturnType<typeof createChangedCoreTestCheck>,
) {
  if (command.coreTestCheck && coreTestCheck) {
    return await runCommand(
      createPnpmManagedCommand(command),
      timings,
      coreTestCheck[command.coreTestCheck],
    );
  }
  if (command.bin) {
    return await runCommand({ ...command, bin: command.bin }, timings);
  }
  return await runPnpm(command, timings);
}

function formatPlanCommand(command: ChangedCheckCommand) {
  const argv = command.bin ? [command.bin, ...command.args] : ["pnpm", ...command.args];
  return argv.map(formatShellToken).join(" ");
}

function formatShellToken(token: string) {
  return /^[A-Za-z0-9_./:@=-]+$/u.test(token) ? token : `'${token.replaceAll("'", "'\\''")}'`;
}

export function createPnpmManagedCommand<T extends ChangedCheckCommand>(
  command: T,
  env: NodeJS.ProcessEnv = process.env,
) {
  const commandEnv = command.env ?? resolveLocalCheckEnv(env);
  if (isOpenEndedTruthyValue(commandEnv.CI) || isOpenEndedTruthyValue(commandEnv.GITHUB_ACTIONS)) {
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

function prependCorepackPnpmShim(env: NodeJS.ProcessEnv) {
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

async function runCommand(
  command: ChangedCheckCommand & { bin: string },
  timings: ChangedCheckTiming[],
  run?: () => Promise<number>,
) {
  const startedAt = performance.now();
  console.error(`\n[check:changed] ${command.name}`);
  let status = 1;
  try {
    status = run
      ? await run()
      : await runManagedCommand({
          bin: command.bin,
          args: command.args,
          env: command.env ?? resolveLocalCheckEnv(),
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

function printSummary(timings: ChangedCheckTiming[], options: ChangedCheckRunOptions) {
  printTimingSummary("check:changed", timings, { skipWhenAllOk: !options.timed });
}

function parseArgs(argv: string[]) {
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
    paths: new Array<string>(),
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

async function main() {
  const argv = process.argv.slice(2);
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    printUsage();
    process.exitCode = 0;
  } else {
    let paths: string[] | undefined;
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
      // No local fallback here: this path exists because the checkout cannot
      // resolve the diff refs itself, so there is nothing local to run.
      const delegated = await runChangedCheckViaCrabbox(argv, process.env);
      if (delegated.backendUnavailable) {
        throw error;
      }
      process.exitCode = delegated.exitCode;
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
        const delegated = await runChangedCheckViaCrabbox(argv, process.env);
        if (delegated.backendUnavailable) {
          // Say this loudly: the proof below is local, so whoever reads the run
          // knows which machine produced it and that Linux-only lanes are unproven.
          console.error(
            "[check:changed] the remote backend never ran the checks (no run summary). Falling back to local execution; note this in the proof summary.",
          );
        }
        process.exitCode = delegated.backendUnavailable
          ? await runChangedCheck(result, {
              ...args,
              explicitPaths: args.paths.length > 0,
            })
          : delegated.exitCode;
      } else {
        process.exitCode = await runChangedCheck(result, {
          ...args,
          explicitPaths: args.paths.length > 0,
        });
      }
    }
  }
}

if (isDirectRun()) {
  await runWithFailedTrailer("check:changed", main);
}

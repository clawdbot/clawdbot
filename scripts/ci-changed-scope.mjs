// Determines CI scope from changed paths.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { getChangedPathFacts } from "./lib/changed-path-facts.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { resolveMergeHeadDiffBase } from "./lib/merge-head-diff-base.mjs";

/** @typedef {{ runNode: boolean; runMacos: boolean; runIosBuild: boolean; runAndroid: boolean; runWindows: boolean; runSkillsPython: boolean; runChangedSmoke: boolean; runControlUiI18n: boolean; runUiTests: boolean }} ChangedScope */
/** @typedef {{ runFastOnly: boolean; runPluginContracts: boolean; runCiRouting: boolean }} NodeFastScope */
/** @typedef {{ runFastInstallSmoke: boolean; runFullInstallSmoke: boolean }} InstallSmokeScope */

const CHANGED_PATHS_OUTPUT_MAX_BYTES = 64 * 1024;

const FULL_SCOPE = {
  runNode: true,
  runMacos: true,
  runIosBuild: true,
  runAndroid: true,
  runWindows: true,
  runSkillsPython: true,
  runChangedSmoke: true,
  runControlUiI18n: true,
  runUiTests: true,
};

const EMPTY_SCOPE = {
  runNode: false,
  runMacos: false,
  runIosBuild: false,
  runAndroid: false,
  runWindows: false,
  runSkillsPython: false,
  runChangedSmoke: false,
  runControlUiI18n: false,
  runUiTests: false,
};

const SKILLS_PYTHON_SCOPE_RE = /^(skills\/|skills\/pyproject\.toml$)/;
const INSTALL_SMOKE_WORKFLOW_SCOPE_RE = /^\.github\/workflows\/install-smoke\.yml$/;
const NATIVE_PROTOCOL_GEN_RE = /^apps\/shared\/OpenClawKit\/Sources\/OpenClawProtocol\//;
const APPLE_SWIFT_CONFIG_RE = /^config\/(?:swiftformat|swiftlint\.yml)$/;
const MACOS_NATIVE_RE =
  /^(apps\/macos\/|apps\/macos-mlx-tts\/|apps\/ios\/|apps\/shared\/|apps\/swabble\/|Swabble\/)/;
const MACOS_SCRIPT_SCOPE_RE =
  /^(?:scripts\/(?:check-swift-tools|codesign-mac-app|create-dmg|format-swift|install-swift-tools|install-xcodegen|lint-swift|notarize-mac-artifact|package-mac-app|package-mac-dist)\.sh|scripts\/lib\/(?:plistbuddy|swift-toolchain)\.sh|test\/scripts\/(?:codesign-mac-app|create-dmg|notarize-mac-artifact|package-mac-app|package-mac-dist)\.test\.ts)$/;
const IOS_BUILD_RE =
  /^(apps\/ios\/|apps\/shared\/|apps\/swabble\/|Swabble\/|scripts\/(?:check-swift-tools|format-swift|install-swift-tools|install-xcodegen|lint-swift)\.sh$|scripts\/(?:ios-(?:configure-signing|team-id|write-version-xcconfig)\.sh|ios-write-swift-filelist\.mjs|ios-version\.ts)$|scripts\/lib\/(?:ios-version\.ts|npm-publish-plan\.mjs|version-script-args\.ts)$)/;
const ANDROID_NATIVE_RE = /^(apps\/android\/|apps\/shared\/)/;
const NODE_SCOPE_RE =
  /^(src\/|test\/|extensions\/|packages\/|scripts\/|ui\/|\.github\/|openclaw\.mjs$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig.*\.json$|vitest.*\.ts$|tsdown\.config\.ts$|\.oxlintrc\.json$|\.oxfmtrc\.jsonc$)/;
const WINDOWS_SCOPE_RE =
  /^(src\/config\/sessions\/(?:session-accessor\.sqlite-archive|store\.session-lifecycle-mutation\.test)\.ts$|src\/process\/|src\/infra\/windows-install-roots\.ts$|src\/shared\/(?:import-specifier|runtime-import)(?:\.test)?\.ts$|scripts\/(?:install\.ps1|openclaw-cross-os-release-checks\.ts|github\/run-openclaw-cross-os-release-checks\.sh|(?:npm-runner|pnpm-runner|ui|vitest-process-group)\.(?:mjs|js)|lib\/(?:format-generated-module\.mjs|cross-os-release-checks\/[^/]+\.ts))$|test\/scripts\/(?:format-generated-module|install-ps1|npm-runner|openclaw-cross-os-release-workflow|pnpm-runner|ui|vitest-process-group)\.test\.ts$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|\.github\/workflows\/(?:ci|openclaw-cross-os-release-checks-reusable)\.yml$|\.github\/actions\/setup-node-env\/action\.yml$|\.github\/actions\/setup-pnpm-store-cache\/action\.yml$)/;
const WINDOWS_TEST_SCOPE_RE =
  /^(src\/config\/sessions\/store\.session-lifecycle-mutation\.test\.ts$|src\/process\/(?:exec\.windows|windows-command)\.test\.ts$|src\/infra\/windows-install-roots\.test\.ts$|src\/shared\/runtime-import\.test\.ts$|test\/scripts\/(?:format-generated-module|npm-runner|openclaw-cross-os-release-workflow|pnpm-runner|ui|vitest-process-group)\.test\.ts$)/;
const WINDOWS_DAEMON_SCOPE_RE =
  /^src\/daemon\/(?:schtasks(?:[-.][^/]+)?|runtime-hints\.windows-paths(?:\.test)?|test-helpers\/schtasks-(?:base-mocks|fixtures))\.ts$/;
const CONTROL_UI_I18N_SCOPE_RE =
  /^(ui\/src\/i18n\/|scripts\/(?:control-ui-i18n(?:-verify)?\.ts|lib\/control-ui-i18n-(?:config|raw-copy)\.ts)$|\.github\/workflows\/control-ui-locale-refresh\.yml$)/;
const CONTROL_UI_HARD_GENERATED_I18N_RE =
  /^(?:ui\/src\/i18n\/locales\/(?!en(?:-agents)?\.ts$)[^/]+\.ts|ui\/src\/i18n\/\.i18n\/(?:catalog-fallbacks\.json|[^/]+\.(?:meta\.json|tm\.jsonl)))$/;
const RELEASE_BRANCH_RE = /^release\/\d{4}\.\d+\.\d+$/;

export class ControlUiGeneratedArtifactsMixedError extends Error {}
export class NativeGeneratedArtifactsMixedError extends Error {}
const CONTROL_UI_TEST_SCOPE_RE =
  /^(ui\/|test\/vitest\/vitest\.shared\.config\.ts$|scripts\/ensure-playwright-chromium\.mjs$)/;
const NATIVE_I18N_SCOPE_RE =
  /^(?:apps\/\.i18n\/|apps\/android\/app\/src\/main\/|apps\/ios\/|apps\/macos\/Sources\/|apps\/shared\/OpenClawKit\/Sources\/|scripts\/(?:android-app-i18n|apple-app-i18n|native-app-i18n)\.ts$|test\/scripts\/(?:android-app-i18n|apple-app-i18n|native-app-i18n)\.test\.ts$|\.github\/workflows\/(?:ci|native-app-locale-refresh)\.yml$)/;
// Android base resources are co-owned: source PRs edit their English content,
// while the generator rewrites managed sections. Treat them as generated only
// alongside a hard-generated artifact so neither ownership path blocks the other.
const NATIVE_COOWNED_GENERATED_I18N_RE =
  /^apps\/android\/app\/src\/main\/res\/values\/(?:assistant|strings)\.xml$/;
const NATIVE_HARD_GENERATED_I18N_RE =
  /^(?:apps\/\.i18n\/native\/[^/]+\.json|apps\/\.i18n\/apple-translation-contradictions\.json|apps\/android\/app\/src\/main\/java\/ai\/openclaw\/app\/i18n\/NativeStringResources\.kt|apps\/android\/app\/src\/main\/res\/values-[^/]+\/(?:assistant|strings)\.xml|apps\/ios\/Resources\/Localizable\.xcstrings|apps\/ios\/(?:Sources|WatchApp|ShareExtension|ActivityWidget)\/[^/]+\.lproj\/InfoPlist\.strings)$/;
const FAST_INSTALL_SMOKE_SCOPE_RE =
  /^(Dockerfile$|\.npmrc$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|scripts\/ci-changed-scope\.mjs$|scripts\/postinstall-bundled-plugins\.mjs$|scripts\/e2e\/(?:Dockerfile(?:\.qr-import)?|agents-delete-shared-workspace-docker\.sh|gateway-network-docker\.sh)$|extensions\/[^/]+\/(?:package\.json|openclaw\.plugin\.json)$|\.github\/workflows\/install-smoke\.yml$|\.github\/actions\/setup-node-env\/action\.yml$)/;
const FULL_INSTALL_SMOKE_SCOPE_RE =
  /^(Dockerfile$|\.npmrc$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|scripts\/ci-changed-scope\.mjs$|scripts\/install(?:-cli)?\.sh$|scripts\/install\.ps1$|scripts\/test-install-sh-docker\.sh$|scripts\/docker\/|scripts\/e2e\/(?:Dockerfile(?:\.qr-import)?|qr-import-docker\.sh|bun-global-install-smoke\.sh)$|\.github\/workflows\/(?:install-smoke|website-installer-sync)\.yml$|\.github\/actions\/setup-node-env\/action\.yml$)/;
const FAST_INSTALL_SMOKE_RUNTIME_SCOPE_RE =
  /^(?:src\/(?:channels|gateway|plugin-sdk|plugins)\/|packages\/gateway-(?:client|protocol)\/src\/)/;
const NODE_FAST_PLUGIN_CONTRACT_SCOPE_RE =
  /^src\/plugins\/contracts\/(?:inventory\/bundled-capability-metadata|registry|tts-contract-suites)\.ts$/;
const NODE_FAST_CI_ROUTING_SCOPE_RE =
  /^(scripts\/(?:ci-changed-scope|check-changed|run-vitest|test-projects(?:\.test-support)?)\.mjs$|scripts\/(?:test-projects\.test-support|lib\/(?:changed-path-facts|ci-changed-node-test-plan))\.d\.mts$|scripts\/lib\/(?:changed-path-facts|ci-changed-node-test-plan)\.mjs$|src\/commands\/status\.scan-result\.test\.ts$|src\/scripts\/ci-changed-scope\.test\.ts$|test\/scripts\/(?:changed-lanes|changed-path-facts|ci-changed-node-test-plan|run-vitest|test-projects)\.test\.ts$)/;
const NODE_FAST_SCOPE_RE = new RegExp(
  `${NODE_FAST_PLUGIN_CONTRACT_SCOPE_RE.source}|${NODE_FAST_CI_ROUTING_SCOPE_RE.source}`,
);

/**
 * @param {string[]} changedPaths
 * @returns {ChangedScope}
 */
/**
 * Detects high-level CI scope from changed file paths.
 */
export function detectChangedScope(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return { ...FULL_SCOPE };
  }

  let runNode = false;
  let runMacos = false;
  let runIosBuild = false;
  let runAndroid = false;
  let runWindows = false;
  let runSkillsPython = false;
  let runChangedSmoke = false;
  let runControlUiI18n = false;
  let runUiTests = false;
  let hasNonDocs = false;
  let hasNonNativeNonDocs = false;

  for (const rawPath of changedPaths) {
    const facts = getChangedPathFacts(rawPath);
    const { path } = facts;
    if (!path) {
      continue;
    }

    const isAppleSwiftConfig = APPLE_SWIFT_CONFIG_RE.test(path);

    if (facts.surface === "docs") {
      continue;
    }

    hasNonDocs = true;

    if (SKILLS_PYTHON_SCOPE_RE.test(path)) {
      runSkillsPython = true;
    }

    if (INSTALL_SMOKE_WORKFLOW_SCOPE_RE.test(path)) {
      runChangedSmoke = true;
    }

    if (
      !NATIVE_PROTOCOL_GEN_RE.test(path) &&
      (MACOS_NATIVE_RE.test(path) || MACOS_SCRIPT_SCOPE_RE.test(path) || isAppleSwiftConfig)
    ) {
      runMacos = true;
    }

    if (IOS_BUILD_RE.test(path) || isAppleSwiftConfig) {
      runIosBuild = true;
    }

    if (!NATIVE_PROTOCOL_GEN_RE.test(path) && ANDROID_NATIVE_RE.test(path)) {
      runAndroid = true;
    }

    if (NODE_SCOPE_RE.test(path)) {
      runNode = true;
    }

    if (
      (WINDOWS_SCOPE_RE.test(path) || WINDOWS_DAEMON_SCOPE_RE.test(path)) &&
      (!facts.isTestOnly || WINDOWS_TEST_SCOPE_RE.test(path) || WINDOWS_DAEMON_SCOPE_RE.test(path))
    ) {
      runWindows = true;
    }

    if (detectInstallSmokeScopeForPath(path).runFastInstallSmoke) {
      runChangedSmoke = true;
    }

    if (CONTROL_UI_I18N_SCOPE_RE.test(path)) {
      runControlUiI18n = true;
    }

    if (CONTROL_UI_TEST_SCOPE_RE.test(path)) {
      runUiTests = true;
    }

    if (!facts.isNativeOnly) {
      hasNonNativeNonDocs = true;
    }
  }

  if (!runNode && hasNonDocs && hasNonNativeNonDocs) {
    runNode = true;
  }

  return {
    runNode,
    runMacos,
    runIosBuild,
    runAndroid,
    runWindows,
    runSkillsPython,
    runChangedSmoke,
    runControlUiI18n,
    runUiTests,
  };
}

/**
 * Generated Control UI locale snapshots belong in their isolated automation PR.
 * Mixing them into a source PR recreates deterministic rebase conflicts.
 * @param {string[]} changedPaths
 */
export function assertControlUiGeneratedArtifactsIsolated(changedPaths, branchName = "") {
  if (branchName === "main" || RELEASE_BRANCH_RE.test(branchName)) {
    return;
  }
  const generatedPaths = changedPaths.filter((filePath) =>
    CONTROL_UI_HARD_GENERATED_I18N_RE.test(filePath),
  );
  if (generatedPaths.length === 0) {
    return;
  }
  const sourcePaths = changedPaths.filter(
    (filePath) => !CONTROL_UI_HARD_GENERATED_I18N_RE.test(filePath),
  );
  if (sourcePaths.length === 0) {
    return;
  }
  throw new ControlUiGeneratedArtifactsMixedError(
    [
      "Control UI generated locale artifacts must be isolated from source changes.",
      "Commit English/source changes only; the locale refresh workflow owns generated bundles and metadata.",
      ...generatedPaths.map((filePath) => `- generated: ${filePath}`),
      ...sourcePaths.map((filePath) => `- source: ${filePath}`),
    ].join("\n"),
  );
}

export function shouldStrictControlUiI18n(changedPaths) {
  return (
    changedPaths === null ||
    changedPaths.some((filePath) => CONTROL_UI_HARD_GENERATED_I18N_RE.test(filePath))
  );
}

/**
 * Native translations and platform resources are committed by one serialized
 * automation PR. Source PRs own only source plus the stable-ID inventory.
 * @param {string[]} changedPaths
 */
export function assertNativeGeneratedArtifactsIsolated(changedPaths, branchName = "") {
  if (branchName === "main" || RELEASE_BRANCH_RE.test(branchName)) {
    return;
  }
  const generatedPaths = changedPaths.filter((filePath) =>
    NATIVE_HARD_GENERATED_I18N_RE.test(filePath),
  );
  if (generatedPaths.length === 0) {
    return;
  }
  const generatedCompanionPaths = changedPaths.filter((filePath) =>
    NATIVE_COOWNED_GENERATED_I18N_RE.test(filePath),
  );
  const sourcePaths = changedPaths.filter(
    (filePath) =>
      !NATIVE_HARD_GENERATED_I18N_RE.test(filePath) &&
      !NATIVE_COOWNED_GENERATED_I18N_RE.test(filePath),
  );
  if (sourcePaths.length === 0) {
    return;
  }
  throw new NativeGeneratedArtifactsMixedError(
    [
      "Native generated locale artifacts must be isolated from source changes.",
      "Commit native source changes and apps/.i18n/native-source.json only; the native locale refresh workflow owns translated and platform-generated artifacts.",
      ...generatedPaths.map((filePath) => `- generated: ${filePath}`),
      ...generatedCompanionPaths.map((filePath) => `- generated companion: ${filePath}`),
      ...sourcePaths.map((filePath) => `- source: ${filePath}`),
    ].join("\n"),
  );
}

export function shouldStrictNativeI18n(changedPaths) {
  return (
    changedPaths === null ||
    changedPaths.some((filePath) => NATIVE_HARD_GENERATED_I18N_RE.test(filePath))
  );
}

function resolveChangedBranchName() {
  const githubBranch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME;
  if (githubBranch) {
    return githubBranch;
  }
  try {
    return execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export function resolveAllowedGeneratedMixBranch(
  env = process.env,
  branchName = resolveChangedBranchName(),
) {
  if (env.GITHUB_ACTIONS === "true" && env.OPENCLAW_ALLOW_RELEASE_GENERATED_MIX !== "true") {
    return "";
  }
  if (RELEASE_BRANCH_RE.test(branchName)) {
    return branchName;
  }
  if (
    env.GITHUB_ACTIONS === "true" &&
    env.GITHUB_EVENT_NAME === "push" &&
    env.GITHUB_REF === "refs/heads/main" &&
    branchName === "main"
  ) {
    return branchName;
  }
  return "";
}

export function shouldRunNativeI18n(changedPaths) {
  return (
    !Array.isArray(changedPaths) ||
    changedPaths.length === 0 ||
    changedPaths.some((path) => NATIVE_I18N_SCOPE_RE.test(path.trim()))
  );
}

/**
 * @param {string[]} changedPaths
 * @returns {NodeFastScope}
 */
/**
 * Detects whether node-fast CI can cover the changed paths.
 */
export function detectNodeFastScope(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return { runFastOnly: false, runPluginContracts: false, runCiRouting: false };
  }

  let hasNonDocs = false;
  let runPluginContracts = false;
  let runCiRouting = false;

  for (const rawPath of changedPaths) {
    const facts = getChangedPathFacts(rawPath);
    const { path } = facts;
    if (!path || facts.surface === "docs") {
      continue;
    }

    hasNonDocs = true;
    runPluginContracts ||= NODE_FAST_PLUGIN_CONTRACT_SCOPE_RE.test(path);
    runCiRouting ||= NODE_FAST_CI_ROUTING_SCOPE_RE.test(path);

    if (!NODE_FAST_SCOPE_RE.test(path)) {
      return { runFastOnly: false, runPluginContracts: false, runCiRouting: false };
    }
  }

  const runFastOnly = hasNonDocs && (runPluginContracts || runCiRouting);
  return {
    runFastOnly,
    runPluginContracts: runFastOnly && runPluginContracts,
    runCiRouting: runFastOnly && runCiRouting,
  };
}

/**
 * @param {string} path
 * @returns {InstallSmokeScope}
 */
function detectInstallSmokeScopeForPath(path) {
  const facts = getChangedPathFacts(path);
  const runFullInstallSmoke = FULL_INSTALL_SMOKE_SCOPE_RE.test(path);
  const runFastInstallSmoke =
    runFullInstallSmoke ||
    FAST_INSTALL_SMOKE_SCOPE_RE.test(path) ||
    (FAST_INSTALL_SMOKE_RUNTIME_SCOPE_RE.test(path) && !facts.isTestOnly);
  return { runFastInstallSmoke, runFullInstallSmoke };
}

/**
 * @param {string[]} changedPaths
 * @returns {InstallSmokeScope}
 */
/**
 * Detects whether install-smoke CI should run for changed paths.
 */
export function detectInstallSmokeScope(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return { runFastInstallSmoke: true, runFullInstallSmoke: true };
  }

  let runFastInstallSmoke = false;
  let runFullInstallSmoke = false;
  for (const rawPath of changedPaths) {
    const facts = getChangedPathFacts(rawPath);
    const { path } = facts;
    if (!path || facts.surface === "docs") {
      continue;
    }
    const pathScope = detectInstallSmokeScopeForPath(path);
    runFastInstallSmoke ||= pathScope.runFastInstallSmoke;
    runFullInstallSmoke ||= pathScope.runFullInstallSmoke;
  }
  return { runFastInstallSmoke, runFullInstallSmoke };
}

/**
 * @param {string} base
 * @param {string} [head]
 * @param {string} [cwd]
 * @returns {string[]}
 */
/**
 * Lists changed paths for CI base/head inputs.
 */
export function listChangedPaths(
  base,
  head = "HEAD",
  cwd = process.cwd(),
  preferMergeHeadFirstParent = false,
) {
  if (!base) {
    return [];
  }
  const diffBase = resolveMergeHeadDiffBase({
    base,
    head,
    cwd,
    preferFirstParent: preferMergeHeadFirstParent,
  });
  const output = execFileSync("git", ["diff", "--no-renames", "--name-only", diffBase, head], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * @param {ChangedScope} scope
 * @param {string} [outputPath]
 * @param {InstallSmokeScope} [installSmokeScope]
 */
/**
 * Writes CI scope decisions to GitHub Actions output.
 */
export function writeGitHubOutput(
  scope,
  outputPath = process.env.GITHUB_OUTPUT,
  installSmokeScope = {
    runFastInstallSmoke: scope.runChangedSmoke,
    runFullInstallSmoke: scope.runChangedSmoke,
  },
  nodeFastScope = { runFastOnly: false, runPluginContracts: false, runCiRouting: false },
  runNativeI18n = true,
  changedPaths = null,
) {
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required");
  }
  appendFileSync(outputPath, `run_node=${scope.runNode}\n`, "utf8");
  appendFileSync(outputPath, `run_macos=${scope.runMacos}\n`, "utf8");
  appendFileSync(outputPath, `run_ios_build=${scope.runIosBuild}\n`, "utf8");
  appendFileSync(outputPath, `run_android=${scope.runAndroid}\n`, "utf8");
  appendFileSync(outputPath, `run_windows=${scope.runWindows}\n`, "utf8");
  appendFileSync(outputPath, `run_skills_python=${scope.runSkillsPython}\n`, "utf8");
  appendFileSync(outputPath, `run_changed_smoke=${scope.runChangedSmoke}\n`, "utf8");
  appendFileSync(outputPath, `run_node_fast_only=${nodeFastScope.runFastOnly}\n`, "utf8");
  appendFileSync(
    outputPath,
    `run_node_fast_plugin_contracts=${nodeFastScope.runPluginContracts}\n`,
    "utf8",
  );
  appendFileSync(outputPath, `run_node_fast_ci_routing=${nodeFastScope.runCiRouting}\n`, "utf8");
  appendFileSync(
    outputPath,
    `run_fast_install_smoke=${installSmokeScope.runFastInstallSmoke}\n`,
    "utf8",
  );
  appendFileSync(
    outputPath,
    `run_full_install_smoke=${installSmokeScope.runFullInstallSmoke}\n`,
    "utf8",
  );
  appendFileSync(outputPath, `run_control_ui_i18n=${scope.runControlUiI18n}\n`, "utf8");
  appendFileSync(
    outputPath,
    `strict_control_ui_i18n=${shouldStrictControlUiI18n(changedPaths)}\n`,
    "utf8",
  );
  appendFileSync(outputPath, `run_ui_tests=${scope.runUiTests}\n`, "utf8");
  appendFileSync(outputPath, `run_native_i18n=${runNativeI18n}\n`, "utf8");
  appendFileSync(
    outputPath,
    `strict_native_i18n=${shouldStrictNativeI18n(changedPaths)}\n`,
    "utf8",
  );
  const changedPathsJson = JSON.stringify(changedPaths);
  appendFileSync(
    outputPath,
    `changed_paths_json=${Buffer.byteLength(changedPathsJson, "utf8") <= CHANGED_PATHS_OUTPUT_MAX_BYTES ? changedPathsJson : "null"}\n`,
    "utf8",
  );
}

function isDirectRun() {
  return isDirectRunUrl(process.argv[1], import.meta.url);
}

/** @param {string[]} argv */
function readRefValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const args = { base: "", head: "HEAD", mergeHeadFirstParent: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base") {
      args.base = readRefValue(argv, i, "--base");
      i += 1;
      continue;
    }
    if (argv[i] === "--head") {
      args.head = readRefValue(argv, i, "--head");
      i += 1;
      continue;
    }
    if (argv[i] === "--merge-head-first-parent") {
      args.mergeHeadFirstParent = true;
    }
  }
  return args;
}

if (isDirectRun()) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const changedPaths = listChangedPaths(
      args.base,
      args.head,
      process.cwd(),
      args.mergeHeadFirstParent,
    );
    if (changedPaths.length === 0) {
      writeGitHubOutput(EMPTY_SCOPE, process.env.GITHUB_OUTPUT, undefined, undefined, false, []);
      process.exit(0);
    }
    const allowedGeneratedMixBranch = resolveAllowedGeneratedMixBranch();
    assertControlUiGeneratedArtifactsIsolated(changedPaths, allowedGeneratedMixBranch);
    assertNativeGeneratedArtifactsIsolated(changedPaths, allowedGeneratedMixBranch);
    writeGitHubOutput(
      detectChangedScope(changedPaths),
      process.env.GITHUB_OUTPUT,
      detectInstallSmokeScope(changedPaths),
      detectNodeFastScope(changedPaths),
      shouldRunNativeI18n(changedPaths),
      changedPaths,
    );
  } catch (error) {
    if (
      error instanceof ControlUiGeneratedArtifactsMixedError ||
      error instanceof NativeGeneratedArtifactsMixedError
    ) {
      console.error(error.message);
      process.exitCode = 1;
    } else {
      writeGitHubOutput(FULL_SCOPE, process.env.GITHUB_OUTPUT, undefined, undefined, true, null);
    }
  }
}

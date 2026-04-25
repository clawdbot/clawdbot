import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

/** @typedef {{ runNode: boolean; runMacos: boolean; runAndroid: boolean; runWindows: boolean; runSkillsPython: boolean; runChangedSmoke: boolean; runControlUiI18n: boolean }} ChangedScope */
/** @typedef {{ runFastOnly: boolean; runPluginContracts: boolean; runCiRouting: boolean }} NodeFastScope */
/** @typedef {{ runFastInstallSmoke: boolean; runFullInstallSmoke: boolean }} InstallSmokeScope */

const FULL_SCOPE = {
  runNode: true,
  runMacos: true,
  runAndroid: true,
  runWindows: true,
  runSkillsPython: true,
  runChangedSmoke: true,
  runControlUiI18n: true,
};

const EMPTY_SCOPE = {
  runNode: false,
  runMacos: false,
  runAndroid: false,
  runWindows: false,
  runSkillsPython: false,
  runChangedSmoke: false,
  runControlUiI18n: false,
};

const DOCS_PATH_RE = /^(docs\/|.*\.mdx?$)/;
const SKILLS_PYTHON_SCOPE_RE = /^(skills\/|pyproject\.toml$)/;
const INSTALL_SMOKE_WORKFLOW_SCOPE_RE = /^\.github\/workflows\/install-smoke\.yml$/;
const MACOS_PROTOCOL_GEN_RE =
  /^(apps\/macos\/Sources\/OpenClawProtocol\/|apps\/shared\/OpenClawKit\/Sources\/OpenClawProtocol\/)/;
const MACOS_NATIVE_RE =
  /^(apps\/macos\/|apps\/macos-mlx-tts\/|apps\/ios\/|apps\/shared\/|Swabble\/)/;
const ANDROID_NATIVE_RE = /^(apps\/android\/|apps\/shared\/)/;
const NODE_SCOPE_RE =
  /^(src\/|test\/|extensions\/|packages\/|scripts\/|ui\/|\.github\/|openclaw\.mjs$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig.*\.json$|vitest.*\.ts$|tsdown\.config\.ts$|\.oxlintrc\.json$|\.oxfmtrc\.jsonc$)/;
const WINDOWS_SCOPE_RE =
  /^(src\/process\/|src\/infra\/windows-install-roots\.ts$|scripts\/(?:npm-runner|pnpm-runner|ui|vitest-process-group)\.(?:mjs|js)$|test\/scripts\/(?:npm-runner|pnpm-runner|ui|vitest-process-group)\.test\.ts$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|\.github\/workflows\/ci\.yml$|\.github\/actions\/setup-node-env\/action\.yml$|\.github\/actions\/setup-pnpm-store-cache\/action\.yml$)/;
const WINDOWS_TEST_SCOPE_RE =
  /^(src\/process\/(?:exec\.windows|windows-command)\.test\.ts$|src\/infra\/windows-install-roots\.test\.ts$|test\/scripts\/(?:npm-runner|pnpm-runner|ui|vitest-process-group)\.test\.ts$)/;
const TEST_ONLY_PATH_RE =
  /(^test\/|\/test\/|\/tests\/|(?:^|\/)[^/]+\.(?:test|spec|test-utils|test-support|test-harness|e2e-harness)\.[cm]?[jt]sx?$)/;
const CONTROL_UI_I18N_SCOPE_RE =
  /^(ui\/src\/i18n\/|scripts\/control-ui-i18n\.ts$|\.github\/workflows\/control-ui-locale-refresh\.yml$)/;
const NATIVE_ONLY_RE =
  /^(apps\/android\/|apps\/ios\/|apps\/macos\/|apps\/macos-mlx-tts\/|apps\/shared\/|Swabble\/|appcast\.xml$)/;
const FAST_INSTALL_SMOKE_SCOPE_RE =
  /^(Dockerfile$|\.npmrc$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|scripts\/ci-changed-scope\.mjs$|scripts\/postinstall-bundled-plugins\.mjs$|scripts\/e2e\/(?:Dockerfile(?:\.qr-import)?|agents-delete-shared-workspace-docker\.sh|gateway-network-docker\.sh|bundled-channel-runtime-deps-docker\.sh)$|src\/plugins\/bundled-runtime-deps\.ts$|extensions\/[^/]+\/(?:package\.json|openclaw\.plugin\.json)$|\.github\/workflows\/install-smoke\.yml$|\.github\/actions\/setup-node-env\/action\.yml$)/;
const FULL_INSTALL_SMOKE_SCOPE_RE =
  /^(Dockerfile$|\.npmrc$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|scripts\/ci-changed-scope\.mjs$|scripts\/install\.sh$|scripts\/test-install-sh-docker\.sh$|scripts\/docker\/|scripts\/e2e\/(?:Dockerfile(?:\.qr-import)?|qr-import-docker\.sh|bun-global-install-smoke\.sh)$|\.github\/workflows\/install-smoke\.yml$|\.github\/actions\/setup-node-env\/action\.yml$)/;
const FAST_INSTALL_SMOKE_RUNTIME_SCOPE_RE = /^src\/(?:channels|gateway|plugin-sdk|plugins)\//;
const NODE_FAST_PLUGIN_CONTRACT_SCOPE_RE =
  /^(src\/plugins\/contracts\/(?:inventory\/bundled-capability-metadata|registry)\.ts$|test\/helpers\/plugins\/tts-contract-suites\.ts$|scripts\/test-projects(?:\.test-support)?\.mjs$|test\/scripts\/test-projects\.test\.ts$)/;
const NODE_FAST_CI_ROUTING_SCOPE_RE =
  /^(scripts\/ci-changed-scope\.mjs$|src\/commands\/status\.scan-result\.test\.ts$|src\/scripts\/ci-changed-scope\.test\.ts$|\.github\/workflows\/ci\.yml$)/;
const NODE_FAST_SCOPE_RE = new RegExp(
  `${NODE_FAST_PLUGIN_CONTRACT_SCOPE_RE.source}|${NODE_FAST_CI_ROUTING_SCOPE_RE.source}`,
);

/**
 * @param {string[]} changedPaths
 * @returns {ChangedScope}
 */
export function detectChangedScope(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return {
      runNode: true,
      runMacos: true,
      runAndroid: true,
      runWindows: true,
      runSkillsPython: true,
      runChangedSmoke: true,
      runControlUiI18n: true,
    };
  }

  let runNode = false;
  let runMacos = false;
  let runAndroid = false;
  let runWindows = false;
  let runSkillsPython = false;
  let runChangedSmoke = false;
  let runControlUiI18n = false;
  let hasNonDocs = false;
  let hasNonNativeNonDocs = false;

  for (const rawPath of changedPaths) {
    const path = rawPath.trim();
    if (!path) {
      continue;
    }

    if (DOCS_PATH_RE.test(path)) {
      continue;
    }

    hasNonDocs = true;

    if (SKILLS_PYTHON_SCOPE_RE.test(path)) {
      runSkillsPython = true;
    }

    if (INSTALL_SMOKE_WORKFLOW_SCOPE_RE.test(path)) {
      runChangedSmoke = true;
    }

    if (!MACOS_PROTOCOL_GEN_RE.test(path) && MACOS_NATIVE_RE.test(path)) {
      runMacos = true;
    }

    if (ANDROID_NATIVE_RE.test(path)) {
      runAndroid = true;
    }

    if (NODE_SCOPE_RE.test(path)) {
      runNode = true;
    }

    if (
      WINDOWS_SCOPE_RE.test(path) &&
      (!TEST_ONLY_PATH_RE.test(path) || WINDOWS_TEST_SCOPE_RE.test(path))
    ) {
      runWindows = true;
    }

    if (detectInstallSmokeScopeForPath(path).runFastInstallSmoke) {
      runChangedSmoke = true;
    }

    if (CONTROL_UI_I18N_SCOPE_RE.test(path)) {
      runControlUiI18n = true;
    }

    if (!NATIVE_ONLY_RE.test(path)) {
      hasNonNativeNonDocs = true;
    }
  }

  if (!runNode && hasNonDocs && hasNonNativeNonDocs) {
    runNode = true;
  }

  return {
    runNode,
    runMacos,
    runAndroid,
    runWindows,
    runSkillsPython,
    runChangedSmoke,
    runControlUiI18n,
  };
}

/**
 * @param {string[]} changedPaths
 * @returns {NodeFastScope}
 */
export function detectNodeFastScope(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return { runFastOnly: false, runPluginContracts: false, runCiRouting: false };
  }

  let hasNonDocs = false;
  let runPluginContracts = false;
  let runCiRouting = false;

  for (const rawPath of changedPaths) {
    const path = rawPath.trim();
    if (!path || DOCS_PATH_RE.test(path)) {
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
  const runFullInstallSmoke = FULL_INSTALL_SMOKE_SCOPE_RE.test(path);
  const runFastInstallSmoke =
    runFullInstallSmoke ||
    FAST_INSTALL_SMOKE_SCOPE_RE.test(path) ||
    (FAST_INSTALL_SMOKE_RUNTIME_SCOPE_RE.test(path) && !TEST_ONLY_PATH_RE.test(path));
  return { runFastInstallSmoke, runFullInstallSmoke };
}

/**
 * @param {string[]} changedPaths
 * @returns {InstallSmokeScope}
 */
export function detectInstallSmokeScope(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return { runFastInstallSmoke: true, runFullInstallSmoke: true };
  }

  let runFastInstallSmoke = false;
  let runFullInstallSmoke = false;
  for (const rawPath of changedPaths) {
    const path = rawPath.trim();
    if (!path || DOCS_PATH_RE.test(path)) {
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
 * @returns {string[]}
 */
export function listChangedPaths(base, head = "HEAD") {
  if (!base) {
    return [];
  }
  const output = execFileSync("git", ["diff", "--name-only", base, head], {
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
export function writeGitHubOutput(
  scope,
  outputPath = process.env.GITHUB_OUTPUT,
  installSmokeScope = {
    runFastInstallSmoke: scope.runChangedSmoke,
    runFullInstallSmoke: scope.runChangedSmoke,
  },
  nodeFastScope = { runFastOnly: false, runPluginContracts: false, runCiRouting: false },
) {
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required");
  }
  appendFileSync(outputPath, `run_node=${scope.runNode}\n`, "utf8");
  appendFileSync(outputPath, `run_macos=${scope.runMacos}\n`, "utf8");
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
}

function isDirectRun() {
  const direct = process.argv[1];
  return Boolean(direct && import.meta.url.endsWith(direct));
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = { base: "", head: "HEAD" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base") {
      args.base = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (argv[i] === "--head") {
      args.head = argv[i + 1] ?? "HEAD";
      i += 1;
    }
  }
  return args;
}

if (isDirectRun()) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const changedPaths = listChangedPaths(args.base, args.head);
    if (changedPaths.length === 0) {
      writeGitHubOutput(EMPTY_SCOPE);
      process.exit(0);
    }
    writeGitHubOutput(
      detectChangedScope(changedPaths),
      process.env.GITHUB_OUTPUT,
      detectInstallSmokeScope(changedPaths),
      detectNodeFastScope(changedPaths),
    );
  } catch {
    writeGitHubOutput(FULL_SCOPE);
  }
}

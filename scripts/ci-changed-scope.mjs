import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

/** @typedef {{ runNode: boolean; runMacos: boolean; runAndroid: boolean; runWindows: boolean; runSkillsPython: boolean; runChangedSmoke: boolean; runControlUiI18n: boolean }} ChangedScope */

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
const CHANGED_SMOKE_SCOPE_RE =
  /^(Dockerfile$|\.npmrc$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|scripts\/ci-changed-scope\.mjs$|scripts\/install\.sh$|scripts\/postinstall-bundled-plugins\.mjs$|scripts\/test-install-sh-docker\.sh$|scripts\/docker\/|scripts\/e2e\/(?:Dockerfile(?:\.qr-import)?|.*\.sh)$|src\/plugins\/bundled-runtime-deps\.ts$|extensions\/[^/]+\/package\.json$|\.github\/workflows\/install-smoke\.yml$|\.github\/actions\/setup-node-env\/action\.yml$)/;
const CHANGED_SMOKE_RUNTIME_SCOPE_RE =
  /^(src\/(?:channels|gateway|plugin-sdk|plugins)\/|extensions\/)/;

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

    if (
      CHANGED_SMOKE_SCOPE_RE.test(path) ||
      (CHANGED_SMOKE_RUNTIME_SCOPE_RE.test(path) && !TEST_ONLY_PATH_RE.test(path))
    ) {
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
 */
export function writeGitHubOutput(scope, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required");
  }
  appendFileSync(outputPath, `run_node=${scope.runNode}\n`, "utf8");
  appendFileSync(outputPath, `run_macos=${scope.runMacos}\n`, "utf8");
  appendFileSync(outputPath, `run_android=${scope.runAndroid}\n`, "utf8");
  appendFileSync(outputPath, `run_windows=${scope.runWindows}\n`, "utf8");
  appendFileSync(outputPath, `run_skills_python=${scope.runSkillsPython}\n`, "utf8");
  appendFileSync(outputPath, `run_changed_smoke=${scope.runChangedSmoke}\n`, "utf8");
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
    writeGitHubOutput(detectChangedScope(changedPaths));
  } catch {
    writeGitHubOutput(FULL_SCOPE);
  }
}

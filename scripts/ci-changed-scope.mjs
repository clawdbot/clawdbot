// Determines CI scope from changed paths.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { requireOptionArgument } from "./lib/arg-utils.runtime.mjs";
import { getChangedPathFacts } from "./lib/changed-path-facts.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { resolveMergeHeadDiffBase } from "./lib/merge-head-diff-base.mjs";

/** @typedef {{ runNode: boolean; runMacos: boolean; runMacosNode: boolean; runIosBuild: boolean; runAndroid: boolean; runWindows: boolean; runSkillsPython: boolean; runChangedSmoke: boolean; runControlUiI18n: boolean; runUiTests: boolean }} ChangedScope */
/** @typedef {{ runFastOnly: boolean; runPluginContracts: boolean; runCiRouting: boolean }} NodeFastScope */
/** @typedef {{ runFastInstallSmoke: boolean; runFullInstallSmoke: boolean }} InstallSmokeScope */

const CHANGED_PATHS_OUTPUT_MAX_BYTES = 64 * 1024;

/** @type {ChangedScope} */
const FULL_SCOPE = {
  runNode: true,
  runMacos: true,
  runMacosNode: true,
  runIosBuild: true,
  runAndroid: true,
  runWindows: true,
  runSkillsPython: true,
  runChangedSmoke: true,
  runControlUiI18n: true,
  runUiTests: true,
};

/** @type {ChangedScope} */
const EMPTY_SCOPE = {
  runNode: false,
  runMacos: false,
  runMacosNode: false,
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
const APPLE_SHARED_CONTRACT_FIXTURE_RE =
  /^test\/fixtures\/(?:device-identity-coordinator|talk-config)-contract\.json$/;
const MACOS_NATIVE_RE =
  /^(apps\/macos\/|apps\/macos-mlx-tts\/|apps\/shared\/|apps\/swabble\/|Swabble\/)/;
const GIT_OWNER_SCOPE_RE =
  /^(?:\.github\/(?:actions\/(?:git-owner|ensure-base-commit|publish-generated-pr|mantis-validate-trusted-ref)\/|workflows\/(?:workflow-sanity|qa-profile-evidence|maturity-scorecard|docs-agent|docs-sync-publish|openclaw-performance|linux-app-release|macos-release|npm-placeholder-bootstrap|plugin-clawhub-release|plugin-npm-release|mantis-(?:discord-(?:smoke|status-reactions|thread-attachment)|slack-desktop-smoke|web-ui-chat-proof))\.yml$)|scripts\/generate-ci-git-owner\.mts$|test\/scripts\/(?:ci-(?:checkout|git-owner|linux-git|platform-checkout)\.test(?:-support)?\.ts|generated-publisher\.test-support\.ts|openclaw-performance-(?:workflow\.test(?:-support)?|git-lifecycle\.test)\.ts|plugin-release-git-lifecycle\.test\.ts|release-workflow-git-lifecycle\.test\.ts|fixtures\/(?:ci-platform-checkout\.mjs|ci-windows-process-census\.py))$)/;
const MACOS_SCRIPT_SCOPE_RE =
  /^(?:scripts\/(?:build-and-run-mac|check-swift-tools|codesign-mac-app|create-dmg|format-swift|install-swift-tools|install-xcodegen|lint-swift|mac-elevation-host|notarize-mac-artifact|package-mac-app|package-mac-dist|prepush-ci|restart-mac|stage-cua-driver-macos|stage-mac-node-worker)\.sh|scripts\/test-macos-native\.mts|scripts\/(?:verify-mac-node-worker(?:-fs)?|lib\/(?:mac-node-worker-proof-state|mac-worker-portability))\.mjs|scripts\/(?:materialize-mac-node-worker|swift-build-cache-metadata|lib\/(?:mac-native-inventory|mac-bundle-mutation))\.py|scripts\/lib\/(?:mac-app-bundle|plistbuddy|swift-toolchain)\.sh|test\/helpers\/mac-(?:native|signing)\.ts|test\/scripts\/(?:codesign-mac-app|create-dmg|mac-elevation-artifact|mac-elevation-host|mac-node-worker|macos-native-test-launch|notarize-mac-artifact|package-mac-app|package-mac-dist|restart-mac|swift-build-cache-metadata|verify-mac-node-worker-fs)\.test\.ts|test\/scripts\/(?:mac-elevation-artifact|mac-native-fixtures|mac-node-worker-materialization)\.test-support\.ts)$/;
const WORKER_DEPLOY_ARTIFACT_SCOPE_RE =
  /^src\/(?:agents\/github-exec-(?:launcher|credential)\.ts|shared\/worker-bundle-hash\.ts|worker\/workspace-rsync-receiver\.ts|gateway\/worker-environments\/workspace-(?:accepted-(?:remote-script|sync)|mutation-remote-script|rsync-path\.test|sync(?:-helpers)?)\.ts)$/;
const IOS_BUILD_RE =
  /^(apps\/ios\/|apps\/shared\/|apps\/swabble\/|Swabble\/|scripts\/(?:check-swift-tools|format-swift|install-swift-tools|install-xcodegen|lint-swift)\.sh$|scripts\/(?:ios-(?:configure-signing|screenshots|team-id|write-version-xcconfig)\.sh|ios-screenshot-evidence\.(?:mjs|d\.mts)|ios-write-swift-filelist\.m[jt]s|ios-version\.ts)$|scripts\/lib\/(?:ios-fastlane\.sh|ios-version\.ts|release-version\.mjs|version-script-args\.ts)$)/;
const IOS_SCREENSHOT_APP_SCOPE_RE =
  /^(?:apps\/ios\/|apps\/shared\/OpenClawKit\/|apps\/swabble\/|Swabble\/)/;
const IOS_SCREENSHOT_SCRIPT_SCOPE_RE =
  /^scripts\/(?:check-swift-tools|format-swift|install-swift-tools|install-xcodegen|lint-swift)\.sh$|^scripts\/(?:ios-(?:configure-signing|screenshots|team-id|write-version-xcconfig)\.sh|ios-screenshot-evidence\.(?:mjs|d\.mts)|ios-write-swift-filelist\.m[jt]s|ios-version\.ts)$|^scripts\/lib\/(?:ios-fastlane\.sh|ios-version\.ts|release-version\.mjs|version-script-args\.ts)$/;
const ANDROID_NATIVE_RE = /^(apps\/android\/|apps\/shared\/)/;
// Native bundling reads the root aliases and this shared coercion dependency.
const MERMAID_ASSET_INPUT_RE =
  /^(?:packages\/(?:mermaid-renderer\/|normalization-core\/(?:package\.json|src\/record-coerce\.ts)$)|tsconfig\.json$)/;
const NODE_SCOPE_RE =
  /^(src\/|test\/|extensions\/|packages\/|scripts\/|ui\/|\.github\/|openclaw\.mjs$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig.*\.json$|vitest.*\.ts$|tsdown\.config\.ts$|\.oxlintrc\.json$|\.oxfmtrc\.jsonc$)/;
const WINDOWS_SQLITE_SCOPE_RE = /^src\/(?:state\/|.*sqlite.*\.ts$)/;
// Windows process-start identity: the owner, the Windows probe it falls back to,
// and every consumer that admits or recovers work from that identity. The
// real-host proof for this contract only runs on the Windows lane, so a change
// to any of them that skipped the lane would merge a Windows regression unseen.
// Not gated on isTestOnly: the proof itself is a test file and must route here.
const WINDOWS_PROCESS_IDENTITY_SCOPE_RE =
  /^src\/(?:shared\/pid-alive(?:\.[a-z-]+)?(?:\.test)?\.ts|infra\/(?:windows-process-start|gateway-lock)(?:\.test)?\.ts|node-host\/node-worker-process-identity(?:\.test)?\.ts|cron\/store\/run-receipt-store(?:\.test)?\.ts)$/;
const WINDOWS_FILE_URL_SCOPE_RE =
  /^(?:src\/agents\/tools\/(?:media-tool-file-url\.windows\.test|media-tool-shared(?:\.test)?|pdf-tool(?:\.test)?)|src\/auto-reply\/(?:reply\/stage-sandbox-media|reply\.triggers\.trigger-handling\.stages-inbound-media-into-sandbox-workspace\.test)|src\/media\/(?:local-media-path(?:\.windows\.test)?|local-roots(?:\.test)?|web-media(?:\.file-url\.windows\.test)?)|src\/channels\/inbound-event\/media(?:\.test)?|src\/gateway\/managed-image-attachments(?:\.test)?|extensions\/msteams\/src\/(?:media-helpers|messenger)(?:\.test)?)\.ts$/;
const WINDOWS_SCOPE_RE =
  /^(src\/cli\/completion-runtime\.ts$|extensions\/canvas\/scripts\/pnpm-runner\.(?:mjs|test\.ts)$|extensions\/mxc\/|src\/agents\/(?:bash-tools\.exec-script-(?:preflight|target)|bash-tools\.exec\.script-preflight\.test)\.ts$|src\/config\/sessions\/(?:session-accessor\.sqlite-archive(?:\.worker(?:\.test)?)?|store\.session-lifecycle-mutation\.test)\.ts$|src\/process\/|src\/infra\/(?:(?:exec-allowlist-pattern|fs-safe-remove)(?:\.windows)?(?:\.test)?|ports(?:-inspect|\.test)|ssh-client(?:\.windows\.test)?|update-managed-service-handoff(?:-(?:command|lifecycle)\.test)?|windows-install-roots)\.ts$|src\/shared\/(?:import-specifier|runtime-import)(?:\.test)?\.ts$|src\/test-utils\/openclaw-test-state(?:\.test)?\.ts$|scripts\/(?:android-(?:app-i18n|pin-version)\.ts|ci-run-timings\.mjs|e2e\/lib\/package-compat\.mjs|generate-bundled-channel-config-metadata\.ts|install\.ps1|openclaw-cross-os-release-checks\.ts|plan-release-workflow-matrix\.mjs|run-additional-boundary-checks\.mts|verify-docker-attestations\.mjs|github\/run-openclaw-cross-os-release-checks\.sh|tsx\.mjs|(?:npm-runner|pnpm-runner|ui|vitest-process-group)\.(?:mjs|mts|js)|lib\/(?:direct-run\.(?:mjs|mts)|format-generated-module\.mts|tsx-cli-shim\.mjs|cross-os-release-checks\/[^/]+\.ts))$|test\/scripts\/(?:direct-run-entrypoints|format-generated-module|install-ps1|npm-runner|openclaw-cross-os-release-workflow|pnpm-runner|ui|vitest-process-group)\.test\.ts$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|\.github\/workflows\/(?:ci|openclaw-cross-os-release-checks-reusable)\.yml$|\.github\/actions\/setup-node-env\/action\.yml$|\.github\/actions\/setup-pnpm-store-cache\/action\.yml$)/;
const WINDOWS_LAN_ADVERTISEMENT_SCOPE_RE =
  /^src\/infra\/advertised-lan-host(?:\.windows)?(?:\.test)?\.ts$/;
const WINDOWS_SECRETREF_SCOPE_RE =
  /^(?:src\/commands\/doctor-gateway-auth-token(?:\.windows\.test)?\.ts|src\/flows\/(?:doctor-core-checks|doctor-health-contributions)\.ts|src\/gateway\/(?:auth-token-resolution|resolve-configured-secret-input-string)\.ts|src\/infra\/(?:fs-safe|fs-safe-defaults|permissions)\.ts|src\/secrets\/(?:resolve|resolve-errors)\.ts|src\/security\/audit-fs\.ts)$/;
const WINDOWS_DAEMON_SCOPE_RE =
  /^src\/daemon\/(?:schtasks(?:[-.][^/]+)?|runtime-hints\.windows-paths(?:\.test)?|test-helpers\/schtasks-(?:base-mocks|fixtures))\.ts$/;
const WINDOWS_USAGE_TEMPLATE_SCOPE_RE =
  /^src\/auto-reply\/usage-bar\/template(?:\.windows\.test)?\.ts$/;
const WINDOWS_MEDIA_UNDERSTANDING_FILE_URL_SCOPE_RE =
  /^src\/media-understanding\/attachments\.(?:cache(?:\.test)?|file-url\.windows\.test|normalize(?:\.test)?)\.ts$/;
const WINDOWS_HOME_DISPLAY_SCOPE_RE =
  /^(?:src\/(?:utils(?:\.test)?|infra\/(?:home-display|path-guards)|commands\/agents\.commands\.list(?:\.test)?|cli\/daemon-cli\/status\.print(?:\.test)?|agents\/(?:sandbox\/fs-paths|sessions\/tools\/render-utils)(?:\.test)?)|packages\/terminal-core\/src\/display-string(?:\.test)?)\.ts$/;
const WINDOWS_CHILD_ENV_SCOPE_RE =
  /^src\/(?:agents\/provider-local-service(?:\.env-case\.test)?|cli\/mcp-cli(?:\.path-case\.windows)?\.test|cli\/mcp-cli|infra\/process-env(?:\.test)?)\.ts$/;
const WINDOWS_SOURCE_CLI_SCOPE_RE =
  /^src\/infra\/openclaw-cli-(?:invocation(?:\.test(?:-support)?)?|shim(?:\.(?:windows\.)?test)?)\.ts$/;
// The helper is test-only, but its command and receipt owners need native process proof.
const WINDOWS_TEST_INSTANCE_SCOPE_RE =
  /^(?:test\/helpers\/openclaw-test-instance(?:\.test)?\.ts|test\/helpers\/openclaw-test-instance\.cli\.test-support\.mjs|scripts\/lib\/(?:managed-child-process|vitest-resource-ownership)\.mts)$/;
const WINDOWS_NODE_HOST_EXECUTABLE_SCOPE_RE =
  /^(?:src\/plugin-sdk\/node-host(?:\.test)?|src\/tui\/(?:tui|tui\.resolve-codex-bin\.test))\.ts$/;
const WINDOWS_AGENT_HOME_PATH_SCOPE_RE =
  /^src\/(?:infra\/home-dir(?:\.test)?|agents\/(?:agent-tools\.read(?:\.host-operations|\.windows)?\.test|agent-tools\.read|sessions\/tools\/path-utils(?:\.test)?))\.ts$/;
const WINDOWS_MEMORY_EXTRA_FILE_SCOPE_RE =
  /^(?:packages\/memory-host-sdk\/src\/host\/(?:(?:internal|read-file)(?:\.test)?|explicit-extra-markdown)|extensions\/memory-core\/src\/(?:cli-runtime-common|memory-extra-file-path\.windows\.test))\.ts$/;
const WINDOWS_WORKSPACE_QUIESCENCE_SCOPE_RE =
  /^src\/gateway\/worker-environments\/workspace-quiescence(?:-scripts|(?:\.windows)?\.test)?\.ts$/;
const WINDOWS_WORKER_BUNDLE_SCOPE_RE =
  /^src\/(?:shared\/worker-bundle-(?:archive|hash)(?:\.test)?|gateway\/worker-environments\/bundle(?:-staging)?(?:\.test)?|node-host\/node-worker-bundle-installer(?:\.test)?)\.ts$/;
const WINDOWS_WORKER_WORKSPACE_SCOPE_RE =
  /^src\/(?:node-host\/node-worker-transfer-client(?:\.test)?|gateway\/worker-environments\/(?:node-worker-tunnel(?:\.test)?|workspace-sync-(?:scripts|manifest\.test)))\.ts$/;
const CONTROL_UI_I18N_SCOPE_RE =
  /^(ui\/src\/i18n\/|ui\/config\/control-ui-locales\.ts$|scripts\/(?:control-ui-i18n(?:-verify)?\.ts|lib\/control-ui-i18n-(?:(?:catalog|config|raw-copy|sync-plan)\.ts|config\.json))$|\.github\/workflows\/control-ui-locale-refresh\.yml$)/;
const CONTROL_UI_RAW_COPY_SOURCE_RE = /^ui\/src\/(?:app|components|lib|pages)\/.*\.tsx?$/;
const CONTROL_UI_HARD_GENERATED_I18N_RE =
  /^ui\/src\/i18n\/\.i18n\/(?:catalog-fallbacks\.json|[^/]+\.(?:meta\.json|tm\.jsonl))$/;
const RELEASE_BRANCH_RE = /^release\/\d{4}\.\d+\.\d+$/;

class ControlUiGeneratedArtifactsMixedError extends Error {}
class NativeGeneratedArtifactsMixedError extends Error {}
// Browser setup and sharding inputs must select the same proof as the config;
// matching the harness family also covers per-project bundle setup owners.
// The UI E2E config explicitly owns the QA Lab media-transcript browser suite.
const CHROMIUM_UI_TEST_SCOPE_RE =
  /^(ui\/|extensions\/browser\/chrome-extension\/|extensions\/qa-lab\/src\/control-ui-media-transcript\.real-gateway\.e2e\.test\.ts$|test\/vitest\/vitest\.(?:shared\.config\.ts|ui-(?:e2e|browser)\.[^/]+\.ts|(?:pattern-file|performance-config|timeouts|weighted-sharding)\.ts|ui-(?:isolated-)?paths\.mjs)$|test\/helpers\/temp-dir\.ts$|scripts\/(?:ensure-playwright-chromium\.mts|control-ui-mock-[^/]+\.ts|lib\/(?:ci-test-timings(?:-schema)?|vitest-local-scheduling)\.mts)$|config\/ci-test-timings\.json$|package\.json$|\.github\/workflows\/ci\.yml$)/;
const NATIVE_I18N_SCOPE_RE =
  /^(?:apps\/\.i18n\/|apps\/android\/(?:app\/src\/(?:main|play|thirdParty)\/|wear\/src\/main\/)|apps\/ios\/|apps\/macos\/Sources\/|apps\/shared\/OpenClawKit\/Sources\/|scripts\/(?:android-app-i18n|apple-app-i18n|native-(?:app-i18n|i18n-locales))\.ts$|test\/scripts\/(?:android-app-i18n|apple-app-i18n|native-app-i18n)\.test\.ts$|\.github\/workflows\/(?:ci|native-app-locale-refresh)\.yml$)/;
// Android base resources are co-owned: source PRs edit their English content,
// while the generator rewrites managed sections. Treat them as generated only
// alongside a hard-generated artifact so neither ownership path blocks the other.
const NATIVE_COOWNED_GENERATED_I18N_RE =
  /^apps\/android\/app\/src\/main\/res\/values\/(?:assistant|strings)\.xml$/;
const NATIVE_HARD_GENERATED_I18N_RE =
  /^(?:apps\/\.i18n\/native\/[^/]+\.json|apps\/android\/app\/src\/main\/java\/ai\/openclaw\/app\/i18n\/NativeStringResources\.kt|apps\/android\/app\/src\/main\/res\/values-[^/]+\/(?:assistant|strings)\.xml|apps\/android\/app\/src\/thirdParty\/res\/values-[^/]+\/accessibility_strings\.xml|apps\/android\/wear\/src\/main\/res\/values-[^/]+\/strings\.xml|apps\/ios\/Resources\/Localizable\.xcstrings|apps\/macos\/Sources\/OpenClaw\/Resources\/Localizable\.xcstrings|apps\/ios\/(?:Sources|WatchApp|ShareExtension|ActivityWidget)\/[^/]+\.lproj\/InfoPlist\.strings)$/;
const NATIVE_CANONICAL_V2_MIGRATION_GENERATED_RE =
  /^(?:apps\/\.i18n\/native\/[^/]+\.json|apps\/android\/app\/src\/main\/res\/values-[^/]+\/strings\.xml|apps\/android\/wear\/src\/main\/res\/values-[^/]+\/strings\.xml|apps\/ios\/Resources\/Localizable\.xcstrings|apps\/macos\/Sources\/OpenClaw\/Resources\/Localizable\.xcstrings)$/;
const FAST_INSTALL_SMOKE_SCOPE_RE =
  /^(Dockerfile$|\.npmrc$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|scripts\/ci-changed-scope\.mjs$|scripts\/postinstall-bundled-plugins\.mjs$|scripts\/e2e\/(?:Dockerfile(?:\.qr-import)?|agents-delete-shared-workspace-docker\.sh|gateway-network-docker\.sh)$|extensions\/[^/]+\/(?:package\.json|openclaw\.plugin\.json)$|\.github\/workflows\/install-smoke\.yml$|\.github\/actions\/setup-node-env\/action\.yml$)/;
const FULL_INSTALL_SMOKE_SCOPE_RE =
  /^(Dockerfile$|\.npmrc$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|scripts\/ci-changed-scope\.mjs$|scripts\/install(?:-cli)?\.sh$|scripts\/install\.ps1$|scripts\/test-install-sh-docker\.sh$|scripts\/docker\/|scripts\/e2e\/(?:Dockerfile(?:\.qr-import)?|qr-import-docker\.sh|bun-global-install-smoke\.sh)$|\.github\/workflows\/(?:install-smoke|website-installer-sync)\.yml$|\.github\/actions\/setup-node-env\/action\.yml$)/;
const FAST_INSTALL_SMOKE_RUNTIME_SCOPE_RE =
  /^(?:src\/(?:channels|gateway|plugin-sdk|plugins)\/|packages\/gateway-(?:client|protocol)\/src\/)/;
const NODE_FAST_PLUGIN_CONTRACT_SCOPE_RE =
  /^src\/plugins\/contracts\/(?:inventory\/bundled-capability-metadata|registry|tts-contract-suites)\.ts$/;
const NODE_FAST_CI_ROUTING_SCOPE_RE =
  /^(scripts\/ci-changed-scope\.mjs$|scripts\/(?:check-changed|run-vitest)\.(?:mjs|mts)$|scripts\/test-projects(?:\.test-support)?\.mts$|scripts\/lib\/changed-path-facts\.mjs$|scripts\/lib\/ci-changed-node-test-plan\.mts$|src\/commands\/status\.scan-result\.test\.ts$|src\/scripts\/ci-changed-scope(?:\.[^/]+)?\.test\.ts$|test\/scripts\/(?:changed-lanes|changed-path-facts|ci-changed-node-test-plan|run-vitest|test-projects)\.test\.ts$)/;
const NODE_FAST_SCOPE_RE = new RegExp(
  `${NODE_FAST_PLUGIN_CONTRACT_SCOPE_RE.source}|${NODE_FAST_CI_ROUTING_SCOPE_RE.source}`,
);

/** @param {string} path Canonical repository-relative script or test path. */
export function isMacosToolingPath(path) {
  return MACOS_SCRIPT_SCOPE_RE.test(path);
}

/** @param {string} path Canonical repository-relative build input. */
function isAppleSharedBuildInput(path) {
  return (
    APPLE_SWIFT_CONFIG_RE.test(path) ||
    MERMAID_ASSET_INPUT_RE.test(path) ||
    path === "scripts/prepare-apple-mermaid.mjs"
  );
}

/**
 * Detects high-level CI scope from changed file paths.
 * @param {string[]} changedPaths
 * @returns {ChangedScope}
 */
export function detectChangedScope(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return { ...FULL_SCOPE };
  }

  // The package scripts own the native test inventory; a second whitelist drifts.
  const scripts = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).scripts;
  const windowsCiTests = new Set(
    [1, 2].flatMap((part) => {
      const targets = scripts[`test:windows:ci:${part}`].match(/[^\s"']+\.test\.ts/g);
      if (!targets) {
        throw new Error(`Windows CI part ${part} must declare explicit test paths`);
      }
      return targets;
    }),
  );

  let runNode = false;
  let runMacos = false;
  let hasGitOwnerChanges = false;
  let hasMacosNodeTestSupportChanges = false;
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

    const isAppleBuildInput = isAppleSharedBuildInput(path);

    if (facts.surface === "docs") {
      continue;
    }

    hasNonDocs = true;
    hasGitOwnerChanges ||= GIT_OWNER_SCOPE_RE.test(path);
    // Native shell fixture support needs Darwin proof, not Swift or Windows builds.
    hasMacosNodeTestSupportChanges ||= path === "test/scripts/mac-script-fixture.test-support.ts";

    if (SKILLS_PYTHON_SCOPE_RE.test(path)) {
      runSkillsPython = true;
    }

    if (INSTALL_SMOKE_WORKFLOW_SCOPE_RE.test(path)) {
      runChangedSmoke = true;
    }

    if (
      !NATIVE_PROTOCOL_GEN_RE.test(path) &&
      (MACOS_NATIVE_RE.test(path) ||
        isMacosToolingPath(path) ||
        WORKER_DEPLOY_ARTIFACT_SCOPE_RE.test(path) ||
        APPLE_SHARED_CONTRACT_FIXTURE_RE.test(path) ||
        isAppleBuildInput)
    ) {
      runMacos = true;
    }

    if (IOS_BUILD_RE.test(path) || isAppleBuildInput) {
      runIosBuild = true;
    }

    if (
      !NATIVE_PROTOCOL_GEN_RE.test(path) &&
      (ANDROID_NATIVE_RE.test(path) || MERMAID_ASSET_INPUT_RE.test(path))
    ) {
      runAndroid = true;
    }

    if (NODE_SCOPE_RE.test(path)) {
      runNode = true;
    }

    if (
      windowsCiTests.has(path) ||
      WINDOWS_LAN_ADVERTISEMENT_SCOPE_RE.test(path) ||
      WINDOWS_FILE_URL_SCOPE_RE.test(path) ||
      WINDOWS_DAEMON_SCOPE_RE.test(path) ||
      WINDOWS_USAGE_TEMPLATE_SCOPE_RE.test(path) ||
      WINDOWS_MEDIA_UNDERSTANDING_FILE_URL_SCOPE_RE.test(path) ||
      WINDOWS_HOME_DISPLAY_SCOPE_RE.test(path) ||
      WINDOWS_AGENT_HOME_PATH_SCOPE_RE.test(path) ||
      WINDOWS_CHILD_ENV_SCOPE_RE.test(path) ||
      WINDOWS_SOURCE_CLI_SCOPE_RE.test(path) ||
      WINDOWS_TEST_INSTANCE_SCOPE_RE.test(path) ||
      WINDOWS_NODE_HOST_EXECUTABLE_SCOPE_RE.test(path) ||
      WINDOWS_MEMORY_EXTRA_FILE_SCOPE_RE.test(path) ||
      WINDOWS_WORKSPACE_QUIESCENCE_SCOPE_RE.test(path) ||
      WINDOWS_WORKER_BUNDLE_SCOPE_RE.test(path) ||
      WINDOWS_WORKER_WORKSPACE_SCOPE_RE.test(path) ||
      WINDOWS_PROCESS_IDENTITY_SCOPE_RE.test(path) ||
      (!facts.isTestOnly &&
        (WINDOWS_SCOPE_RE.test(path) ||
          WINDOWS_SQLITE_SCOPE_RE.test(path) ||
          WINDOWS_SECRETREF_SCOPE_RE.test(path)))
    ) {
      runWindows = true;
    }

    if (detectInstallSmokeScopeForPath(path).runFastInstallSmoke) {
      runChangedSmoke = true;
    }

    if (
      CONTROL_UI_I18N_SCOPE_RE.test(path) ||
      (CONTROL_UI_RAW_COPY_SOURCE_RE.test(path) && !facts.isTestOnly)
    ) {
      runControlUiI18n = true;
    }

    if (CHROMIUM_UI_TEST_SCOPE_RE.test(path) || MERMAID_ASSET_INPUT_RE.test(path)) {
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
    runMacosNode: runMacos || hasGitOwnerChanges || hasMacosNodeTestSupportChanges,
    runIosBuild,
    runAndroid,
    runWindows: runWindows || hasGitOwnerChanges,
    runSkillsPython,
    runChangedSmoke,
    runControlUiI18n,
    runUiTests,
  };
}

/**
 * Release screenshot capture is a conservative pipeline-integrity gate. App,
 * linked Swift, and capture-tool changes must prove the real release lane.
 * @param {string[] | null} changedPaths
 * @returns {boolean}
 */
export function shouldRunIosScreenshots(changedPaths) {
  if (!Array.isArray(changedPaths)) {
    return true;
  }
  return changedPaths.some((rawPath) => {
    const { path } = getChangedPathFacts(rawPath);
    return (
      IOS_SCREENSHOT_APP_SCOPE_RE.test(path) ||
      IOS_SCREENSHOT_SCRIPT_SCOPE_RE.test(path) ||
      isAppleSharedBuildInput(path)
    );
  });
}

/**
 * Generated Control UI locale snapshots belong in their isolated automation PR.
 * Mixing them into a source PR recreates deterministic rebase conflicts.
 * @param {string[]} changedPaths
 * @param {string} [branchName]
 * @returns {void}
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
  if (isControlUiCanonicalMemoryMigration(changedPaths, generatedPaths)) {
    return;
  }
  throw new ControlUiGeneratedArtifactsMixedError(
    [
      "Control UI generated locale artifacts must be isolated from source changes.",
      "Commit English/source changes only; the locale refresh workflow owns generated translation memory and metadata.",
      ...generatedPaths.map((filePath) => `- generated: ${filePath}`),
      ...sourcePaths.map((filePath) => `- source: ${filePath}`),
    ].join("\n"),
  );
}

/**
 * @param {string[]} changedPaths
 * @param {string[]} generatedPaths
 * @returns {boolean}
 */
function isControlUiCanonicalMemoryMigration(changedPaths, generatedPaths) {
  const requiredOwners = [
    ".gitattributes",
    "scripts/ci-changed-scope.mjs",
    "scripts/control-ui-i18n.ts",
    "scripts/control-ui-i18n-verify.ts",
    "scripts/lib/control-ui-i18n-catalog.ts",
    "scripts/lib/control-ui-i18n-sync-plan.ts",
    "ui/AGENTS.md",
    "ui/config/control-ui-locales.ts",
    "ui/vite.config.ts",
  ];
  if (!requiredOwners.every((owner) => changedPaths.includes(owner))) {
    return false;
  }

  const assetsDir = new URL("../ui/src/i18n/.i18n/", import.meta.url);
  const locales = readdirSync(assetsDir)
    .filter((fileName) => fileName.endsWith(".tm.jsonl"))
    .map((fileName) => fileName.slice(0, -".tm.jsonl".length));
  const requiredGeneratedPaths = [
    "ui/src/i18n/.i18n/catalog-fallbacks.json",
    ...locales.flatMap((locale) => [
      `ui/src/i18n/.i18n/${locale}.tm.jsonl`,
      `ui/src/i18n/.i18n/${locale}.meta.json`,
    ]),
  ];
  if (
    generatedPaths.length !== requiredGeneratedPaths.length ||
    !requiredGeneratedPaths.every((filePath) => generatedPaths.includes(filePath))
  ) {
    return false;
  }

  return locales.every((locale) => {
    const adapterPath = `ui/src/i18n/locales/${locale}.ts`;
    if (!changedPaths.includes(adapterPath)) {
      return false;
    }
    let source;
    try {
      source = readFileSync(new URL(`../${adapterPath}`, import.meta.url), "utf8").trim();
    } catch {
      return false;
    }
    const exportName = locale.replaceAll("-", "_");
    return (
      source ===
      `export { default as ${exportName} } from "virtual:openclaw-control-ui-locale/${locale}";`
    );
  });
}

/**
 * @param {string[] | null} changedPaths
 * @returns {boolean}
 */
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
 * @param {string} [branchName]
 * @returns {void}
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
  if (isNativeCanonicalV2Migration(changedPaths, generatedPaths)) {
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

/**
 * One-time v2 native artifact migration escape; remove after the migration PR lands.
 * @param {string[]} changedPaths
 * @param {string[]} generatedPaths
 * @returns {boolean}
 */
function isNativeCanonicalV2Migration(changedPaths, generatedPaths) {
  const requiredOwners = [
    ".gitattributes",
    "scripts/ci-changed-scope.mjs",
    "scripts/native-app-i18n.ts",
    "scripts/android-app-i18n.ts",
    "scripts/apple-app-i18n.ts",
    "test/scripts/native-app-i18n.test.ts",
    "test/scripts/apple-app-i18n.test.ts",
    "src/scripts/ci-changed-scope.native-i18n.test.ts",
  ];
  return (
    requiredOwners.every((owner) => changedPaths.includes(owner)) &&
    generatedPaths.every((filePath) => NATIVE_CANONICAL_V2_MIGRATION_GENERATED_RE.test(filePath))
  );
}

/**
 * @param {string[] | null} changedPaths
 * @returns {boolean}
 */
export function shouldStrictNativeI18n(changedPaths) {
  return (
    changedPaths === null ||
    changedPaths.some((filePath) => NATIVE_HARD_GENERATED_I18N_RE.test(filePath))
  );
}

/** @returns {string} */
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

/**
 * @param {Readonly<Record<string, string | undefined>>} [env]
 * @param {string} [branchName]
 * @returns {string}
 */
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

/**
 * @param {string[] | null | undefined} changedPaths
 * @returns {boolean}
 */
export function shouldRunNativeI18n(changedPaths) {
  return (
    !Array.isArray(changedPaths) ||
    changedPaths.length === 0 ||
    changedPaths.some((path) => NATIVE_I18N_SCOPE_RE.test(path.trim()))
  );
}

/**
 * Detects whether node-fast CI can cover the changed paths.
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
 * Detects whether install-smoke CI should run for changed paths.
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
 * Lists changed paths for CI base/head inputs.
 * @param {string} base
 * @param {string} [head]
 * @param {string} [cwd]
 * @param {boolean} [preferMergeHeadFirstParent]
 * @returns {string[]}
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
 * Writes CI scope decisions to GitHub Actions output.
 * @param {ChangedScope} scope
 * @param {string} [outputPath]
 * @param {InstallSmokeScope} [installSmokeScope]
 * @param {NodeFastScope} [nodeFastScope]
 * @param {boolean} [runNativeI18n]
 * @param {string[] | null} [changedPaths]
 * @returns {void}
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
  appendFileSync(outputPath, `run_macos_node=${scope.runMacosNode}\n`, "utf8");
  appendFileSync(outputPath, `run_ios_build=${scope.runIosBuild}\n`, "utf8");
  appendFileSync(
    outputPath,
    `run_ios_screenshots=${shouldRunIosScreenshots(changedPaths)}\n`,
    "utf8",
  );
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

/** @returns {boolean} */
function isDirectRun() {
  return isDirectRunUrl(process.argv[1], import.meta.url);
}

/**
 * @param {string[]} argv
 * @returns {{ base: string; head: string; mergeHeadFirstParent: boolean }}
 */
export function parseArgs(argv) {
  const args = { base: "", head: "HEAD", mergeHeadFirstParent: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base" || arg === "--head") {
      args[arg === "--base" ? "base" : "head"] = requireOptionArgument(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--merge-head-first-parent") {
      args.mergeHeadFirstParent = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.base) {
    throw new Error("--base is required");
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

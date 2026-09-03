/**
 * Knip configuration for OpenClaw root and bundled plugin dependency hygiene.
 */
import fs from "node:fs";
import path from "node:path";
import { runtimeProcessBuildEntries } from "../scripts/lib/runtime-process-build-entries.mts";

const BUNDLED_PLUGIN_ROOT_DIR = "extensions";

function bundledPluginFile(pluginId: string, relativePath: string, suffix = ""): string {
  return `${BUNDLED_PLUGIN_ROOT_DIR}/${pluginId}/${relativePath}${suffix}`;
}

// Package scripts, workflows, Docker scenarios, and documented maintainer commands invoke these
// files by path. They are executable roots rather than importable library modules.
const repositoryScriptEntries = [
  // CI imports this selector from its trusted harness inside an inline Node script.
  ".github/actions/git-owner/test-prerequisites.mjs!",
  // mobile-release-authority invokes this helper from composite-action YAML.
  ".github/actions/mobile-release-authority/authority.mjs!",
  // setup-node-env invokes this helper from composite-action YAML.
  ".github/actions/setup-node-env/dependency-fingerprint.mjs!",
  "apps/android/scripts/build-release-artifacts.ts!",
  "scripts/bundle-a2ui.mts!",
  "scripts/build-discord-activity-sdk.mts!",
  // package-mac-app.sh launches the architecture scheduler by path.
  "scripts/build-mac-swift.mts!",
  "scripts/check-control-ui-performance.mts!",
  "scripts/check-control-ui-precompressed-assets.mts!",
  "scripts/check-live-cache.ts!",
  "scripts/check-package-dist-imports.mjs!",
  // Cloudflare deployment template: wrangler bundles the Worker from this entry.
  "scripts/cloudflare/src/index.ts!",
  // Invoked by the documented macOS Computer Use live-proof shell rig.
  "scripts/dev/computer-use-macos-live-proof.ts!",
  "scripts/dev/ios-node-e2e.ts!",
  "scripts/diffs-shiki-curated.ts!",
  // Reusable Docker workflows invoke this from the downloaded .release-harness tree.
  "scripts/docker-e2e.mts!",
  "scripts/e2e/lib/browser-cdp-snapshot/assert-snapshot.mjs!",
  "scripts/e2e/lib/browser-cdp-snapshot/fixture-server.mjs!",
  "scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs!",
  "scripts/e2e/lib/clawhub-fixture-server.cjs!",
  "scripts/e2e/lib/codex-media-path/client.mjs!",
  "scripts/e2e/lib/codex-media-path/fake-codex-app-server.mjs!",
  "scripts/e2e/lib/codex-media-path/write-config.mjs!",
  "scripts/e2e/lib/codex-npm-plugin-live/followthrough-turn.mjs!",
  "scripts/e2e/lib/codex-on-demand/doctor-checks.mjs!",
  "scripts/e2e/lib/config-reload/assert-log.mjs!",
  "scripts/e2e/lib/config-reload/mutate-metadata.mjs!",
  "scripts/e2e/lib/docker-artifact-proof/write-identities.ts!",
  "scripts/e2e/lib/docker-stats/assert-resource-ceiling.mjs!",
  "scripts/e2e/lib/doctor-install-switch/assert-exec-start.mjs!",
  "scripts/e2e/lib/doctor-install-switch/write-wrapper.mjs!",
  "scripts/e2e/lib/fixture.mjs!",
  "scripts/e2e/lib/fixtures/config.mjs!",
  "scripts/e2e/lib/fixtures/plugins.mjs!",
  "scripts/e2e/lib/fixtures/workspace.mjs!",
  "scripts/e2e/lib/npm-telegram-live/prepare-package.mts!",
  "scripts/e2e/lib/onboard/assert-config.mjs!",
  "scripts/e2e/lib/onboard/write-config.mjs!",
  "scripts/e2e/lib/openai-chat-tools/client.mjs!",
  "scripts/e2e/lib/openai-chat-tools/write-config.mjs!",
  "scripts/e2e/lib/package-git-fixture.mjs!",
  "scripts/e2e/lib/plugin-lifecycle-matrix/measure.mjs!",
  "scripts/e2e/lib/plugin-update/registry-server.mjs!",
  "scripts/e2e/lib/plugins/npm-registry-server.mjs!",
  "scripts/e2e/lib/release-plugin-marketplace/lifecycle-assertions.mjs!",
  "scripts/e2e/lib/release-scenarios/write-cli-plugin.mjs!",
  "scripts/e2e/lib/release-scenarios/write-marketplace.mjs!",
  "scripts/e2e/lib/release-user-journey/clickclack-fixture.mjs!",
  "scripts/e2e/lib/release-user-journey/write-clickclack-plugin.mjs!",
  "scripts/e2e/lib/run-with-pty.mjs!",
  "scripts/e2e/lib/sandbox-browser-sidecar/scenario.mjs!",
  // systemd-sealed-service-definition.sh executes these via Node stdin and a container path.
  "scripts/e2e/lib/systemd-sealed-service-definition/file-mount.mjs!",
  "scripts/e2e/lib/systemd-sealed-service-definition/paired-mounts.mjs!",
  "scripts/e2e/lib/upgrade-survivor/config-parking.mjs!",
  // Capture runs in the container; sanitization runs only on the trusted host.
  "scripts/e2e/lib/upgrade-survivor/diagnostics.mjs!",
  "scripts/upgrade-survivor-diagnostics.mjs!",
  "scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs!",
  "scripts/e2e/lib/upgrade-survivor/probe-volume-gateway.mjs!",
  "scripts/e2e/lib/upgrade-survivor/recovery-cleanup.mjs!",
  // update-restart-auth.sh installs this manager/launch adapter into the fixture bin directory.
  "scripts/e2e/lib/upgrade-survivor/systemd-fixture.mjs!",
  "scripts/embedded-run-abort-leak.ts!",
  "scripts/fixtures/packed-plugin-sdk-type-smoke.ts!",
  // CI executes screenshot evidence from the workflow-owned harness copy.
  "scripts/ios-screenshot-evidence.mjs!",
  "scripts/ios-release-cut.ts!",
  "scripts/ios-release-plan.ts!",
  "scripts/ios-release-signing.mts!",
  "scripts/lib/docker-plugin-selection.mjs!",
  // CI loads the native Vitest reporter through its CLI path.
  "scripts/lib/vitest-resource-reporter.mts!",
  // Invoked by scripts/lib/live-docker-stage.sh during container validation.
  "scripts/live-docker-normalize-config.ts!",
  "scripts/mcp-code-mode-gateway-e2e.ts!",
  "scripts/openclaw-release-clawhub-plan.ts!",
  "scripts/openclaw-release-clawhub-runtime-state.ts!",
  // Plugin Prerelease builds immutable package artifacts, then scans them in a bounded child.
  "scripts/plugin-npm-security-prepare.mts!",
  "scripts/plugin-npm-security-scan-runner.mjs!",
  "scripts/plugin-npm-security-scan.mts!",
  // Oxlint loads this JS plugin by path from config/oxlint/boundary-guards.json.
  "scripts/oxlint-boundary-guards.mjs!",
  "scripts/plugin-prerelease-liveish-matrix.mts!",
  "scripts/pre-commit/guard-staged-content.mjs!",
  // Generates the checked-in native protocol models from core descriptor metadata.
  "scripts/protocol-gen.ts!",
  "scripts/pr-gates-lock.mts!",
  "scripts/pr-lib/ci-dispatch.mjs!",
  // merge.sh invokes this native review-authority parser by path.
  "scripts/pr-lib/clawsweeper-review-gate.mjs!",
  "scripts/pr-lib/gh-api-preflight.mjs!",
  "scripts/pr-lib/merge-body.mjs!",
  "scripts/pr-lib/review-artifacts.mjs!",
  "scripts/pr-lib/process-group-runner.mjs!",
  "scripts/pre-commit/filter-staged-files.mjs!",
  "scripts/print-live-docker-plugin-selection.mjs!",
  // Maintainer proof harnesses are invoked manually from PR evidence.
  "scripts/proof-136410-status-harness-record.ts!",
  "scripts/qa-coverage-report.ts!",
  "scripts/qa-parity-report.ts!",
  "scripts/resolve-frozen-codex-live-suite.mjs!",
  // Changed-file checks invoke this targeted UI Stylelint entrypoint by path.
  "scripts/run-stylelint.mts!",
  // Path-spawned test roots are development entries; `!` would audit dev tools as production.
  "scripts/run-vitest-child.mts",
  "scripts/test-projects-child.mts",
  "scripts/secrets/openclaw-bws-resolver.mjs!",
  "scripts/sync-labels.ts!",
  "scripts/test-built-bundled-channel-entry-smoke.mts!",
  // Native shell UI tests connect to this manually launched loopback Gateway fixture.
  "scripts/test-ios-shell-gateway.mjs!",
  "scripts/update-clawtributors.ts!",
  // The candidate binder invokes this trusted producer-identity verifier by path.
  "scripts/verify-full-release-producer-job.mjs!",
  // Staging and signed-app packaging execute this verifier with each bundled Node.
  "scripts/verify-mac-node-worker.mjs!",
  "scripts/verify-stable-main-closeout.mjs!",
  "scripts/write-package-dist-inventory.ts!",
  "scripts/write-plugin-sdk-entry-dts.ts!",
  "scripts/write-unified-entry-dts.ts!",
  "security/opengrep/check-rule-metadata.mjs!",
  "security/opengrep/compile-rules.mjs!",
  "skills/meme-maker/scripts/meme.mjs!",
] as const;

// Compatibility shims are executable roots and load their typed implementations by computed URL,
// which Knip cannot follow in either direction.
function listScriptShimEntries(dir = "scripts"): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listScriptShimEntries(entryPath);
    }
    if (!entry.isFile() || (!entry.name.endsWith(".mjs") && !entry.name.endsWith(".js"))) {
      return [];
    }
    const implementationPath = entryPath.replace(/\.(?:mjs|js)$/u, ".mts");
    return fs.existsSync(implementationPath) ? [`${entryPath}!`, `${implementationPath}!`] : [];
  });
}

const rootEntries = [
  ...repositoryScriptEntries,
  ...listScriptShimEntries(),
  // Runtime launchers resolve these by URL rather than a static import edge.
  ...Object.values(runtimeProcessBuildEntries).map(
    (source) => `${path.relative(".", source).replaceAll("\\", "/")}!`,
  ),
  // Knip loads these audit configurations directly by command-line path.
  "config/knip.config.ts!",
  "config/knip.all-exports.config.ts!",
  "config/knip.scripts-exports.config.ts!",
  "openclaw.mjs!",
  "src/index.ts!",
  "src/entry.ts!",
  // Built as the official image's Docker HEALTHCHECK entrypoint.
  "src/docker-healthcheck.ts!",
  // Uploaded in the worker bundle and launched by rsync; no static host import exists.
  "src/worker/workspace-rsync-receiver.ts!",
  // Shipped compatibility facade for statusCommand and getStatusSummary.
  "src/commands/status.ts!",
  "src/cli/daemon-cli.ts!",
  "src/agents/code-mode.worker.ts!",
  // Worker-thread and script entrypoints import contracts that production Knip cannot trace.
  "src/agents/compaction-planning.worker.ts!",
  "scripts/print-cli-backend-live-metadata.ts!",
  // Workflow/package-script entrypoints are not imported from production modules.
  "scripts/openclaw-cross-os-release-checks.ts!",
  "scripts/release-plan-producer-core.mts!",
  "scripts/release-plan-producer.mts!",
  // Spawned by the agent concurrency benchmark; no static import edge exists.
  "scripts/bench-agent-concurrency-worker.ts!",
  // Spawned by the durable task registry churn benchmark in a fresh GC-enabled process.
  "scripts/bench-task-registry-sqlite-worker.ts!",
  "scripts/bench-sqlite-reliability.ts!",
  // Docker/manual E2E executables and their nested assertion/probe entrypoints.
  "scripts/e2e/*.{js,mjs,ts}!",
  "scripts/e2e/lib/**/{assertions,probe,mock-server}.{js,mjs,ts}!",
  "src/agents/model-provider-auth.worker.ts!",
  "src/agents/prepared-model-catalog.worker.ts!",
  // Loaded by URL from setup-inference-detection.ts; no static import edge exists.
  "src/system-agent/setup-inference-detection.worker.ts!",
  // Split runtime loaded through a path assembled in subagent-registry.ts.
  "src/agents/subagents/registry/subagent-registry.runtime.ts!",
  // Loaded lazily by the sweeper only when a receipt-bearing or interrupted row is found.
  "src/agents/subagents/registry/subagent-registry-restart-recovery.ts!",
  // Task cancellation loads this control facade by string path to avoid a registry cycle.
  "src/tasks/task-registry-control.runtime.ts!",
  // Human plugin listing lazily loads its formatter to keep JSON startup lean.
  "src/cli/plugins-list-format.ts!",
  "src/infra/warning-filter.ts!",
  "src/infra/command-explainer/index.ts!",
  // Runtime modules loaded by path or namespace; static export tracing cannot see their contract.
  // Jiti virtualizes openclaw/plugin-sdk/agent-sessions through this cycle-safe barrel.
  "src/agents/sessions/extension-sdk.ts!",
  // Plugin-SDK ACP facades expose the registry's runtime signatures.
  "src/acp/runtime/registry.ts!",
  "src/plugins/runtime/index.ts!",
  "src/plugins/source-display.ts!",
  "src/mcp/codex-supervision-tools-serve.ts!",
  // Spawned by generated system-agent MCP configs; this stdio entry is not statically imported.
  "src/mcp/openclaw-tools-serve.ts!",
  // Spawned by ACPX and QA Lab from a generated plugin-tool MCP command line.
  "src/mcp/plugin-tools-serve.ts!",
  // Dedicated tsdown entry exercised against built plugin singletons.
  "src/plugins/build-smoke-entry.ts!",
  // Package-script owners invoke these generated-artifact modules directly.
  "src/config/doc-baseline.ts!",
  "src/plugins/runtime-sidecar-paths-baseline.ts!",
  // Imported by scripts/tsdown-build.mts as the AI package build configuration.
  "tsdown.ai.config.ts!",
  // Maintainer-owned compatibility data referenced by release/docs workflows.
  "src/commands/doctor/shared/deprecation-compat.ts!",
  // Compiled as the package-boundary failure canary by the extension checker.
  "src/plugins/contracts/rootdir-boundary-canary.ts!",
  // Mintlify executes every JavaScript file in the docs content directory on each page.
  "docs/nav-tabs-underline.js!",
  // Native applications load these JavaScript assets directly rather than through Node imports.
  "apps/android/app/src/main/assets/katex/katex.min.js!",
  "apps/android/app/src/main/assets/katex/renderer.js!",
  "apps/linux/ui/main.js!",
  "apps/linux/ui/quickchat.js!",
  "scripts/qa/render-maturity-docs.ts!",
  bundledPluginFile("telegram", "src/audit.ts", "!"),
  bundledPluginFile("telegram", "src/token.ts", "!"),
  "src/hooks/bundled/*/handler.ts!",
  "src/hooks/llm-slug-generator.ts!",
  // Local-only test-state consumers are modeled by the full-tree test scan.
  "src/plugin-sdk/!(test-state).ts!",
] as const;

const bundledPluginEntries = [
  "index.ts!",
  "setup-entry.ts!",
  // Setup APIs may lazy-load this top-level package artifact by string specifier.
  "setup-surface.ts!",
  // Core resolves these public plugin artifacts by basename rather than by a
  // static import from the plugin entry module.
  "*-api.ts!",
  "cli-metadata.ts!",
  "channel-entry.ts!",
  "configured-state.ts!",
  // Manifest and SDK loaders resolve these public artifacts by basename.
  "auth-presence.ts!",
  "thread-bindings-runtime.ts!",
  "document-extractor.ts!",
  "web-content-extractor.ts!",
  "timeouts.ts!",
  "action-runtime.runtime.ts!",
  "allow-from.ts!",
  // Provider catalogs and web tools resolve these manifest/convention-owned
  // modules from the plugin root at runtime.
  "provider-discovery.ts!",
  "{web-search,web-fetch}-provider.ts!",
  "{api,contract-api,helper-api,runtime-api,light-runtime-api,update-offset-runtime-api,channel-plugin-api,provider-plugin-api,setup-api}.ts!",
  "subagent-hooks-api.ts!",
  "src/{api,runtime-api,light-runtime-api,update-offset-runtime-api,channel-plugin-api,provider-plugin-api,doctor-contract,setup-surface,mcp-serve}.ts!",
  "src/subagent-hooks-api.ts!",
] as const;

const bundledPluginIgnoredRuntimeDependencies = [
  "@agentclientprotocol/claude-agent-acp",
  "@a2ui/lit",
  "@azure/identity",
  "@clawdbot/lobster",
  "@discord/embedded-app-sdk",
  "@discordjs/opus",
  "@homebridge/ciao",
  "@lit/context",
  "@matrix-org/matrix-sdk-crypto-wasm",
  "@mozilla/readability",
  "@openai/codex",
  "@pierre/theme",
  "@tloncorp/tlon-skill",
  "@agentclientprotocol/codex-acp",
  "jiti",
  "json5",
  "lit",
  "linkedom",
  "openclaw",
  "clawpdf",
] as const;

const rootBundledPluginRuntimeDependencies = [
  "@anthropic-ai/sdk",
  "@google/genai",
  "@grammyjs/runner",
  "@grammyjs/transformer-throttler",
  "@homebridge/ciao",
  "@mozilla/readability",
  "@silvia-odwyer/photon-node",
  "@trycua/cua-driver",
  "grammy",
  "linkedom",
  "minimatch",
  "node-edge-tts",
  "clawpdf",
] as const;

// Root installation and build workflows deliberately mirror these dependencies from their
// owning workspace, or invoke their package binaries/loaders without a static module import.
const rootToolingAndWorkspaceDependencies = [
  "@a2ui/lit",
  "@copilotkit/aimock",
  "@lit-labs/signals",
  "@lit/context",
  "@lit/task",
  // scripts/ui.mts anchors these lookups at ui/package.json before invoking the UI workspace.
  "@vitest/browser-playwright",
  "dompurify",
  // Root typecheck/test projects compile @openclaw/net-policy source directly.
  // Keep its exact dependency available without externalizing it from packaged builds.
  "ipaddr.js",
  "jscpd",
  "lit",
  // Runtime postbuild resolves this build input from its caller-selected root.
  "marked",
  "oxlint",
  "oxlint-tsgolint",
  // The scripts typecheck compiles UI Vite config against the root Vite dependency.
  "postcss",
  "signal-utils",
  // Root declaration builds compile terminal-core source and resolve this package from root.
  "string-width",
] as const;

function bundledPluginWorkspace(extraEntries: readonly string[] = []) {
  return {
    entry: [...bundledPluginEntries, ...extraEntries],
    project: ["**/*.{js,mjs,ts}!"],
    ignoreDependencies: bundledPluginIgnoredRuntimeDependencies,
  } as const;
}

// These files are test infrastructure, so their exports are intentionally
// available to tests without becoming part of the production dead-code scan.
const ignoredTestSupportFiles = [
  "**/__tests__/**",
  "**/test/**",
  "src/test-utils/**",
  "**/test-helpers/**",
  "**/test-fixtures/**",
  "**/test-support/**",
  "**/test-*.ts",
  "**/vitest*.{ts,mjs}",
  "**/*test-helpers.ts",
  "**/*test-fixtures.ts",
  "**/*test-harness.ts",
  "**/*test-utils.ts",
  "**/*test-support.ts",
  "**/*.test-loader.ts",
  "**/*.live-helpers.ts",
  "**/*.live-probe-helpers.ts",
  "**/*test-shared.ts",
  "**/*mocks.ts",
  "**/*.e2e-mocks.ts",
  "**/*.e2e-*.ts",
  "**/*.fixture-test-support.ts",
  "**/*.harness.ts",
  "**/*.job-fixtures.ts",
  "**/*.mock-harness.ts",
  "**/*.menu-test-support.ts",
  "**/*.suite-helpers.ts",
  "**/*.test-setup.ts",
  "**/job-fixtures.ts",
  "**/*test-mocks.ts",
  "**/*test-runtime*.ts",
  "**/*.mock-setup.ts",
  "**/*.cases.ts",
  "**/*.e2e-harness.ts",
  "**/*.fixture.ts",
  "**/*.fixtures.ts",
  "**/*.mocks.ts",
  "**/*.mocks.shared.ts",
  "**/*.route-test-support.ts",
  "**/*.shared-test.ts",
  "**/*.suite.ts",
  "**/*.test-runtime.ts",
  "**/*.testkit.ts",
  "**/*.test-fixtures.ts",
  "**/*.test-harness.ts",
  "**/*.test-helper.ts",
  "**/*.test-helpers.ts",
  "**/*.test-mocks.ts",
  "**/*.test-utils.ts",
  "test/helpers/live-image-probe.ts",
  // Legacy test-only owners whose filenames predate the test-support convention.
  "src/plugins/contracts/host-hook-fixture.ts",
  "src/plugins/contracts/tts-contract-suites.ts",
] as const;

const config = {
  ignoreFiles: [
    // Production mode excludes dev/maintainer executables. The full-tree
    // companion config removes this exclusion and audits them as script roots.
    "scripts/**",
    "dist/**",
    "packages/*/dist/**",
    // Declaration companions describe executable JavaScript modules; they are not standalone roots.
    "scripts/**/*.d.{mts,ts}",
    "**/live-*.ts",
    "src/shared/text/assistant-visible-text.ts",
    bundledPluginFile("telegram", "src/bot/reply-threading.ts"),
    bundledPluginFile("telegram", "src/draft-chunking.ts"),
  ],
  // Knip's `ignoreFiles` only suppresses unused-file findings. Test helpers
  // belong in `ignore` so they do not inflate unused-export/type findings.
  ignore: ["dist/**", "packages/*/dist/**", "**/.boundary-stubs/**", ...ignoredTestSupportFiles],
  // Script exports are checked with every script as an entry and entry-export
  // reporting enabled. Suppress them only in this application-production scan.
  ignoreIssues: {
    "scripts/**": ["exports", "nsExports", "types", "nsTypes", "enumMembers", "namespaceMembers"],
    // The full-tree companion config makes tests entrypoints; these contracts
    // are intentionally test-only in the production graph.
    "src/boards/board-notices.ts": ["exports"],
    "src/boards/board-store.ts": ["exports"],
    "src/gateway/board-view-ticket.ts": ["exports"],
    // Focused startup tests consume this explicit seam; production imports only the bootstrap.
    "src/gateway/server-startup-bootstrap.ts": ["exports"],
    // Registry facades retain direct registration/reset compatibility seams used by focused
    // tests; the full-tree scan still audits every named export against those consumers.
    "src/agents/harness/registry.ts": ["exports"],
    // Runtime reason values are exported now so protocol schemas can derive from one tuple later.
    "src/agents/failover/signal.ts": ["exports"],
    "src/context-engine/registry.ts": ["exports", "types"],
    "src/plugins/interactive-registry.ts": ["exports"],
    "src/plugins/memory-state.ts": ["exports", "types"],
    "src/plugins/session-discussion-registry.ts": ["exports"],
    "src/tasks/detached-task-runtime-state.ts": ["exports"],
    // Focused Control UI tests consume these explicit state-machine seams;
    // production uses them through their owning module/controller.
    "ui/src/pages/chat/chat-state-refresh.ts": ["exports"],
    "ui/src/pages/chat/composer-persistence.ts": ["exports"],
    // Focused media tests consume these explicit seams; production uses the helpers in-module.
    "src/agents/embedded-agent-subscribe.handlers.lifecycle.ts": ["exports"],
    "src/gateway/server-methods/chat-webchat-media.ts": ["exports"],
    // Greeting cache/fact contracts (hash, alert text, store shapes) are
    // asserted by the focused greeting unit tests, not by another prod module.
    "src/system-agent/greeting.ts": ["exports", "types"],
    // Focused tests consume these diagnostic/test seams; production code uses
    // the surrounding runtime helpers rather than importing the exports.
    "extensions/signal/src/setup-core.ts": ["exports"],
    // Focused CLI tests exercise plan construction through this explicit test seam.
    "extensions/onepassword/src/secret-ref-cli.ts": ["exports"],
    // Mirror config parsing, redaction mapping, cap fitting, and the runner are
    // asserted by the focused Beam mirror tests; production wires only the service.
    "extensions/beam/src/mirror.ts": ["exports", "types"],
    "src/infra/heartbeat-wake.ts": ["exports"],
  },
  workspaces: {
    ".": {
      ignoreDependencies: [
        "@openclaw/*",
        // Cloudflare template dependency: declared in scripts/cloudflare/package.json
        // (isolated deploy tooling), not in the root manifest.
        "@cloudflare/containers",
        // Docker packaging stages @openclaw/ai without nested dependencies after
        // verifying the root owns its exact runtime dependency versions.
        "@mistralai/mistralai",
        "openai",
        "cross-spawn",
        "file-type",
        // Loaded via createRequire in src/agents/utils/syntax-highlight.ts because its
        // d.ts force-includes lib.dom; knip cannot see the dynamic require.
        "highlight.js",
        "playwright-core",
        "partial-json",
        // The native Canvas bundle falls back without optional Markdown support.
        "@a2ui/markdown-it",
        "sqlite-vec",
        "tree-sitter-bash",
        ...rootToolingAndWorkspaceDependencies,
        ...rootBundledPluginRuntimeDependencies,
      ],
      // Platform tools, installed CLIs, and shell builtins used by scripts and boundary tests.
      ignoreBinaries: ["mint", "ngrok", "open", "openclaw", "sleep", "xcrun"],
      // The stylelint config lives under config/, not a root default path.
      stylelint: { config: ["config/stylelint.config.mjs"] },
      project: [
        ".github/actions/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "apps/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "config/**/*.{ts,mts,cts}!",
        "docs/**/*.js!",
        "security/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "skills/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "src/**/*.ts!",
        "scripts/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "test/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "*.config.{js,mjs,cjs,ts,mts,cts}!",
        "*.mjs!",
      ],
      entry: rootEntries,
    },
    "examples/ai-chat": {
      entry: ["index.mjs!"],
      project: ["**/*.{js,mjs,cjs,ts,mts,cts}!"],
    },
    "qa/convex-credential-broker": {
      // Convex discovers these registered functions and schemas by filename.
      entry: ["convex/credentials.ts!", "convex/crons.ts!", "convex/http.ts!", "convex/schema.ts!"],
      // This intentionally standalone package is not linked into the pnpm workspace.
      ignoreBinaries: ["convex"],
      project: ["convex/**/*.ts!"],
    },
    ui: {
      entry: [
        "index.html!",
        "src/main.ts!",
        "src/lib/browser-redact.ts!",
        "vite.config.ts!",
        "vitest*.ts!",
      ],
      // Workboard lazy-loads Three.js at runtime; Knip's dependency pass misses it.
      ignoreDependencies: ["three"],
      project: ["src/**/*.{ts,tsx}!"],
    },
    "packages/ai": {
      // Mirror the published export map so knip sees every dist entry point.
      entry: [
        "src/index.ts!",
        "src/provider-types.ts!",
        "src/providers.ts!",
        "src/types.ts!",
        "src/validation.ts!",
        "src/utils/diagnostics.ts!",
        "src/utils/event-stream.ts!",
        "src/internal/*.ts!",
      ],
      project: ["src/**/*.ts!"],
    },
    "packages/sdk": {
      entry: ["src/index.ts!"],
      project: ["src/**/*.ts!"],
    },
    "packages/agent-core": {
      entry: [
        "src/index.ts!",
        "src/agent.ts!",
        "src/agent-loop.ts!",
        "src/llm.ts!",
        "src/runtime-deps.ts!",
        "src/validation.ts!",
        "src/types.ts!",
        "src/harness/messages.ts!",
        "src/harness/env/kill-tree.ts!",
        "src/harness/prompt-template-arguments.ts!",
        "src/harness/utils/truncate.ts!",
      ],
      project: ["src/**/*.ts!"],
    },
    "packages/gateway-client": {
      // Mirror package.json exports; these subpaths are published surfaces.
      entry: ["src/index.ts!", "src/readiness.ts!", "src/timeouts.ts!"],
      project: ["src/**/*.ts!"],
    },
    "packages/gateway-protocol": {
      // Mirror package.json exports; these subpaths are published surfaces.
      entry: [
        "src/index.ts!",
        "src/client-info.ts!",
        "src/connect-error-details.ts!",
        "src/frame-guards.ts!",
        "src/schema.ts!",
        "src/startup-unavailable.ts!",
        "src/version.ts!",
      ],
      project: ["src/**/*.ts!"],
    },
    "packages/model-catalog-core": {
      // Mirror the published export map so package-owned runtime dependencies
      // are traced from the TypeScript sources instead of the JS fallback.
      entry: [
        "src/index.ts!",
        "src/configured-model-refs.ts!",
        "src/model-catalog-normalize.ts!",
        "src/model-catalog-refs.ts!",
        "src/model-catalog-types.ts!",
        "src/provider-id.ts!",
        "src/provider-model-id-normalization.ts!",
        "src/provider-model-id-normalize.ts!",
      ],
      project: ["src/**/*.ts!"],
    },
    "packages/normalization-core": {
      // Mirror package.json exports; root and UI builds consume these source subpaths directly.
      entry: [
        "src/index.ts!",
        "src/agent-id.ts!",
        "src/boolean-coercion.ts!",
        "src/browser-error-runtime.ts!",
        "src/error-coercion.ts!",
        "src/expect.ts!",
        "src/json-coercion.ts!",
        "src/number-coercion.ts!",
        "src/phone-presentation.ts!",
        "src/record-coerce.ts!",
        "src/result.ts!",
        "src/string-coerce.ts!",
        "src/string-normalization.ts!",
        "src/utf16-slice.ts!",
      ],
      project: ["src/**/*.ts!"],
    },
    "packages/net-policy": {
      entry: ["src/index.ts!", "src/ip.ts!"],
      project: ["src/**/*.ts!"],
    },
    "packages/markdown-core": {
      entry: [
        "src/index.ts!",
        "src/code-spans.ts!",
        "src/fences.ts!",
        "src/frontmatter.ts!",
        "src/ir.ts!",
        "src/render.ts!",
        "src/render-aware-chunking.ts!",
        "src/tables.ts!",
        "src/types.ts!",
      ],
      project: ["src/**/*.ts!"],
    },
    "packages/media-core": {
      entry: [
        "src/index.ts!",
        "src/attachment-classify.ts!",
        "src/base64.ts!",
        "src/constants.ts!",
        "src/content-length.ts!",
        "src/file-name.ts!",
        "src/inbound-path-policy.ts!",
        "src/inline-image-data-url.ts!",
        "src/media-source-url.ts!",
        "src/mime.ts!",
        "src/read-byte-stream-with-limit.ts!",
      ],
      project: ["src/**/*.ts!"],
    },
    "packages/acp-core": {
      entry: [
        "src/index.ts!",
        "src/meta.ts!",
        "src/session.ts!",
        "src/session-interaction-mode.ts!",
        "src/session-lineage-meta.ts!",
        "src/types.ts!",
        "src/runtime/error-text.ts!",
        "src/runtime/errors.ts!",
        "src/runtime/session-identifiers.ts!",
        "src/runtime/session-identity.ts!",
        "src/runtime/types.ts!",
      ],
      project: ["src/**/*.ts!"],
    },
    "packages/terminal-core": {
      entry: [
        "src/index.ts!",
        "src/ansi.ts!",
        "src/decorative-emoji.ts!",
        "src/health-style.ts!",
        "src/links.ts!",
        "src/note.ts!",
        "src/osc-progress.ts!",
        "src/palette.ts!",
        "src/progress-line.ts!",
        "src/prompt-select-styled.ts!",
        "src/prompt-select-styled-params.ts!",
        "src/prompt-style.ts!",
        "src/restore.ts!",
        "src/safe-text.ts!",
        "src/stream-writer.ts!",
        "src/table.ts!",
        "src/terminal-link.ts!",
        "src/theme.ts!",
      ],
      project: ["src/**/*.ts!"],
    },
    "packages/memory-host-sdk": {
      entry: ["src/*.ts!", "src/host/embeddings.types.ts!"],
      project: ["src/**/*.ts!"],
    },
    "packages/*": {
      entry: ["index.js!", "scripts/postinstall.js!"],
      project: ["index.js!", "scripts/**/*.js!"],
    },
    [`${BUNDLED_PLUGIN_ROOT_DIR}/amazon-bedrock-mantle`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/amazon-bedrock`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/anthropic`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/anthropic-vertex`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/acpx`]: bundledPluginWorkspace([
      // Copied as executable runtime internals by the package artifact manifest.
      "src/runtime-internals/mcp-command-line.mjs!",
      "src/runtime-internals/mcp-proxy.mjs!",
      // Spawned by the real-process elicitation regression through CODEX_PATH.
      "test/fixtures/codex-app-server.mjs!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/azure-speech`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/browser`]: bundledPluginWorkspace([
      // Core and plugin-SDK facades resolve these shipped Browser surfaces by basename.
      "browser-control-auth.ts!",
      "browser-config.ts!",
      "browser-doctor.ts!",
      "browser-maintenance.ts!",
      "browser-profiles.ts!",
      // Built by tsdown as the native messaging executable; Chrome launches it by path.
      "native-host-entry.ts!",
      "relay-daemon-entry.ts!",
      // Chrome manifest/package scripts load these without TypeScript imports.
      "chrome-extension/background.js!",
      "chrome-extension/options.js!",
      "chrome-extension/popup.js!",
      "scripts/copy-chrome-extension.mjs!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/canvas`]: bundledPluginWorkspace([
      // Package build/copy scripts are invoked from package.json.
      "scripts/bundle-a2ui.mjs!",
      "scripts/copy-a2ui.mjs!",
      "scripts/pnpm-runner.mjs!",
      // Rolldown consumes this config and its browser bootstrap entry.
      "src/host/a2ui-app/rolldown.config.mjs!",
      "src/host/a2ui-app/bootstrap.js!",
      "src/host/a2ui-app/bootstrap-v0.9.js!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/cloudflare-ai-gateway`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/chutes`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/clawrouter`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/cohere`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/comfy`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/copilot`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/copilot-proxy`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/codex`]: bundledPluginWorkspace([
      // Provider runtime and harness surfaces are reached through plugin
      // registration contracts rather than static imports from the entrypoint.
      "harness.ts!",
      "media-understanding-provider.ts!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/deepgram`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/deepinfra`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/discord`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/diffs`]: bundledPluginWorkspace([
      // scripts/build-diffs-viewer-runtime.mts bundles this browser entry.
      "src/viewer-client.ts!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/elevenlabs`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/featherless`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/fal`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/fireworks`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/google`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/huggingface`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/github-copilot`]: bundledPluginWorkspace([
      // Auth, replay, token, and stream helpers are runtime-owned provider
      // surfaces consumed through plugin hooks and dynamic imports.
      "connection-bound-ids.ts!",
      "login.ts!",
      "stream.ts!",
      "token.ts!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/kilocode`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/kimi-coding`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/matrix`]: bundledPluginWorkspace([
      // The monitor lazy-loads outbound behavior on inbound-only processes.
      "src/matrix/send.ts!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/microsoft`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/memory-core`]: bundledPluginWorkspace([
      // The subprocess boundary tests spawn this fixture by computed URL.
      "src/memory/fixtures/manager-search-knn-child.fixture.mjs!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/memory-lancedb`]: {
      ...bundledPluginWorkspace(),
      // LanceDB declares Arrow as a peer; the plugin provides it for runtime table values.
      ignoreDependencies: [...bundledPluginIgnoredRuntimeDependencies, "apache-arrow"],
    },
    [`${BUNDLED_PLUGIN_ROOT_DIR}/microsoft-foundry`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/migrate-claude`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/migrate-hermes`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/minimax`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/mistral`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/moonshot`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/mxc`]: bundledPluginWorkspace([
      // Copied to dist and spawned by the MXC backend.
      "src/mxc-spawn-launcher.mjs!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/nvidia`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/openai`]: bundledPluginWorkspace([
      // OpenAI exposes provider, OAuth, overlay, media, usage, and realtime
      // contracts to runtime/plugin integration paths that Knip cannot trace.
      "embedding-batch.ts!",
      "media-understanding-provider.ts!",
      "model-route-contract.ts!",
      "native-web-search.ts!",
      "openai-chatgpt-oauth-flow.runtime.ts!",
      "openai-chatgpt-oauth.runtime.ts!",
      "openai-chatgpt-provider.runtime.ts!",
      "openai-provider.ts!",
      "prompt-overlay.ts!",
      "realtime-provider-shared.ts!",
      "tts.ts!",
      "usage.ts!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/onepassword`]: bundledPluginWorkspace([
      // Shipped resolver child process declared as a static plugin artifact.
      "onepassword-secret-ref-resolver.js!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/opencode`]: bundledPluginWorkspace([
      // Session catalog and provider helpers are plugin-owned runtime surfaces.
      "media-understanding-provider.ts!",
      "provider-catalog.ts!",
      "session-catalog-plugin.ts!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/opencode-go`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/openrouter`]: bundledPluginWorkspace([
      // OAuth, model, and media provider helpers are runtime/plugin surfaces.
      "image-generation-provider.ts!",
      "media-understanding-provider.ts!",
      "models.ts!",
      "oauth.ts!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/pixverse`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/qianfan`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/qwen`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/qa-lab`]: bundledPluginWorkspace([
      // Core loads the CLI facade by basename; QA Lab also owns a nested Vite app.
      "cli.ts!",
      "web/index.html!",
      "web/src/app.ts!",
      "web/src/main.ts!",
      "web/vite.config.ts!",
      // Imported directly from the GitHub Actions smoke-plan script.
      "src/ci-smoke-plan.ts!",
      // Imported directly from the GitHub Actions evidence workflow.
      "src/profile-evidence-sharding.ts!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/senseaudio`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/tavily`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/tencent`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/vllm`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/vault`]: bundledPluginWorkspace([
      // Shipped resolver child process declared as a static plugin artifact.
      "vault-secret-ref-resolver.js!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/voyage`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/whatsapp`]: {
      ...bundledPluginWorkspace(),
      // Baileys loads its optional audio decoder at runtime for supported media.
      ignoreDependencies: [...bundledPluginIgnoredRuntimeDependencies, "audio-decode"],
    },
    [`${BUNDLED_PLUGIN_ROOT_DIR}/xiaomi`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/xai`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/llama-cpp`]: {
      entry: bundledPluginEntries,
      project: ["**/*.{js,mjs,ts}!"],
      ignoreDependencies: bundledPluginIgnoredRuntimeDependencies,
    },
    [`${BUNDLED_PLUGIN_ROOT_DIR}/lmstudio`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/reef`]: {
      // Reef vendors its wire protocol under protocol/, which owns the noble
      // crypto dependencies. The protocol barrel is the vendored library's
      // public surface, so its exports are intentional even where the channel
      // consumes only a subset.
      entry: [...bundledPluginEntries, "protocol/index.ts!"],
      project: ["**/*.{js,mjs,ts}!"],
      ignoreDependencies: bundledPluginIgnoredRuntimeDependencies,
    },
    [`${BUNDLED_PLUGIN_ROOT_DIR}/*`]: {
      // Bundled plugins often load their public surface via string specifiers in
      // `index.ts` contracts, so Knip needs these convention-based entry files.
      entry: bundledPluginEntries,
      project: ["**/*.{js,mjs,ts}!"],
      ignoreDependencies: bundledPluginIgnoredRuntimeDependencies,
    },
  },
} as const;

export default config;

/**
 * Single Knip config, zero `ignore` patterns.
 *
 *   knip --config config/knip.config.ts --production   → production dead-code scan
 *   knip --config config/knip.config.ts                → full-tree export audit
 *
 * Extensions are covered by the built-in `openclaw` plugin (reads the `openclaw`
 * package.json manifest + resolves public surfaces by convention). Test-support
 * and scripts are scoped out of the production graph with production-only project
 * negations (`!…!`) instead of `ignore`, so the full-tree run still audits them.
 *
 * A negation drops a file from the production graph, so it also stops counting
 * as a consumer. Keep them anchored to real test-support names: a repo-wide
 * `live-` prefix or `-test-` infix glob swallows production owners too, and
 * their exports then read as unused.
 */

import { listQaScenarioExecutionEntries } from "./knip.all-exports.config.ts";

// Package scripts, workflows, Docker scenarios, and documented maintainer commands invoke these
// files by path. They are executable roots rather than importable library modules.
const repositoryScriptEntries = [
  // setup-node-env invokes this helper from composite-action YAML.
  ".github/actions/setup-node-env/dependency-fingerprint.mjs!",
  ".github/actions/setup-node-env/verify-importers.mjs!",
  ".github/actions/register-bind-mount-cleanup/main.cjs!",
  ".github/actions/register-bind-mount-cleanup/post.cjs!",
  "apps/android/scripts/build-release-artifacts.ts!",
  "scripts/check-live-cache.ts!",
  "scripts/check-package-dist-imports.mjs!",
  "scripts/dev/ios-node-e2e.ts!",
  "scripts/diffs-shiki-curated.ts!",
  "scripts/e2e/lib/browser-cdp-snapshot/assert-snapshot.mjs!",
  "scripts/e2e/lib/browser-cdp-snapshot/fixture-server.mjs!",
  "scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs!",
  "scripts/e2e/lib/clawhub-fixture-server.cjs!",
  "scripts/e2e/lib/codex-media-path/client.mjs!",
  "scripts/e2e/lib/codex-media-path/fake-codex-app-server.mjs!",
  "scripts/e2e/lib/codex-media-path/write-config.mjs!",
  "scripts/e2e/lib/codex-npm-plugin-live/followthrough-turn.mjs!",
  "scripts/e2e/lib/config-reload/assert-log.mjs!",
  "scripts/e2e/lib/config-reload/mutate-metadata.mjs!",
  "scripts/e2e/lib/docker-artifact-proof/write-identities.ts!",
  "scripts/e2e/lib/docker-stats/assert-resource-ceiling.mjs!",
  "scripts/e2e/lib/doctor-install-switch/write-wrapper.mjs!",
  "scripts/e2e/lib/fixture.mjs!",
  "scripts/e2e/lib/fixtures/config.mjs!",
  "scripts/e2e/lib/fixtures/plugins.mjs!",
  "scripts/e2e/lib/fixtures/workspace.mjs!",
  "scripts/e2e/lib/npm-telegram-live/prepare-package.mjs!",
  "scripts/e2e/lib/onboard/assert-config.mjs!",
  "scripts/e2e/lib/onboard/write-config.mjs!",
  "scripts/e2e/lib/openai-chat-tools/client.mjs!",
  "scripts/e2e/lib/openai-chat-tools/write-config.mjs!",
  "scripts/e2e/lib/package-git-fixture.mjs!",
  "scripts/e2e/lib/parallels-package/build-info-commit.mjs!",
  "scripts/e2e/lib/parallels-package/log-progress-extract.mjs!",
  "scripts/e2e/lib/plugin-lifecycle-matrix/measure.mjs!",
  "scripts/e2e/lib/plugin-update/registry-server.mjs!",
  "scripts/e2e/lib/plugins/npm-registry-server.mjs!",
  "scripts/e2e/lib/release-scenarios/write-cli-plugin.mjs!",
  "scripts/e2e/lib/release-scenarios/write-marketplace.mjs!",
  "scripts/e2e/lib/release-user-journey/clickclack-fixture.mjs!",
  "scripts/e2e/lib/release-user-journey/write-clickclack-plugin.mjs!",
  "scripts/e2e/lib/run-with-pty.mjs!",
  "scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs!",
  "scripts/embedded-run-abort-leak.ts!",
  "scripts/fixtures/packed-plugin-sdk-type-smoke.ts!",
  "scripts/ios-release-cut.ts!",
  "scripts/ios-release-plan.ts!",
  "scripts/ios-release-signing.mjs!",
  "scripts/lib/docker-plugin-selection.mjs!",
  "scripts/lib/openclaw-test-state.mjs!",
  "scripts/list-prod-store-packages.mjs!",
  // Invoked by scripts/lib/live-docker-stage.sh during container validation.
  "scripts/live-docker-normalize-config.ts!",
  "scripts/mcp-code-mode-gateway-e2e.ts!",
  "scripts/openclaw-release-clawhub-plan.ts!",
  "scripts/openclaw-release-clawhub-runtime-state.ts!",
  // Oxlint loads this JS plugin by path from config/oxlint/boundary-guards.json.
  "scripts/oxlint-boundary-guards.mjs!",
  "scripts/plugin-prerelease-liveish-matrix.mjs!",
  // Generates the checked-in native protocol models from core descriptor metadata.
  "scripts/protocol-gen.ts!",
  "scripts/pr-gates-lock.mjs!",
  "scripts/pr-lib/ci-dispatch.mjs!",
  "scripts/pr-lib/review-artifacts.mjs!",
  "scripts/pr-lib/process-group-runner.mjs!",
  "scripts/pre-commit/filter-staged-files.mjs!",
  "scripts/qa-coverage-report.ts!",
  "scripts/qa-parity-report.ts!",
  "scripts/repro/tsx-name-repro.ts!",
  "scripts/resolve-frozen-codex-live-suite.mjs!",
  "scripts/secrets/openclaw-bws-resolver.mjs!",
  "scripts/sync-labels.ts!",
  "scripts/test-built-bundled-channel-entry-smoke.mjs!",
  "scripts/update-clawtributors.ts!",
  "scripts/verify-stable-main-closeout.mjs!",
  "scripts/write-package-dist-inventory.ts!",
  "scripts/write-plugin-sdk-entry-dts.ts!",
  "security/opengrep/check-rule-metadata.mjs!",
  "security/opengrep/compile-rules.mjs!",
  "skills/meme-maker/scripts/meme.mjs!",
] as const;

const rootEntries = [
  ...repositoryScriptEntries,
  "src/cli/daemon-cli.ts!",
  "src/agents/code-mode.worker.ts!",
  // Worker-thread and script entrypoints import contracts that production Knip cannot trace.
  "src/agents/compaction-planning.worker.ts!",
  "scripts/print-cli-backend-live-metadata.ts!",
  "scripts/repro/code-mode-namespace-live.ts!",
  "scripts/repro/tool-schema-hint-bench.ts!",
  "scripts/repro/tool-surface-live-bench.ts!",
  // Workflow/package-script entrypoints are not imported from production modules.
  "scripts/openclaw-cross-os-release-checks.ts!",
  "scripts/bench-transcript-cursors.ts!",
  "scripts/bench-sqlite-reliability.ts!",
  // Docker/manual E2E executables and their nested assertion/probe entrypoints.
  "scripts/e2e/*.{js,mjs,ts}!",
  "scripts/e2e/lib/**/{assertions,probe,mock-server}.{js,mjs,ts}!",
  "src/audit/audit-event-writer.worker.ts!",
  "src/state/openclaw-database-verify.worker.ts!",
  "src/agents/model-provider-auth.worker.ts!",
  // Loaded by URL from setup-inference-detection.ts; no static import edge exists.
  "src/system-agent/setup-inference-detection.worker.ts!",
  // Split runtime loaded through a path assembled in subagent-registry.ts.
  "src/agents/subagent-registry.runtime.ts!",
  // Loaded lazily by the registry; its callbacks form the orphan-recovery runtime contract.
  "src/agents/subagent-orphan-recovery.ts!",
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
  // Imported by scripts/tsdown-build.mjs as the AI package build configuration.
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
  "apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/CanvasA2UI/a2ui.bundle.js!",
  "scripts/qa/render-maturity-docs.ts!",
  "extensions/telegram/src/audit.ts!",
  "extensions/telegram/src/token.ts!",
  "src/hooks/bundled/*/handler.ts!",
  "src/hooks/llm-slug-generator.ts!",
  "src/plugin-sdk/*.ts!",
] as const;

export const bundledPluginEntries = [
  // Core resolves these public plugin artifacts by basename rather than by a
  // static import from the plugin entry module.
  "*-api.ts!",
  "cli-metadata.ts!",
  "channel-entry.ts!",
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
  "@anthropic-ai/vertex-sdk",
  "@google/genai",
  "@grammyjs/runner",
  "@grammyjs/transformer-throttler",
  "@homebridge/ciao",
  "@mozilla/readability",
  "@silvia-odwyer/photon-node",
  "@slack/bolt",
  "@slack/types",
  "@slack/web-api",
  "grammy",
  "linkedom",
  "minimatch",
  "node-edge-tts",
  "openshell",
  "clawpdf",
  "tokenjuice",
] as const;

// Root installation and build workflows deliberately mirror these dependencies from their
// owning workspace, or invoke their package binaries/loaders without a static module import.
const rootToolingAndWorkspaceDependencies = [
  "@a2ui/lit",
  "@copilotkit/aimock",
  "@lit-labs/signals",
  "@lit/context",
  // scripts/ui.js anchors these lookups at ui/package.json before invoking the UI workspace.
  "@vitest/browser-playwright",
  "dompurify",
  // Root typecheck/test projects compile @openclaw/net-policy source directly.
  // Keep its exact dependency available without externalizing it from packaged builds.
  "ipaddr.js",
  "jscpd",
  "lit",
  "oxlint",
  "oxlint-tsgolint",
  "signal-utils",
] as const;

const fullTreeTestEntries = [
  "test/e2e/qa-lab/runtime/agent-bundle-mcp-tools-docker-client.ts",
  "test/e2e/qa-lab/runtime/docker-e2e-lane.ts",
  "test/e2e/qa-lab/runtime/mcp-channels-docker-client.ts",
  "test/e2e/qa-lab/runtime/openai-image-auth-docker-client.ts",
  "test/e2e/qa-lab/runtime/system-agent-first-run-docker-client.ts",
  "test/e2e/qa-lab/runtime/fixtures/voice-call-runtime-plugin/index.js",
  "test/fixtures/oxlint-boundary-guards/*.ts",
  "test/vitest/*-runtime.ts",
];

// Test-support helpers: excluded from the production graph only, so the
// full-tree run still audits their exports. Structural scope, not `ignore`.
// (OpenClaw could collapse these to ~2 patterns by standardizing on
// `test-support/` dirs + a `*.test-support.ts` suffix.)
const testSupportSuffixes =
  "!**/*.{test-support,test-helpers,test-helper,test-harness,test-utils,test-fixtures,test-mocks,test-shared,test-setup,test-runtime,test-runtime-mocks,test-loader,fixture,fixtures,harness,mocks,cases,suite,e2e-harness,e2e-mocks,e2e-registry-helpers,e2e-ws-harness,live-helpers,live-probe-helpers,shared-test,mock-setup,mock-harness,fast-path-mocks,suite-helpers,job-fixtures,route-test-support,menu-test-support,fixture-test-support}.{ts,mts,cts}!";
const testSupport = [
  "!**/test/**!",
  "!**/{test-support,test-helpers,test-utils,test-fixtures}/**!",
  "!**/{test-support,test-helpers,test-fetch}.{ts,mts,cts}!",
  "!**/.boundary-stubs/**", // generated boundary type stubs (excluded in both modes)
  "!**/src/**/test-*.{ts,mts,cts}!", // `test-*` helpers under src (top-level `test-api` surfaces stay)
  // Suffix-anchored, never a bare `-test-` infix: that also drops production
  // owners such as `src/commands/channel-test-registry.ts`.
  "!**/*-{test-helpers,test-support,test-harness,test-fixtures,test-utils,test-mocks}.{ts,mts,cts}!",
  "!**/*.mocks.shared.{ts,mts,cts}!",
  testSupportSuffixes,
];
// The root tree also uses a `test-*` filename prefix for test infra. `live-*`
// stays directory-anchored: repo-wide it also eats the production owners
// `worker-environments/live-events.ts` and `workboard/live-refresh.ts`.
const rootTestSupport = [
  ...testSupport,
  "!**/test-*.{ts,mts,cts}!",
  "!src/agents/live-*.{ts,mts,cts}!",
  "!src/gateway/live-*.{ts,mts,cts}!",
];

const rootIgnoreDependencies = [
  "@openclaw/*",
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
  // Optional runtime imports: the native Canvas bundle falls back without Markdown,
  // and the meme-maker skill emits SVG when sharp is not installed.
  "@a2ui/markdown-it",
  "sharp",
  "sqlite-vec",
  "tree-sitter-bash",
  // Plugin-owned packages that root test mocks and Vitest runtime shims import.
  "baileys",
  "discord-api-types",
  ...rootToolingAndWorkspaceDependencies,
  ...rootBundledPluginRuntimeDependencies,
];

// Production modules whose remaining exports are test-only contracts: reset/drain
// hooks, in-memory doubles, assertion helpers. Listed per issue type so the other
// class still bites, and read by both scans, so a file here also stops reporting
// dead test-tree exports. Shrink this by moving them to `*-test-support` owners.
const testOnlyProductionContracts = {
  "extensions/qa-lab/src/evidence-summary.ts": ["exports"],
  "extensions/qa-lab/src/fixture-utils.ts": ["exports", "types"],
  "src/agents/agent-tools.before-tool-call.state.ts": ["exports"],
  "src/agents/session-write-lock.ts": ["exports"],
  "src/boards/board-notices.ts": ["exports"],
  "src/boards/board-store.ts": ["exports"],
  "src/channels/plugins/types.public.ts": ["types"],
  "src/config/sessions/store-writer-state.ts": ["exports"],
  "src/gateway/board-view-ticket.ts": ["exports"],
  "src/infra/outbound/delivery-queue.ts": ["types"],
  "src/media/png-encode.ts": ["exports"],
  "src/plugins/min-host-version.ts": ["exports"],
  "src/plugins/runtime-sidecar-paths.ts": ["exports"],
  "src/system-agent/greeting.ts": ["exports", "types"],
  "ui/src/lib/board/provider.ts": ["exports"],
  // Test and E2E callers reach these hooks through runtime.test-support.ts;
  // the full-tree companion config still audits their actual consumers.
  "src/commitments/runtime.ts": ["exports"],
  // Focused tests consume these diagnostic/test seams; production code uses
  // the surrounding runtime helpers rather than importing the exports.
  "extensions/signal/src/setup-core.ts": ["exports"],
  "src/infra/heartbeat-wake.ts": ["exports"],
};

const pluginWorkspace = (entry: string[] = [], extraIgnoredDependencies: string[] = []) => ({
  entry: [...bundledPluginEntries, ...entry],
  project: ["**/*.{js,mjs,ts}!", ...testSupport],
  ignoreDependencies: [...extraIgnoredDependencies, ...bundledPluginIgnoredRuntimeDependencies],
});

export default {
  ignoreIssues: testOnlyProductionContracts,
  // Absolute-path specifiers are external files (OS binaries run via child_process, e.g. macOS-only
  // /usr/bin/security), never JS module imports, so they don't resolve on the Linux CI filesystem.
  ignoreUnresolved: [/^\//],
  workspaces: {
    ".": {
      entry: [
        ...rootEntries,
        ...listQaScenarioExecutionEntries(),
        ...fullTreeTestEntries,
        ".agents/skills/**/scripts/**/*.{js,mjs,cjs,ts,mts,cts}",
        "**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}",
        "test/helpers/config/bundled-channel-config-runtime.ts",
        "test/non-isolated-runner.ts",
        "test/vitest/vitest*.config.ts",
      ],
      project: [
        "src/**/*.ts!",
        ".github/actions/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "apps/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "config/**/*.{ts,mts,cts}!",
        "docs/**/*.js!",
        "security/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "skills/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "*.config.{js,mjs,cjs,ts,mts,cts}!",
        "*.mjs!",
        "test/**/*.{js,mjs,cjs,ts,mts,cts}",
        "!test/fixtures/ts-topology/basic/**",
        // Dev tooling: audited in the full-tree run, out of the production graph.
        "scripts/**/*.{js,mjs,cjs,ts,mts,cts}",
        "!scripts/**!",
        ...rootTestSupport,
        "!**/*.d.{ts,mts,cts}",
        ".agents/skills/**/scripts/**/*.{js,mjs,cjs,ts,mts,cts}",
        // Test-only / generated owners whose bare names predate any convention.
        "!**/job-fixtures.{ts,mts,cts}!",
        "!src/plugins/contracts/{host-hook-fixture,tts-contract-suites}.ts!",
        "!src/secrets/credential-matrix.ts!",
      ],
      // Platform tools and shell builtins spawned by tests, workflows, and dev
      // scripts; a missing one fails its own caller loudly. Package scripts
      // naming an undeclared binary stay reported.
      ignoreBinaries: [
        "mint",
        "ngrok",
        "go",
        "jarsigner",
        "keytool",
        "mkfifo",
        "openclaw",
        "realpath",
        "say",
        "sqlite3",
        "zsh",
        "zstd",
      ],
      ignoreDependencies: rootIgnoreDependencies,
      ignoreUnresolved: ["./gradlew"], // Android wrapper resolved at build time
    },
    "qa/convex-credential-broker": {
      entry: ["convex/credentials.ts!", "convex/crons.ts!", "convex/http.ts!", "convex/schema.ts!"],
      ignoreBinaries: ["convex"],
      project: ["convex/**/*.ts!"],
    },
    ui: {
      entry: ["src/lib/browser-redact.ts!"],
      project: ["src/**/*.{ts,tsx}!", ...rootTestSupport],
      ignoreDependencies: ["three"],
    },
    // Packages whose published surface is wider than their package.json
    // `exports` map (public API consumed across workspaces / by SDK consumers).
    "packages/ai": {
      entry: [
        "src/index.ts!",
        "src/providers.ts!",
        "src/types.ts!",
        "src/validation.ts!",
        "src/utils/diagnostics.ts!",
        "src/utils/event-stream.ts!",
        "src/internal/*.ts!",
      ],
      project: ["**/*.ts!", ...testSupport],
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
      project: ["**/*.ts!", ...testSupport],
    },
    "packages/gateway-protocol": {
      entry: [
        "src/index.ts!",
        "src/client-info.ts!",
        "src/connect-error-details.ts!",
        "src/frame-guards.ts!",
        "src/schema.ts!",
        "src/startup-unavailable.ts!",
        "src/version.ts!",
      ],
      project: ["**/*.ts!", ...testSupport],
    },
    "packages/speech-core": {
      entry: ["runtime-api.ts!", "speaker.ts!", "voice-models.ts!"],
      project: ["**/*.ts!", ...testSupport],
      ignoreDependencies: ["openclaw"],
    },
    "packages/memory-host-sdk": {
      entry: ["src/*.ts!", "src/host/embeddings-worker-child.ts!"],
      project: ["**/*.ts!", ...testSupport],
    },
    "packages/media-understanding-common": {
      entry: ["src/*.ts!"],
      project: ["**/*.ts!", ...testSupport],
    },
    "packages/tool-call-repair": { entry: ["src/*.ts!"], project: ["**/*.ts!", ...testSupport] },
    "packages/*": {
      project: ["**/*.ts!", ...testSupport],
      ignoreDependencies: ["@openclaw/normalization-core", "ws"],
    },
    "extensions/anthropic": pluginWorkspace(["cli-api.ts!"]),
    "extensions/qa-lab": pluginWorkspace([
      "cli.ts!",
      "web/index.html!",
      "web/src/app.ts!",
      "web/src/main.ts!",
      "web/vite.config.ts!",
      "src/ci-smoke-plan.ts!",
    ]),
    "extensions/browser": pluginWorkspace([
      "browser-control-auth.ts!",
      "browser-config.ts!",
      "browser-doctor.ts!",
      "browser-host-inspection.ts!",
      "browser-maintenance.ts!",
      "browser-profiles.ts!",
      "chrome-extension/background.js!",
      "chrome-extension/popup.js!",
      "chrome-extension/sidepanel.js!",
      "scripts/copilot-runtime-entry.ts!",
    ]),
    "extensions/canvas": pluginWorkspace([
      "scripts/pnpm-runner.mjs!",
      "src/host/a2ui-app/rolldown.config.mjs!",
      "src/host/a2ui-app/bootstrap.js!",
    ]),
    "extensions/codex": pluginWorkspace(["harness.ts!", "media-understanding-provider.ts!"]),
    "extensions/diffs": pluginWorkspace(["src/viewer-client.ts!"]),
    "extensions/github-copilot": pluginWorkspace([
      "connection-bound-ids.ts!",
      "login.ts!",
      "stream.ts!",
      "token.ts!",
    ]),
    // The provider resolves node-llama-cpp from its own package at runtime.
    "extensions/llama-cpp": pluginWorkspace([], ["node-llama-cpp"]),
    "extensions/matrix": pluginWorkspace(["src/plugin-entry.runtime.js!", "src/matrix/send.ts!"]),
    // LanceDB declares Arrow as a peer; the plugin provides it for runtime table values.
    "extensions/memory-lancedb": pluginWorkspace([], ["apache-arrow"]),
    "extensions/openai": pluginWorkspace([
      "embedding-batch.ts!",
      "media-understanding-provider.ts!",
      "model-route-contract.ts!",
      "native-web-search.ts!",
      "openai-chatgpt-oauth-abort.runtime.ts!",
      "openai-chatgpt-oauth-flow.runtime.ts!",
      "openai-chatgpt-oauth-types.runtime.ts!",
      "openai-chatgpt-oauth.runtime.ts!",
      "openai-chatgpt-pkce.runtime.ts!",
      "openai-chatgpt-provider.runtime.ts!",
      "openai-provider.ts!",
      "prompt-overlay.ts!",
      "realtime-provider-shared.ts!",
      "tts.ts!",
      "usage.ts!",
    ]),
    "extensions/opencode": pluginWorkspace([
      "media-understanding-provider.ts!",
      "provider-catalog.ts!",
      "session-catalog-plugin.ts!",
    ]),
    "extensions/openrouter": pluginWorkspace([
      "image-generation-provider.ts!",
      "media-understanding-provider.ts!",
      "models.ts!",
      "oauth.ts!",
    ]),
    // Baileys loads its optional audio decoder at runtime for supported media.
    "extensions/whatsapp": pluginWorkspace([], ["audio-decode"]),
    "extensions/reef": pluginWorkspace(["protocol/index.ts!", "protocol/node.ts!"]),
    "extensions/*": pluginWorkspace(),
  },
} as const;

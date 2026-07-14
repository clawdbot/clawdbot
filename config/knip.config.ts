/**
 * Knip configuration for OpenClaw root and bundled plugin dependency hygiene.
 */
const BUNDLED_PLUGIN_ROOT_DIR = "extensions";

function bundledPluginFile(pluginId: string, relativePath: string, suffix = ""): string {
  return `${BUNDLED_PLUGIN_ROOT_DIR}/${pluginId}/${relativePath}${suffix}`;
}

const rootEntries = [
  "openclaw.mjs!",
  "src/index.ts!",
  "src/entry.ts!",
  "src/cli/daemon-cli.ts!",
  "src/agents/code-mode.worker.ts!",
  "src/audit/audit-event-writer.worker.ts!",
  "src/agents/model-provider-auth.worker.ts!",
  "src/infra/kysely-node-sqlite.ts!",
  "src/infra/warning-filter.ts!",
  "src/infra/command-explainer/index.ts!",
  // Runtime modules loaded by path or namespace; static export tracing cannot see their contract.
  // Jiti virtualizes openclaw/plugin-sdk/agent-sessions through this cycle-safe barrel.
  "src/agents/sessions/extension-sdk.ts!",
  "src/plugins/runtime/index.ts!",
  "src/plugins/source-display.ts!",
  "src/mcp/codex-supervision-tools-serve.ts!",
  "scripts/qa/render-maturity-docs.ts!",
  bundledPluginFile("telegram", "src/audit.ts", "!"),
  bundledPluginFile("telegram", "src/token.ts", "!"),
  "src/hooks/bundled/*/handler.ts!",
  "src/hooks/llm-slug-generator.ts!",
  "src/plugin-sdk/*.ts!",
  // Registry-dated deep-import compatibility surface; keep public until its removal windows pass.
  "src/channels/plugins/target-parsing-loaded.ts!",
] as const;

const bundledPluginEntries = [
  "*.ts!",
  "index.ts!",
  "setup-entry.ts!",
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
  "@discordjs/opus",
  "@homebridge/ciao",
  "@lit/context",
  "@matrix-org/matrix-sdk-crypto-wasm",
  "@mozilla/readability",
  "@openai/codex",
  "@pierre/theme",
  "@tloncorp/tlon-skill",
  "@zed-industries/codex-acp",
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

// These files are test infrastructure, so their exports are intentionally
// available to tests without becoming part of the production dead-code scan.
const ignoredTestSupportFiles = [
  "**/__tests__/**",
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
] as const;

const config = {
  ignoreFiles: [
    "scripts/**",
    "dist/**",
    "packages/*/dist/**",
    "**/live-*.ts",
    "src/secrets/credential-matrix.ts",
    "src/shared/text/assistant-visible-text.ts",
    bundledPluginFile("telegram", "src/bot/reply-threading.ts"),
    bundledPluginFile("telegram", "src/draft-chunking.ts"),
  ],
  // Knip's `ignoreFiles` only suppresses unused-file findings. Test helpers
  // belong in `ignore` so they do not inflate unused-export/type findings.
  ignore: ["dist/**", "packages/*/dist/**", ...ignoredTestSupportFiles],
  workspaces: {
    ".": {
      entry: rootEntries,
      ignoreDependencies: [
        "@openclaw/*",
        // Docker packaging stages @openclaw/ai without nested dependencies after
        // verifying the root owns its exact runtime dependency versions.
        "@mistralai/mistralai",
        "cross-spawn",
        "file-type",
        // Loaded via createRequire in src/agents/utils/syntax-highlight.ts because its
        // d.ts force-includes lib.dom; knip cannot see the dynamic require.
        "highlight.js",
        "playwright-core",
        "partial-json",
        "sqlite-vec",
        "tree-sitter-bash",
        ...rootBundledPluginRuntimeDependencies,
      ],
      project: [
        "src/**/*.ts!",
        "scripts/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "*.config.{js,mjs,cjs,ts,mts,cts}!",
        "*.mjs!",
      ],
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
      entry: ["src/index.ts!", "src/*.ts!", "src/harness/**/*.ts!"],
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
    "packages/net-policy": {
      entry: ["src/index.ts!", "src/ip.ts!"],
      project: ["src/**/*.ts!"],
    },
    "packages/markdown-core": {
      entry: ["src/*.ts!"],
      project: ["src/**/*.ts!"],
    },
    "packages/media-core": {
      entry: ["src/*.ts!"],
      project: ["src/**/*.ts!"],
    },
    "packages/acp-core": {
      entry: ["src/*.ts!"],
      project: ["src/**/*.ts!"],
    },
    "packages/terminal-core": {
      entry: ["src/*.ts!"],
      project: ["src/**/*.ts!"],
    },
    "packages/memory-host-sdk": {
      entry: ["src/*.ts!", "src/host/embeddings-worker-child.ts!"],
      project: ["src/**/*.ts!"],
    },
    "packages/speech-core": {
      entry: ["api.ts!", "runtime-api.ts!", "speaker.ts!", "voice-models.ts!"],
      project: ["**/*.ts!"],
      ignoreDependencies: ["openclaw"],
    },
    "packages/*": {
      entry: ["index.js!", "scripts/postinstall.js!"],
      project: ["index.js!", "scripts/**/*.js!"],
    },
    [`${BUNDLED_PLUGIN_ROOT_DIR}/llama-cpp`]: {
      entry: bundledPluginEntries,
      project: ["index.ts!", "src/**/*.{js,mjs,ts}!"],
      ignoreDependencies: [
        // The provider resolves node-llama-cpp from its own package at runtime
        // so local embeddings use the plugin-owned native dependency.
        "node-llama-cpp",
        ...bundledPluginIgnoredRuntimeDependencies,
      ],
    },
    [`${BUNDLED_PLUGIN_ROOT_DIR}/reef`]: {
      // Reef vendors its wire protocol under protocol/, which owns the noble
      // crypto dependencies. The protocol barrel is the vendored library's
      // public surface, so its exports are intentional even where the channel
      // consumes only a subset.
      entry: [...bundledPluginEntries, "protocol/index.ts!", "protocol/node.ts!"],
      project: ["index.ts!", "src/**/*.{js,mjs,ts}!", "protocol/**/*.ts!"],
      ignoreDependencies: bundledPluginIgnoredRuntimeDependencies,
    },
    [`${BUNDLED_PLUGIN_ROOT_DIR}/*`]: {
      // Bundled plugins often load their public surface via string specifiers in
      // `index.ts` contracts, so Knip needs these convention-based entry files.
      entry: bundledPluginEntries,
      project: ["index.ts!", "src/**/*.{js,mjs,ts}!"],
      ignoreDependencies: bundledPluginIgnoredRuntimeDependencies,
    },
  },
} as const;

export default config;

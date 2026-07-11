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
  "src/mcp/codex-supervision-tools-serve.ts!",
  bundledPluginFile("telegram", "src/audit.ts", "!"),
  bundledPluginFile("telegram", "src/token.ts", "!"),
  "src/hooks/bundled/*/handler.ts!",
  "src/hooks/llm-slug-generator.ts!",
  "src/plugin-sdk/*.ts!",
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

const config = {
  ignoreFiles: [
    "scripts/**",
    "packages/*/dist/**",
    "**/__tests__/**",
    "src/test-utils/**",
    "**/test-helpers/**",
    "**/test-fixtures/**",
    "**/test-support/**",
    "**/live-*.ts",
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
    "src/secrets/credential-matrix.ts",
    "src/shared/text/assistant-visible-text.ts",
    bundledPluginFile("telegram", "src/bot/reply-threading.ts"),
    bundledPluginFile("telegram", "src/draft-chunking.ts"),
  ],
  ignore: ["packages/*/dist/**"],
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
      entry: ["src/index.ts!"],
      project: ["src/**/*.ts!"],
    },
    "packages/gateway-protocol": {
      entry: ["src/index.ts!", "src/schema.ts!"],
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

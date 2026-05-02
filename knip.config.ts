const BUNDLED_PLUGIN_ROOT_DIR = "extensions";

function bundledPluginFile(pluginId: string, relativePath: string, suffix = ""): string {
  return `${BUNDLED_PLUGIN_ROOT_DIR}/${pluginId}/${relativePath}${suffix}`;
}

const rootEntries = [
  "openclaw.mjs!",
  "src/index.ts!",
  "src/entry.ts!",
  "src/cli/daemon-cli.ts!",
  "src/infra/warning-filter.ts!",
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
  "src/{api,runtime-api,light-runtime-api,update-offset-runtime-api,channel-plugin-api,provider-plugin-api,doctor-contract,setup-surface}.ts!",
  "src/subagent-hooks-api.ts!",
] as const;

const bundledPluginIgnoredRuntimeDependencies = [
  "@agentclientprotocol/claude-agent-acp",
  "@azure/identity",
  "@clawdbot/lobster",
  "@discordjs/opus",
  "@homebridge/ciao",
  "@matrix-org/matrix-sdk-crypto-wasm",
  "@mozilla/readability",
  "@openai/codex",
  "@pierre/theme",
  "@tloncorp/tlon-skill",
  "@zed-industries/codex-acp",
  "jiti",
  "linkedom",
  "openclaw",
  "pdfjs-dist",
] as const;

const config = {
  ignoreFiles: [
    "scripts/**",
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
    "src/gateway/live-image-probe.ts",
    "src/secrets/credential-matrix.ts",
    "src/agents/claude-cli-runner.ts",
    "src/agents/pi-auth-json.ts",
    "src/agents/tool-policy.conformance.ts",
    "src/auto-reply/reply/audio-tags.ts",
    "src/gateway/live-tool-probe-utils.ts",
    "src/gateway/server.auth.shared.ts",
    "src/shared/text/assistant-visible-text.ts",
    bundledPluginFile("telegram", "src/bot/reply-threading.ts"),
    bundledPluginFile("telegram", "src/draft-chunking.ts"),
    bundledPluginFile("msteams", "src/conversation-store-memory.ts"),
    bundledPluginFile("msteams", "src/polls-store-memory.ts"),
    bundledPluginFile("voice-call", "src/providers/index.ts"),
  ],
  workspaces: {
    ".": {
      entry: rootEntries,
      ignoreDependencies: ["@openclaw/*", "playwright-core", "sqlite-vec"],
      project: [
        "src/**/*.ts!",
        "scripts/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "*.config.{js,mjs,cjs,ts,mts,cts}!",
        "*.mjs!",
      ],
    },
    ui: {
      entry: ["index.html!", "src/main.ts!", "vite.config.ts!", "vitest*.ts!"],
      project: ["src/**/*.{ts,tsx}!"],
    },
    "packages/*": {
      entry: ["index.js!", "scripts/postinstall.js!"],
      project: ["index.js!", "scripts/**/*.js!"],
    },
    [`${BUNDLED_PLUGIN_ROOT_DIR}/*`]: {
      // Bundled plugins often load their public surface via string specifiers in
      // `index.ts` contracts, so Knip needs these convention-based entry files.
      entry: bundledPluginEntries,
      project: ["index.ts!", "src/**/*.ts!"],
      ignoreDependencies: bundledPluginIgnoredRuntimeDependencies,
    },
  },
} as const;

export default config;

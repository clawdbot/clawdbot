export const autoReplyCoreTestInclude = ["src/auto-reply/*.test.ts"];

export const autoReplyCoreTestExclude = ["src/auto-reply/reply*.test.ts"];

export const autoReplyTopLevelReplyTestInclude = ["src/auto-reply/reply*.test.ts"];

export const autoReplyReplySubtreeTestInclude = ["src/auto-reply/reply/**/*.test.ts"];

export const fullSuiteVitestShards = [
  {
    config: "test/vitest/vitest.full-core-unit-fast.config.ts",
    name: "core-unit-fast",
    projects: ["test/vitest/vitest.unit-fast.config.ts"],
  },
  {
    config: "test/vitest/vitest.full-core-unit-src.config.ts",
    name: "core-unit-src",
    projects: ["test/vitest/vitest.unit-src.config.ts"],
  },
  {
    config: "test/vitest/vitest.full-core-unit-security.config.ts",
    name: "core-unit-security",
    projects: ["test/vitest/vitest.unit-security.config.ts"],
  },
  {
    config: "test/vitest/vitest.full-core-unit-ui.config.ts",
    name: "core-unit-ui",
    projects: ["test/vitest/vitest.unit-ui.config.ts"],
  },
  {
    config: "test/vitest/vitest.full-core-unit-support.config.ts",
    name: "core-unit-support",
    projects: ["test/vitest/vitest.unit-support.config.ts"],
  },
  {
    config: "test/vitest/vitest.full-core-support-boundary.config.ts",
    name: "core-support-boundary",
    projects: ["test/vitest/vitest.boundary.config.ts", "test/vitest/vitest.tooling.config.ts"],
  },
  {
    config: "test/vitest/vitest.full-core-contracts.config.ts",
    name: "core-contracts",
    projects: [
      "test/vitest/vitest.contracts-channel-surface.config.ts",
      "test/vitest/vitest.contracts-channel-config.config.ts",
      "test/vitest/vitest.contracts-channel-registry.config.ts",
      "test/vitest/vitest.contracts-channel-session.config.ts",
      "test/vitest/vitest.contracts-plugin.config.ts",
    ],
  },
  {
    config: "test/vitest/vitest.full-core-bundled.config.ts",
    name: "core-bundled",
    projects: ["test/vitest/vitest.bundled.config.ts"],
  },
  {
    config: "test/vitest/vitest.full-core-runtime.config.ts",
    name: "core-runtime",
    projects: [
      "test/vitest/vitest.infra.config.ts",
      "test/vitest/vitest.hooks.config.ts",
      "test/vitest/vitest.acp.config.ts",
      "test/vitest/vitest.runtime-config.config.ts",
      "test/vitest/vitest.secrets.config.ts",
      "test/vitest/vitest.logging.config.ts",
      "test/vitest/vitest.process.config.ts",
      "test/vitest/vitest.cron.config.ts",
      "test/vitest/vitest.media.config.ts",
      "test/vitest/vitest.media-understanding.config.ts",
      "test/vitest/vitest.shared-core.config.ts",
      "test/vitest/vitest.tasks.config.ts",
      "test/vitest/vitest.tui.config.ts",
      "test/vitest/vitest.ui.config.ts",
      "test/vitest/vitest.utils.config.ts",
      "test/vitest/vitest.wizard.config.ts",
    ],
  },
  {
    config: "test/vitest/vitest.full-agentic.config.ts",
    name: "agentic",
    projects: [
      "test/vitest/vitest.gateway-core.config.ts",
      "test/vitest/vitest.gateway-client.config.ts",
      "test/vitest/vitest.gateway-methods.config.ts",
      "test/vitest/vitest.gateway-server.config.ts",
      "test/vitest/vitest.cli.config.ts",
      "test/vitest/vitest.commands-light.config.ts",
      "test/vitest/vitest.commands.config.ts",
      "test/vitest/vitest.agents.config.ts",
      "test/vitest/vitest.daemon.config.ts",
      "test/vitest/vitest.plugin-sdk-light.config.ts",
      "test/vitest/vitest.plugin-sdk.config.ts",
      "test/vitest/vitest.plugins.config.ts",
      "test/vitest/vitest.channels.config.ts",
    ],
  },
  {
    config: "test/vitest/vitest.full-auto-reply.config.ts",
    name: "auto-reply",
    projects: [
      "test/vitest/vitest.auto-reply-core.config.ts",
      "test/vitest/vitest.auto-reply-top-level.config.ts",
      "test/vitest/vitest.auto-reply-reply.config.ts",
    ],
  },
  {
    config: "test/vitest/vitest.full-extensions.config.ts",
    name: "extensions",
    projects: [
      "test/vitest/vitest.extension-acpx.config.ts",
      "test/vitest/vitest.extension-bluebubbles.config.ts",
      "test/vitest/vitest.extension-diffs.config.ts",
      "test/vitest/vitest.extension-discord.config.ts",
      "test/vitest/vitest.extension-feishu.config.ts",
      "test/vitest/vitest.extension-imessage.config.ts",
      "test/vitest/vitest.extension-irc.config.ts",
      "test/vitest/vitest.extension-line.config.ts",
      "test/vitest/vitest.extension-mattermost.config.ts",
      "test/vitest/vitest.extension-matrix.config.ts",
      "test/vitest/vitest.extension-memory.config.ts",
      "test/vitest/vitest.extension-messaging.config.ts",
      "test/vitest/vitest.extension-msteams.config.ts",
      "test/vitest/vitest.extension-provider-openai.config.ts",
      "test/vitest/vitest.extension-providers.config.ts",
      "test/vitest/vitest.extension-signal.config.ts",
      "test/vitest/vitest.extension-slack.config.ts",
      "test/vitest/vitest.extension-telegram.config.ts",
      "test/vitest/vitest.extension-voice-call.config.ts",
      "test/vitest/vitest.extension-whatsapp.config.ts",
      "test/vitest/vitest.extension-zalo.config.ts",
      "test/vitest/vitest.extension-browser.config.ts",
      "test/vitest/vitest.extension-qa.config.ts",
      "test/vitest/vitest.extension-media.config.ts",
      "test/vitest/vitest.extension-misc.config.ts",
    ],
  },
];

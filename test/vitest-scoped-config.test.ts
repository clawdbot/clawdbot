import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUNDLED_PLUGIN_TEST_GLOB, bundledPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "./helpers/temp-dir.js";
import { normalizeConfigPath, normalizeConfigPaths } from "./helpers/vitest-config-paths.js";
import { createAcpVitestConfig } from "./vitest/vitest.acp.config.ts";
import { createAgentsVitestConfig } from "./vitest/vitest.agents.config.ts";
import { createAutoReplyCoreVitestConfig } from "./vitest/vitest.auto-reply-core.config.ts";
import { createAutoReplyReplyVitestConfig } from "./vitest/vitest.auto-reply-reply.config.ts";
import { createAutoReplyTopLevelVitestConfig } from "./vitest/vitest.auto-reply-top-level.config.ts";
import { createAutoReplyVitestConfig } from "./vitest/vitest.auto-reply.config.ts";
import bundledVitestConfig from "./vitest/vitest.bundled.config.ts";
import { createChannelsVitestConfig } from "./vitest/vitest.channels.config.ts";
import { createCliVitestConfig } from "./vitest/vitest.cli.config.ts";
import { createCommandsLightVitestConfig } from "./vitest/vitest.commands-light.config.ts";
import { createCommandsVitestConfig } from "./vitest/vitest.commands.config.ts";
import { createCronVitestConfig } from "./vitest/vitest.cron.config.ts";
import { createDaemonVitestConfig } from "./vitest/vitest.daemon.config.ts";
import { createExtensionAcpxVitestConfig } from "./vitest/vitest.extension-acpx.config.ts";
import { createExtensionBrowserVitestConfig } from "./vitest/vitest.extension-browser.config.ts";
import { createExtensionChannelsVitestConfig } from "./vitest/vitest.extension-channels.config.ts";
import { createExtensionDiffsVitestConfig } from "./vitest/vitest.extension-diffs.config.ts";
import { createExtensionDiscordVitestConfig } from "./vitest/vitest.extension-discord.config.ts";
import { createExtensionFeishuVitestConfig } from "./vitest/vitest.extension-feishu.config.ts";
import { createExtensionImessageVitestConfig } from "./vitest/vitest.extension-imessage.config.ts";
import { createExtensionIrcVitestConfig } from "./vitest/vitest.extension-irc.config.ts";
import { createExtensionLineVitestConfig } from "./vitest/vitest.extension-line.config.ts";
import { createExtensionMatrixVitestConfig } from "./vitest/vitest.extension-matrix.config.ts";
import { createExtensionMattermostVitestConfig } from "./vitest/vitest.extension-mattermost.config.ts";
import { createExtensionMediaVitestConfig } from "./vitest/vitest.extension-media.config.ts";
import { createExtensionMemoryVitestConfig } from "./vitest/vitest.extension-memory.config.ts";
import { createExtensionMessagingVitestConfig } from "./vitest/vitest.extension-messaging.config.ts";
import { createExtensionMiscVitestConfig } from "./vitest/vitest.extension-misc.config.ts";
import { createExtensionMsTeamsVitestConfig } from "./vitest/vitest.extension-msteams.config.ts";
import { createExtensionProviderOpenAiVitestConfig } from "./vitest/vitest.extension-provider-openai.config.ts";
import { createExtensionProvidersVitestConfig } from "./vitest/vitest.extension-providers.config.ts";
import { createExtensionQaVitestConfig } from "./vitest/vitest.extension-qa.config.ts";
import { createExtensionSignalVitestConfig } from "./vitest/vitest.extension-signal.config.ts";
import { createExtensionSlackVitestConfig } from "./vitest/vitest.extension-slack.config.ts";
import { createExtensionTelegramVitestConfig } from "./vitest/vitest.extension-telegram.config.ts";
import { createExtensionVoiceCallVitestConfig } from "./vitest/vitest.extension-voice-call.config.ts";
import { createExtensionWhatsAppVitestConfig } from "./vitest/vitest.extension-whatsapp.config.ts";
import { createExtensionZaloVitestConfig } from "./vitest/vitest.extension-zalo.config.ts";
import { createExtensionsVitestConfig } from "./vitest/vitest.extensions.config.ts";
import { createGatewayVitestConfig } from "./vitest/vitest.gateway.config.ts";
import { createHooksVitestConfig } from "./vitest/vitest.hooks.config.ts";
import { createInfraVitestConfig } from "./vitest/vitest.infra.config.ts";
import { createLoggingVitestConfig } from "./vitest/vitest.logging.config.ts";
import { createMediaUnderstandingVitestConfig } from "./vitest/vitest.media-understanding.config.ts";
import { createMediaVitestConfig } from "./vitest/vitest.media.config.ts";
import { createPluginSdkLightVitestConfig } from "./vitest/vitest.plugin-sdk-light.config.ts";
import { createPluginSdkVitestConfig } from "./vitest/vitest.plugin-sdk.config.ts";
import { createPluginsVitestConfig } from "./vitest/vitest.plugins.config.ts";
import { createProcessVitestConfig } from "./vitest/vitest.process.config.ts";
import { createRuntimeConfigVitestConfig } from "./vitest/vitest.runtime-config.config.ts";
import { createScopedVitestConfig, resolveVitestIsolation } from "./vitest/vitest.scoped-config.ts";
import { createSecretsVitestConfig } from "./vitest/vitest.secrets.config.ts";
import { createSharedCoreVitestConfig } from "./vitest/vitest.shared-core.config.ts";
import { sharedVitestConfig } from "./vitest/vitest.shared.config.ts";
import { createTasksVitestConfig } from "./vitest/vitest.tasks.config.ts";
import { createToolingVitestConfig } from "./vitest/vitest.tooling.config.ts";
import { createTuiVitestConfig } from "./vitest/vitest.tui.config.ts";
import { createUiVitestConfig } from "./vitest/vitest.ui.config.ts";
import { bundledPluginDependentUnitTestFiles } from "./vitest/vitest.unit-paths.mjs";
import { createUtilsVitestConfig } from "./vitest/vitest.utils.config.ts";
import { createWizardVitestConfig } from "./vitest/vitest.wizard.config.ts";

const EXTENSIONS_CHANNEL_GLOB = ["extensions", "channel", "**"].join("/");
const PRIVATE_PLUGIN_SDK_SUBPATHS = ["qa-lab", "qa-runtime"] as const;

function bundledExcludePatternCouldMatchFile(pattern: string, file: string): boolean {
  if (pattern === file) {
    return true;
  }
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return file === prefix || file.startsWith(`${prefix}/`);
  }
  return false;
}

function matchingExcludePatterns(patterns: string[], file: string): string[] {
  return patterns.filter((pattern) => path.matchesGlob(file, pattern));
}

function requireTestConfig<T extends { test?: unknown }>(config: T): NonNullable<T["test"]> {
  if (!config.test) {
    throw new Error("expected scoped vitest test config");
  }
  return config.test as NonNullable<T["test"]>;
}

function expectThreadedNonIsolatedRunner(config: {
  test?: { pool?: unknown; isolate?: unknown; runner?: unknown };
}) {
  const testConfig = requireTestConfig(config);
  expect(testConfig.pool).toBe("threads");
  expect(testConfig.isolate).toBe(false);
  expect(normalizeConfigPath(testConfig.runner)).toBe("test/non-isolated-runner.ts");
}

describe("resolveVitestIsolation", () => {
  it("aliases private QA plugin SDK subpaths for source tests only", () => {
    expect(sharedVitestConfig.resolve.alias).toEqual(
      expect.arrayContaining(
        PRIVATE_PLUGIN_SDK_SUBPATHS.map((subpath) =>
          expect.objectContaining({
            find: `openclaw/plugin-sdk/${subpath}`,
            replacement: path.join(process.cwd(), "src", "plugin-sdk", `${subpath}.ts`),
          }),
        ),
      ),
    );
    expect(sharedVitestConfig.resolve.alias).not.toEqual(
      expect.arrayContaining(
        PRIVATE_PLUGIN_SDK_SUBPATHS.map((subpath) =>
          expect.objectContaining({
            find: `@openclaw/plugin-sdk/${subpath}`,
          }),
        ),
      ),
    );
  });

  it("defaults shared scoped configs to the non-isolated runner", () => {
    expect(resolveVitestIsolation({})).toBe(false);
  });

  it("ignores the legacy isolation escape hatches", () => {
    expect(resolveVitestIsolation({ OPENCLAW_TEST_ISOLATE: "1" })).toBe(false);
    expect(resolveVitestIsolation({ OPENCLAW_TEST_NO_ISOLATE: "0" })).toBe(false);
    expect(resolveVitestIsolation({ OPENCLAW_TEST_NO_ISOLATE: "false" })).toBe(false);
  });

  it("resolves scoped discovery dirs from the repo root after config relocation", () => {
    const config = createExtensionMatrixVitestConfig({});
    const testConfig = requireTestConfig(config);

    expect(config.root).toBe(process.cwd());
    expect(testConfig.dir).toBe(path.join(process.cwd(), "extensions"));
    expect(testConfig.include).toContain("matrix/**/*.test.ts");
  });
});

describe("createScopedVitestConfig", () => {
  it("applies the non-isolated runner by default", () => {
    const config = createScopedVitestConfig(["src/example.test.ts"], { env: {} });
    const testConfig = requireTestConfig(config);
    expect(testConfig.isolate).toBe(false);
    expect(normalizeConfigPath(testConfig.runner)).toBe("test/non-isolated-runner.ts");
    expect(normalizeConfigPaths(testConfig.setupFiles)).toEqual([
      "test/setup.ts",
      "test/setup-openclaw-runtime.ts",
    ]);
  });

  it("passes through a scoped root dir when provided", () => {
    const config = createScopedVitestConfig(["src/example.test.ts"], {
      dir: "src",
      env: {},
    });
    const testConfig = requireTestConfig(config);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src"));
    expect(testConfig.include).toEqual(["example.test.ts"]);
  });

  it("keeps scoped cli directory filters aligned with repo-root include patterns", () => {
    const config = createScopedVitestConfig(["extensions/slack/**/*.test.ts"], {
      argv: ["vitest", "run", "extensions/slack"],
      dir: "extensions",
      env: {},
      passWithNoTests: true,
    });

    expect(requireTestConfig(config).include).toEqual(["slack/**/*.test.*"]);
  });

  it("keeps broad scoped cli directory filters aligned with repo-root include patterns", () => {
    const config = createScopedVitestConfig([BUNDLED_PLUGIN_TEST_GLOB], {
      argv: ["vitest", "run", "extensions/speech-core"],
      dir: "extensions",
      env: {},
      passWithNoTests: true,
    });

    expect(requireTestConfig(config).include).toEqual(["speech-core/**/*.test.*"]);
  });

  it("relativizes scoped include and exclude patterns to the configured dir", () => {
    const config = createScopedVitestConfig([BUNDLED_PLUGIN_TEST_GLOB], {
      dir: "extensions",
      env: {},
      exclude: [EXTENSIONS_CHANNEL_GLOB, "dist/**"],
    });
    const testConfig = requireTestConfig(config);

    expect(testConfig.include).toEqual(["**/*.test.ts"]);
    expect(testConfig.exclude).toEqual(expect.arrayContaining(["channel/**", "dist/**"]));
  });

  it("narrows scoped includes to matching CLI file filters", () => {
    const config = createScopedVitestConfig(["extensions/**/*.test.ts"], {
      argv: ["node", "vitest", "run", "extensions/browser/index.test.ts"],
      dir: "extensions",
      env: {},
    });
    const testConfig = requireTestConfig(config);

    expect(testConfig.include).toEqual(["browser/index.test.ts"]);
    expect(testConfig.passWithNoTests).toBe(true);
  });

  it("loads scoped include overrides from OPENCLAW_VITEST_INCLUDE_FILE", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-vitest-scoped-"));
    try {
      const includeFile = path.join(tempDir, "include.json");
      fs.writeFileSync(includeFile, JSON.stringify(["src/utils/utils-misc.test.ts"]), "utf8");

      const config = createScopedVitestConfig(["src/utils/**/*.test.ts"], {
        dir: "src",
        env: {
          OPENCLAW_VITEST_INCLUDE_FILE: includeFile,
        },
      });

      expect(requireTestConfig(config).include).toEqual(["utils/utils-misc.test.ts"]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("overrides setup files when a scoped config requests them", () => {
    const config = createScopedVitestConfig(["src/example.test.ts"], {
      env: {},
      setupFiles: ["test/setup.extensions.ts"],
    });

    expect(normalizeConfigPaths(requireTestConfig(config).setupFiles)).toEqual([
      "test/setup.ts",
      "test/setup.extensions.ts",
      "test/setup-openclaw-runtime.ts",
    ]);
  });

  it("keeps bundled unit test includes out of the bundled exclude list", () => {
    const excludePatterns = requireTestConfig(bundledVitestConfig).exclude ?? [];
    for (const file of bundledPluginDependentUnitTestFiles) {
      expect(
        excludePatterns.some((pattern) => bundledExcludePatternCouldMatchFile(pattern, file)),
      ).toBe(false);
    }
  });
});

describe("scoped vitest configs", () => {
  const defaultChannelsConfig = createChannelsVitestConfig({});
  const defaultAcpConfig = createAcpVitestConfig({});
  const defaultCliConfig = createCliVitestConfig({});
  const defaultExtensionsConfig = createExtensionsVitestConfig({});
  const defaultExtensionAcpxConfig = createExtensionAcpxVitestConfig({});
  const defaultExtensionChannelsConfig = createExtensionChannelsVitestConfig({});
  const defaultExtensionBrowserConfig = createExtensionBrowserVitestConfig({});
  const defaultExtensionDiffsConfig = createExtensionDiffsVitestConfig({});
  const defaultExtensionDiscordConfig = createExtensionDiscordVitestConfig({});
  const defaultExtensionFeishuConfig = createExtensionFeishuVitestConfig({});
  const defaultExtensionImessageConfig = createExtensionImessageVitestConfig({});
  const defaultExtensionIrcConfig = createExtensionIrcVitestConfig({});
  const defaultExtensionLineConfig = createExtensionLineVitestConfig({});
  const defaultExtensionMatrixConfig = createExtensionMatrixVitestConfig({});
  const defaultExtensionMattermostConfig = createExtensionMattermostVitestConfig({});
  const defaultExtensionMediaConfig = createExtensionMediaVitestConfig({});
  const defaultExtensionMemoryConfig = createExtensionMemoryVitestConfig({});
  const defaultExtensionMiscConfig = createExtensionMiscVitestConfig({});
  const defaultExtensionMsTeamsConfig = createExtensionMsTeamsVitestConfig({});
  const defaultExtensionMessagingConfig = createExtensionMessagingVitestConfig({});
  const defaultExtensionProviderOpenAiConfig = createExtensionProviderOpenAiVitestConfig({});
  const defaultExtensionProvidersConfig = createExtensionProvidersVitestConfig({});
  const defaultExtensionQaConfig = createExtensionQaVitestConfig({});
  const defaultExtensionSignalConfig = createExtensionSignalVitestConfig({});
  const defaultExtensionSlackConfig = createExtensionSlackVitestConfig({});
  const defaultExtensionTelegramConfig = createExtensionTelegramVitestConfig({});
  const defaultExtensionVoiceCallConfig = createExtensionVoiceCallVitestConfig({});
  const defaultExtensionWhatsAppConfig = createExtensionWhatsAppVitestConfig({});
  const defaultExtensionZaloConfig = createExtensionZaloVitestConfig({});
  const defaultGatewayConfig = createGatewayVitestConfig({});
  const defaultHooksConfig = createHooksVitestConfig({});
  const defaultInfraConfig = createInfraVitestConfig({});
  const defaultLoggingConfig = createLoggingVitestConfig({});
  const defaultPluginSdkLightConfig = createPluginSdkLightVitestConfig({});
  const defaultPluginSdkConfig = createPluginSdkVitestConfig({});
  const defaultSecretsConfig = createSecretsVitestConfig({});
  const defaultRuntimeConfig = createRuntimeConfigVitestConfig({});
  const defaultCronConfig = createCronVitestConfig({});
  const defaultDaemonConfig = createDaemonVitestConfig({});
  const defaultMediaConfig = createMediaVitestConfig({});
  const defaultMediaUnderstandingConfig = createMediaUnderstandingVitestConfig({});
  const defaultSharedCoreConfig = createSharedCoreVitestConfig({});
  const defaultTasksConfig = createTasksVitestConfig({});
  const defaultCommandsLightConfig = createCommandsLightVitestConfig({});
  const defaultCommandsConfig = createCommandsVitestConfig({});
  const defaultAutoReplyConfig = createAutoReplyVitestConfig({});
  const defaultAutoReplyCoreConfig = createAutoReplyCoreVitestConfig({});
  const defaultAutoReplyTopLevelConfig = createAutoReplyTopLevelVitestConfig({});
  const defaultAutoReplyReplyConfig = createAutoReplyReplyVitestConfig({});
  const defaultAgentsConfig = createAgentsVitestConfig({});
  const defaultPluginsConfig = createPluginsVitestConfig({});
  const defaultProcessConfig = createProcessVitestConfig({});
  const defaultToolingConfig = createToolingVitestConfig({});
  const defaultTuiConfig = createTuiVitestConfig({});
  const defaultUiConfig = createUiVitestConfig({});
  const defaultUtilsConfig = createUtilsVitestConfig({});
  const defaultWizardConfig = createWizardVitestConfig({});

  it("keeps scoped lanes on threads with the shared non-isolated runner", () => {
    for (const config of [
      defaultChannelsConfig,
      defaultAcpConfig,
      defaultExtensionsConfig,
      defaultExtensionChannelsConfig,
      defaultExtensionDiscordConfig,
      defaultExtensionImessageConfig,
      defaultExtensionLineConfig,
      defaultExtensionProviderOpenAiConfig,
      defaultExtensionProvidersConfig,
      defaultExtensionSignalConfig,
      defaultExtensionSlackConfig,
      defaultInfraConfig,
      defaultAutoReplyConfig,
      defaultAutoReplyCoreConfig,
      defaultAutoReplyTopLevelConfig,
      defaultAutoReplyReplyConfig,
      defaultToolingConfig,
    ]) {
      expectThreadedNonIsolatedRunner(config);
    }

    for (const config of [defaultGatewayConfig, defaultAgentsConfig]) {
      expectThreadedNonIsolatedRunner(config);
    }

    expectThreadedNonIsolatedRunner(defaultCommandsConfig);

    expectThreadedNonIsolatedRunner(defaultUiConfig);
  });

  it("keeps the process lane off the openclaw runtime setup", () => {
    expect(normalizeConfigPaths(requireTestConfig(defaultProcessConfig).setupFiles)).toEqual([
      "test/setup.ts",
    ]);
    expect(normalizeConfigPaths(requireTestConfig(defaultRuntimeConfig).setupFiles)).toEqual([
      "test/setup.ts",
    ]);
    expect(normalizeConfigPaths(requireTestConfig(defaultPluginSdkConfig).setupFiles)).toEqual([
      "test/setup.ts",
      "test/setup-openclaw-runtime.ts",
    ]);
  });

  it("splits auto-reply into narrower scoped buckets", () => {
    const coreTestConfig = requireTestConfig(defaultAutoReplyCoreConfig);
    expect(coreTestConfig.include).toEqual(["*.test.ts"]);
    expect(coreTestConfig.exclude).toEqual(expect.arrayContaining(["reply*.test.ts"]));
    expect(requireTestConfig(defaultAutoReplyTopLevelConfig).include).toEqual(["reply*.test.ts"]);
    expect(requireTestConfig(defaultAutoReplyReplyConfig).include).toEqual(["reply/**/*.test.ts"]);
  });

  it("keeps the broad agents lane on shared file parallelism", () => {
    expect(requireTestConfig(defaultAgentsConfig).fileParallelism).toBe(
      sharedVitestConfig.test.fileParallelism,
    );
  });

  it("keeps selected plugin-sdk and commands light lanes off the openclaw runtime setup", () => {
    expect(normalizeConfigPaths(requireTestConfig(defaultPluginSdkLightConfig).setupFiles)).toEqual(
      ["test/setup.ts"],
    );
    expect(normalizeConfigPaths(requireTestConfig(defaultCommandsLightConfig).setupFiles)).toEqual([
      "test/setup.ts",
    ]);
  });

  it("keeps the ui lane off both the openclaw runtime setup and unit-fast excludes", () => {
    const testConfig = requireTestConfig(defaultUiConfig);
    expect(normalizeConfigPaths(testConfig.setupFiles)).toEqual([
      "test/setup.ts",
      "ui/src/test-helpers/lit-warnings.setup.ts",
    ]);
    expect(testConfig.exclude).not.toContain("chat/slash-command-executor.node.test.ts");
  });

  it("defaults channel tests to threads with the non-isolated runner", () => {
    expectThreadedNonIsolatedRunner(defaultChannelsConfig);
  });

  it("keeps the core channel lane limited to non-extension roots", () => {
    expect(requireTestConfig(defaultChannelsConfig).include).toEqual(["src/channels/**/*.test.ts"]);
  });

  it("loads channel include overrides from OPENCLAW_VITEST_INCLUDE_FILE", () => {
    const tempDirs: string[] = [];
    const tempDir = makeTempDir(tempDirs, "openclaw-vitest-channels-");
    try {
      const includeFile = path.join(tempDir, "include.json");
      fs.writeFileSync(
        includeFile,
        JSON.stringify([
          bundledPluginFile(
            "discord",
            "src/monitor/message-handler.preflight.acp-bindings.test.ts",
          ),
        ]),
        "utf8",
      );

      const config = createChannelsVitestConfig({
        OPENCLAW_VITEST_INCLUDE_FILE: includeFile,
      });

      expect(requireTestConfig(config).include).toEqual([
        bundledPluginFile("discord", "src/monitor/message-handler.preflight.acp-bindings.test.ts"),
      ]);
    } finally {
      cleanupTempDirs(tempDirs);
    }
  });

  it("defaults extension tests to threads with the non-isolated runner", () => {
    expectThreadedNonIsolatedRunner(defaultExtensionsConfig);
  });

  it("normalizes split extension channel include patterns relative to the scoped dir", () => {
    for (const [config, include] of [
      [defaultExtensionDiscordConfig, "discord/**/*.test.ts"],
      [defaultExtensionLineConfig, "line/**/*.test.ts"],
      [defaultExtensionSlackConfig, "slack/**/*.test.ts"],
      [defaultExtensionSignalConfig, "signal/**/*.test.ts"],
      [defaultExtensionImessageConfig, "imessage/**/*.test.ts"],
    ] as const) {
      const testConfig = requireTestConfig(config);
      expect(testConfig.dir).toBe(path.join(process.cwd(), "extensions"));
      expect(testConfig.include).toEqual([include]);
    }
  });

  it("normalizes acpx extension include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultExtensionAcpxConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "extensions"));
    expect(testConfig.include).toEqual(["acpx/**/*.test.ts"]);
  });

  it("normalizes diffs extension include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultExtensionDiffsConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "extensions"));
    expect(testConfig.include).toEqual(["diffs/**/*.test.ts"]);
  });

  it("normalizes feishu extension include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultExtensionFeishuConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "extensions"));
    expect(testConfig.include).toEqual(["feishu/**/*.test.ts"]);
  });

  it("normalizes irc extension include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultExtensionIrcConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "extensions"));
    expect(testConfig.include).toEqual(["irc/**/*.test.ts"]);
  });

  it("normalizes extension include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultExtensionsConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "extensions"));
    expect(testConfig.include).toEqual(["**/*.test.ts"]);
  });

  it("normalizes extension provider include patterns relative to the scoped dir", () => {
    const providersTestConfig = requireTestConfig(defaultExtensionProvidersConfig);
    expect(providersTestConfig.dir).toBe(path.join(process.cwd(), "extensions"));
    expect(providersTestConfig.include).toEqual(
      expect.arrayContaining(["xai/**/*.test.ts", "google/**/*.test.ts"]),
    );
    expect(providersTestConfig.include).not.toContain("openai/**/*.test.ts");
    const openAiTestConfig = requireTestConfig(defaultExtensionProviderOpenAiConfig);
    expect(openAiTestConfig.dir).toBe(path.join(process.cwd(), "extensions"));
    expect(openAiTestConfig.include).toEqual(["openai/**/*.test.ts"]);
  });

  it("normalizes extension messaging include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultExtensionMessagingConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "extensions"));
    expect(testConfig.include).toEqual(expect.arrayContaining(["googlechat/**/*.test.ts"]));
  });

  it("normalizes matrix extension include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultExtensionMatrixConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "extensions"));
    expect(testConfig.include).toEqual(["matrix/**/*.test.ts"]);
  });

  it("normalizes mattermost extension include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultExtensionMattermostConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "extensions"));
    expect(testConfig.include).toEqual(["mattermost/**/*.test.ts"]);
  });

  it("normalizes msteams extension include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultExtensionMsTeamsConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "extensions"));
    expect(testConfig.include).toEqual(["msteams/**/*.test.ts"]);
  });

  it("normalizes telegram extension include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultExtensionTelegramConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "extensions"));
    expect(testConfig.include).toEqual(["telegram/**/*.test.ts"]);
  });

  it("normalizes whatsapp extension include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultExtensionWhatsAppConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "extensions"));
    expect(testConfig.include).toEqual(["whatsapp/**/*.test.ts"]);
  });

  it("normalizes zalo extension include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultExtensionZaloConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "extensions"));
    expect(testConfig.include).toEqual(
      expect.arrayContaining(["zalo/**/*.test.ts", "zalouser/**/*.test.ts"]),
    );
  });

  it("normalizes voice-call extension include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultExtensionVoiceCallConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "extensions"));
    expect(testConfig.include).toEqual(["voice-call/**/*.test.ts"]);
  });

  it("normalizes memory extension include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultExtensionMemoryConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "extensions"));
    expect(testConfig.include).toEqual(
      expect.arrayContaining(["memory-core/**/*.test.ts", "memory-lancedb/**/*.test.ts"]),
    );
  });

  it("keeps telegram plugin tests out of the shared extensions lane", () => {
    const extensionsTestConfig = requireTestConfig(defaultExtensionsConfig);
    const channelsTestConfig = requireTestConfig(defaultChannelsConfig);
    const telegramTestConfig = requireTestConfig(defaultExtensionTelegramConfig);
    const extensionExcludes = extensionsTestConfig.exclude ?? [];
    expect(
      extensionExcludes.some((pattern) => path.matchesGlob("telegram/src/fetch.test.ts", pattern)),
    ).toBe(true);
    expect(
      extensionExcludes.some((pattern) =>
        path.matchesGlob("telegram/src/bot/delivery.resolve-media-retry.test.ts", pattern),
      ),
    ).toBe(true);
    expect(channelsTestConfig.include).not.toContain("extensions/telegram/**/*.test.ts");
    expect(channelsTestConfig.exclude).not.toContain(
      bundledPluginFile("telegram", "src/fetch.test.ts"),
    );
    expect(normalizeConfigPaths(extensionsTestConfig.setupFiles)).toEqual([
      "test/setup.ts",
      "test/setup.extensions.ts",
      "test/setup-openclaw-runtime.ts",
    ]);
    expect(normalizeConfigPaths(telegramTestConfig.setupFiles)).toEqual([
      "test/setup.ts",
      "test/setup.extensions.ts",
      "test/setup-openclaw-runtime.ts",
    ]);
  });

  it("keeps whatsapp tests out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(
      extensionExcludes.some((pattern) => path.matchesGlob("whatsapp/src/send.test.ts", pattern)),
    ).toBe(true);
  });

  it("keeps voice-call tests out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(
      extensionExcludes.some((pattern) =>
        path.matchesGlob("voice-call/src/runtime.test.ts", pattern),
      ),
    ).toBe(true);
  });

  it("keeps zalo tests out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(
      extensionExcludes.some((pattern) => path.matchesGlob("zalo/src/channel.test.ts", pattern)),
    ).toBe(true);
    expect(
      extensionExcludes.some((pattern) =>
        path.matchesGlob("zalouser/src/channel.test.ts", pattern),
      ),
    ).toBe(true);
  });

  it("keeps provider plugin tests out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(
      extensionExcludes.some((pattern) =>
        path.matchesGlob("openai/openai-codex-provider.test.ts", pattern),
      ),
    ).toBe(true);
  });

  it("keeps messaging plugin tests out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(
      extensionExcludes.some((pattern) => path.matchesGlob("matrix/src/channel.test.ts", pattern)),
    ).toBe(true);
  });

  it("keeps mattermost tests out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(
      extensionExcludes.some((pattern) =>
        path.matchesGlob("mattermost/src/channel.test.ts", pattern),
      ),
    ).toBe(true);
  });

  it("normalizes secrets include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultSecretsConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src", "secrets"));
    expect(testConfig.include).toEqual(["**/*.test.ts"]);
  });

  it("normalizes hooks include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultHooksConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src", "hooks"));
    expect(testConfig.include).toEqual(["**/*.test.ts"]);
  });

  it("keeps memory plugin tests out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(
      extensionExcludes.some((pattern) =>
        path.matchesGlob("memory-core/src/memory/test-runtime-mocks.ts", pattern),
      ),
    ).toBe(true);
  });

  it("keeps feishu tests out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(
      extensionExcludes.some((pattern) => path.matchesGlob("feishu/src/channel.test.ts", pattern)),
    ).toBe(true);
  });

  it("keeps irc tests out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(
      extensionExcludes.some((pattern) => path.matchesGlob("irc/src/channel.test.ts", pattern)),
    ).toBe(true);
  });

  it("keeps acpx tests out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(matchingExcludePatterns(extensionExcludes, "acpx/src/runtime.test.ts")).not.toEqual([]);
  });

  it("keeps diffs tests out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    expect(matchingExcludePatterns(extensionExcludes, "diffs/src/render.test.ts")).not.toEqual([]);
  });

  it("keeps broad dedicated extension groups out of the shared extensions lane", () => {
    const extensionExcludes = defaultExtensionsConfig.test?.exclude ?? [];
    const browserTestConfig = requireTestConfig(defaultExtensionBrowserConfig);
    const mediaTestConfig = requireTestConfig(defaultExtensionMediaConfig);
    const miscTestConfig = requireTestConfig(defaultExtensionMiscConfig);
    const qaTestConfig = requireTestConfig(defaultExtensionQaConfig);
    expect(browserTestConfig.include).toContain("browser/**/*.test.ts");
    expect(mediaTestConfig.include).toContain("vydra/**/*.test.ts");
    expect(miscTestConfig.include).toContain("firecrawl/**/*.test.ts");
    expect(qaTestConfig.include).toContain("qa-lab/**/*.test.ts");
    for (const file of [
      "browser/src/browser/pw.test.ts",
      "vydra/src/index.test.ts",
      "firecrawl/src/index.test.ts",
      "qa-lab/src/index.test.ts",
    ]) {
      expect(matchingExcludePatterns(extensionExcludes, file)).not.toEqual([]);
    }
  });

  it("normalizes gateway include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultGatewayConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src", "gateway"));
    expect(testConfig.include).toEqual(["**/*.test.ts"]);
    expect(testConfig.exclude).toContain("gateway.test.ts");
    expect(testConfig.exclude).toContain("server.startup-matrix-migration.integration.test.ts");
    expect(testConfig.exclude).toContain("sessions-history-http.test.ts");
  });

  it("normalizes infra include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultInfraConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src"));
    expect(testConfig.include).toEqual(["infra/**/*.test.ts"]);
  });

  it("normalizes runtime config include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultRuntimeConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src"));
    expect(testConfig.include).toEqual(["config/**/*.test.ts"]);
  });

  it("normalizes cron include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultCronConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src"));
    expect(testConfig.include).toEqual(["cron/**/*.test.ts"]);
  });

  it("normalizes daemon include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultDaemonConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src"));
    expect(testConfig.include).toEqual(["daemon/**/*.test.ts"]);
  });

  it("normalizes media include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultMediaConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src"));
    expect(testConfig.include).toEqual(["media/**/*.test.ts"]);
  });

  it("normalizes logging include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultLoggingConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src"));
    expect(testConfig.include).toEqual(["logging/**/*.test.ts"]);
  });

  it("normalizes plugin-sdk include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultPluginSdkConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src"));
    expect(testConfig.include).toEqual(["plugin-sdk/**/*.test.ts"]);
  });

  it("normalizes shared-core include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultSharedCoreConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src"));
    expect(testConfig.include).toEqual(["shared/**/*.test.ts"]);
    expect(normalizeConfigPaths(testConfig.setupFiles)).toEqual(["test/setup.ts"]);
  });

  it("normalizes process include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultProcessConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src"));
    expect(testConfig.include).toEqual(["process/**/*.test.ts"]);
  });

  it("normalizes tasks include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultTasksConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src"));
    expect(testConfig.include).toEqual(["tasks/**/*.test.ts"]);
  });

  it("normalizes wizard include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultWizardConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src"));
    expect(testConfig.include).toEqual(["wizard/**/*.test.ts"]);
  });

  it("normalizes tui include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultTuiConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src"));
    expect(testConfig.include).toEqual(["tui/**/*.test.ts"]);
  });

  it("normalizes media-understanding include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultMediaUnderstandingConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src"));
    expect(testConfig.include).toEqual(["media-understanding/**/*.test.ts"]);
  });

  it("keeps tooling tests in their own lane", () => {
    const testConfig = requireTestConfig(defaultToolingConfig);
    expect(testConfig.include).toEqual(
      expect.arrayContaining(["test/**/*.test.ts", "src/scripts/**/*.test.ts"]),
    );
    expect(testConfig.include).not.toContain("src/config/doc-baseline.integration.test.ts");
  });

  it("normalizes acp include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultAcpConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src", "acp"));
    expect(testConfig.include).toEqual(["**/*.test.ts"]);
  });

  it("normalizes cli include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultCliConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src", "cli"));
    expect(testConfig.include).toEqual(["**/*.test.ts"]);
  });

  it("normalizes commands include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultCommandsConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src", "commands"));
    expect(testConfig.include).toEqual(["**/*.test.ts"]);
  });

  it("normalizes auto-reply include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultAutoReplyConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src", "auto-reply"));
    expect(testConfig.include).toEqual(["**/*.test.ts"]);
  });

  it("normalizes agents include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultAgentsConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src", "agents"));
    expect(testConfig.include).toEqual(["**/*.test.ts"]);
  });

  it("normalizes plugins include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultPluginsConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src", "plugins"));
    expect(testConfig.include).toEqual(["**/*.test.ts"]);
    expect(testConfig.exclude).toContain("contracts/**");
  });

  it("normalizes ui include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultUiConfig);
    expect(testConfig.dir).toBe(process.cwd());
    expect(testConfig.include).toEqual(["ui/src/**/*.test.ts"]);
    expect(testConfig.exclude).toContain("ui/src/ui/app-chat.test.ts");
  });

  it("normalizes utils include patterns relative to the scoped dir", () => {
    const testConfig = requireTestConfig(defaultUtilsConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src"));
    expect(testConfig.include).toEqual(["utils/**/*.test.ts"]);
    expect(normalizeConfigPaths(testConfig.setupFiles)).toEqual(["test/setup.ts"]);
  });
});

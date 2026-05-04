import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { getPath } from "./path-utils.js";

const {
  getBootstrapChannelSecretsMock,
  loadBundledPluginPublicArtifactModuleSyncMock,
  loadPluginMetadataSnapshotMock,
} = vi.hoisted(() => ({
  getBootstrapChannelSecretsMock: vi.fn(),
  loadBundledPluginPublicArtifactModuleSyncMock: vi.fn(),
  loadPluginMetadataSnapshotMock: vi.fn(),
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
  listPluginOriginsFromMetadataSnapshot: (snapshot: {
    plugins: Array<{ id: string; origin: PluginOrigin }>;
  }) => new Map(snapshot.plugins.map((record) => [record.id, record.origin])),
}));

vi.mock("../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleSync: loadBundledPluginPublicArtifactModuleSyncMock,
}));

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelSecrets: getBootstrapChannelSecretsMock,
}));

import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

const EXTERNALIZED_CHANNEL_IDS = [
  "bluebubbles",
  "discord",
  "feishu",
  "googlechat",
  "msteams",
  "nextcloud-talk",
  "zalo",
] as const;

type ExternalizedChannelId = (typeof EXTERNALIZED_CHANNEL_IDS)[number];

function ref(id: string) {
  return { source: "env", provider: "default", id };
}

function inactiveExecRef(id: string) {
  return { source: "exec", provider: "vault", id };
}

function createExternalChannelRecord(id: ExternalizedChannelId): PluginManifestRecord {
  const rootDir = path.resolve("extensions", id);
  return {
    id,
    channels: [id],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "global",
    rootDir,
    source: path.join(rootDir, "index.js"),
    manifestPath: path.join(rootDir, "openclaw.plugin.json"),
  };
}

function configureExternalChannelRecords(): PluginManifestRecord[] {
  const records = EXTERNALIZED_CHANNEL_IDS.map((id) => createExternalChannelRecord(id));
  loadPluginMetadataSnapshotMock.mockReturnValue({ plugins: records });
  return records;
}

function externalChannelOrigins(records: readonly PluginManifestRecord[]) {
  return new Map(records.map((record) => [record.id, record.origin] as const));
}

function mockBundledPublicArtifactMiss() {
  loadBundledPluginPublicArtifactModuleSyncMock.mockImplementation(
    (params: { dirName: string; artifactBasename: string }) => {
      throw new Error(
        `Unable to resolve bundled plugin public surface ${params.dirName}/${params.artifactBasename}`,
      );
    },
  );
}

function expectMetadataBackedContractsWereUsed() {
  expect(getBootstrapChannelSecretsMock).not.toHaveBeenCalled();
  expect(loadPluginMetadataSnapshotMock).toHaveBeenCalled();
  for (const channelId of EXTERNALIZED_CHANNEL_IDS) {
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: channelId,
      artifactBasename: "secret-contract-api.js",
    });
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: channelId,
      artifactBasename: "contract-api.js",
    });
  }
}

function expectResolvedPaths(config: OpenClawConfig, expected: Record<string, unknown>) {
  for (const [pathKey, expectedValue] of Object.entries(expected)) {
    expect(getPath(config, pathKey.split(".")), pathKey).toBe(expectedValue);
  }
}

describe("secrets runtime externalized channel SecretRef audit", () => {
  beforeEach(() => {
    getBootstrapChannelSecretsMock.mockReset();
    getBootstrapChannelSecretsMock.mockReturnValue(undefined);
    loadBundledPluginPublicArtifactModuleSyncMock.mockReset();
    mockBundledPublicArtifactMiss();
    loadPluginMetadataSnapshotMock.mockReset();
  });

  it("resolves active SecretRef targets for every externalized channel contract", async () => {
    const records = configureExternalChannelRecords();
    const config = asConfig({
      channels: {
        bluebubbles: {
          serverUrl: "http://127.0.0.1:1234",
          password: ref("BLUEBUBBLES_PASSWORD"),
          accounts: {
            inherited: {
              enabled: true,
            },
            work: {
              enabled: true,
              serverUrl: "http://127.0.0.1:1235",
              password: ref("BLUEBUBBLES_WORK_PASSWORD"),
            },
          },
        },
        discord: {
          token: ref("DISCORD_TOKEN"),
          pluralkit: {
            enabled: true,
            token: ref("DISCORD_PLURALKIT_TOKEN"),
          },
          voice: {
            enabled: true,
            tts: {
              providers: {
                openai: { apiKey: ref("DISCORD_VOICE_TTS_API_KEY") },
              },
            },
          },
          accounts: {
            inherited: {
              enabled: true,
            },
            work: {
              enabled: true,
              token: ref("DISCORD_WORK_TOKEN"),
              pluralkit: {
                enabled: true,
                token: ref("DISCORD_WORK_PLURALKIT_TOKEN"),
              },
              voice: {
                enabled: true,
                tts: {
                  providers: {
                    openai: { apiKey: ref("DISCORD_WORK_VOICE_TTS_API_KEY") },
                  },
                },
              },
            },
          },
        },
        feishu: {
          connectionMode: "webhook",
          appSecret: ref("FEISHU_APP_SECRET"),
          encryptKey: ref("FEISHU_ENCRYPT_KEY"),
          verificationToken: ref("FEISHU_VERIFICATION_TOKEN"),
          accounts: {
            inherited: {
              enabled: true,
              connectionMode: "webhook",
            },
            work: {
              enabled: true,
              connectionMode: "webhook",
              appSecret: ref("FEISHU_WORK_APP_SECRET"),
              encryptKey: ref("FEISHU_WORK_ENCRYPT_KEY"),
              verificationToken: ref("FEISHU_WORK_VERIFICATION_TOKEN"),
            },
          },
        },
        googlechat: {
          serviceAccountRef: ref("GOOGLECHAT_SERVICE_ACCOUNT"),
          accounts: {
            inherited: {
              enabled: true,
            },
            work: {
              enabled: true,
              serviceAccountRef: ref("GOOGLECHAT_WORK_SERVICE_ACCOUNT"),
            },
          },
        },
        msteams: {
          appPassword: ref("MSTEAMS_APP_PASSWORD"),
        },
        "nextcloud-talk": {
          botSecret: ref("NEXTCLOUD_TALK_BOT_SECRET"),
          apiPassword: ref("NEXTCLOUD_TALK_API_PASSWORD"),
          accounts: {
            inherited: {
              enabled: true,
            },
            work: {
              enabled: true,
              botSecret: ref("NEXTCLOUD_TALK_WORK_BOT_SECRET"),
              apiPassword: ref("NEXTCLOUD_TALK_WORK_API_PASSWORD"),
            },
          },
        },
        zalo: {
          webhookUrl: "https://example.test/zalo",
          botToken: ref("ZALO_BOT_TOKEN"),
          webhookSecret: ref("ZALO_WEBHOOK_SECRET"),
          accounts: {
            inherited: {
              enabled: true,
            },
            work: {
              enabled: true,
              webhookUrl: "https://example.test/zalo-work",
              botToken: ref("ZALO_WORK_BOT_TOKEN"),
              webhookSecret: ref("ZALO_WORK_WEBHOOK_SECRET"),
            },
          },
        },
      },
    });

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env: {
        BLUEBUBBLES_PASSWORD: "bluebubbles-password",
        BLUEBUBBLES_WORK_PASSWORD: "bluebubbles-work-password",
        DISCORD_TOKEN: "discord-token",
        DISCORD_PLURALKIT_TOKEN: "discord-pluralkit-token",
        DISCORD_VOICE_TTS_API_KEY: "discord-voice-tts-api-key",
        DISCORD_WORK_TOKEN: "discord-work-token",
        DISCORD_WORK_PLURALKIT_TOKEN: "discord-work-pluralkit-token",
        DISCORD_WORK_VOICE_TTS_API_KEY: "discord-work-voice-tts-api-key",
        FEISHU_APP_SECRET: "feishu-app-secret",
        FEISHU_ENCRYPT_KEY: "feishu-encrypt-key",
        FEISHU_VERIFICATION_TOKEN: "feishu-verification-token",
        FEISHU_WORK_APP_SECRET: "feishu-work-app-secret",
        FEISHU_WORK_ENCRYPT_KEY: "feishu-work-encrypt-key",
        FEISHU_WORK_VERIFICATION_TOKEN: "feishu-work-verification-token",
        GOOGLECHAT_SERVICE_ACCOUNT: "googlechat-service-account",
        GOOGLECHAT_WORK_SERVICE_ACCOUNT: "googlechat-work-service-account",
        MSTEAMS_APP_PASSWORD: "msteams-app-password",
        NEXTCLOUD_TALK_BOT_SECRET: "nextcloud-talk-bot-secret",
        NEXTCLOUD_TALK_API_PASSWORD: "nextcloud-talk-api-password",
        NEXTCLOUD_TALK_WORK_BOT_SECRET: "nextcloud-talk-work-bot-secret",
        NEXTCLOUD_TALK_WORK_API_PASSWORD: "nextcloud-talk-work-api-password",
        ZALO_BOT_TOKEN: "zalo-bot-token",
        ZALO_WEBHOOK_SECRET: "zalo-webhook-secret",
        ZALO_WORK_BOT_TOKEN: "zalo-work-bot-token",
        ZALO_WORK_WEBHOOK_SECRET: "zalo-work-webhook-secret",
      },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: externalChannelOrigins(records),
    });

    expectResolvedPaths(snapshot.config, {
      "channels.bluebubbles.password": "bluebubbles-password",
      "channels.bluebubbles.accounts.work.password": "bluebubbles-work-password",
      "channels.discord.token": "discord-token",
      "channels.discord.pluralkit.token": "discord-pluralkit-token",
      "channels.discord.voice.tts.providers.openai.apiKey": "discord-voice-tts-api-key",
      "channels.discord.accounts.work.token": "discord-work-token",
      "channels.discord.accounts.work.pluralkit.token": "discord-work-pluralkit-token",
      "channels.discord.accounts.work.voice.tts.providers.openai.apiKey":
        "discord-work-voice-tts-api-key",
      "channels.feishu.appSecret": "feishu-app-secret",
      "channels.feishu.encryptKey": "feishu-encrypt-key",
      "channels.feishu.verificationToken": "feishu-verification-token",
      "channels.feishu.accounts.work.appSecret": "feishu-work-app-secret",
      "channels.feishu.accounts.work.encryptKey": "feishu-work-encrypt-key",
      "channels.feishu.accounts.work.verificationToken": "feishu-work-verification-token",
      "channels.googlechat.serviceAccount": "googlechat-service-account",
      "channels.googlechat.accounts.work.serviceAccount": "googlechat-work-service-account",
      "channels.msteams.appPassword": "msteams-app-password",
      "channels.nextcloud-talk.botSecret": "nextcloud-talk-bot-secret",
      "channels.nextcloud-talk.apiPassword": "nextcloud-talk-api-password",
      "channels.nextcloud-talk.accounts.work.botSecret": "nextcloud-talk-work-bot-secret",
      "channels.nextcloud-talk.accounts.work.apiPassword": "nextcloud-talk-work-api-password",
      "channels.zalo.botToken": "zalo-bot-token",
      "channels.zalo.webhookSecret": "zalo-webhook-secret",
      "channels.zalo.accounts.work.botToken": "zalo-work-bot-token",
      "channels.zalo.accounts.work.webhookSecret": "zalo-work-webhook-secret",
    });
    expect(snapshot.warnings).toEqual([]);
    expectMetadataBackedContractsWereUsed();
  });

  it("skips inactive exec-backed SecretRefs for every externalized channel contract", async () => {
    const records = configureExternalChannelRecords();
    const config = asConfig({
      channels: {
        bluebubbles: {
          enabled: false,
          password: inactiveExecRef("BLUEBUBBLES_DISABLED_PASSWORD"),
          accounts: {
            disabled: {
              enabled: false,
              password: inactiveExecRef("BLUEBUBBLES_DISABLED_ACCOUNT_PASSWORD"),
            },
          },
        },
        discord: {
          enabled: false,
          token: inactiveExecRef("DISCORD_DISABLED_TOKEN"),
          pluralkit: {
            enabled: true,
            token: inactiveExecRef("DISCORD_DISABLED_PLURALKIT_TOKEN"),
          },
          voice: {
            enabled: true,
            tts: {
              providers: {
                openai: { apiKey: inactiveExecRef("DISCORD_DISABLED_VOICE_TTS_API_KEY") },
              },
            },
          },
          accounts: {
            disabled: {
              enabled: false,
              token: inactiveExecRef("DISCORD_DISABLED_ACCOUNT_TOKEN"),
              pluralkit: {
                enabled: true,
                token: inactiveExecRef("DISCORD_DISABLED_ACCOUNT_PLURALKIT_TOKEN"),
              },
              voice: {
                enabled: true,
                tts: {
                  providers: {
                    openai: {
                      apiKey: inactiveExecRef("DISCORD_DISABLED_ACCOUNT_VOICE_TTS_API_KEY"),
                    },
                  },
                },
              },
            },
          },
        },
        feishu: {
          enabled: false,
          connectionMode: "webhook",
          appSecret: inactiveExecRef("FEISHU_DISABLED_APP_SECRET"),
          encryptKey: inactiveExecRef("FEISHU_DISABLED_ENCRYPT_KEY"),
          verificationToken: inactiveExecRef("FEISHU_DISABLED_VERIFICATION_TOKEN"),
          accounts: {
            disabled: {
              enabled: false,
              connectionMode: "webhook",
              appSecret: inactiveExecRef("FEISHU_DISABLED_ACCOUNT_APP_SECRET"),
              encryptKey: inactiveExecRef("FEISHU_DISABLED_ACCOUNT_ENCRYPT_KEY"),
              verificationToken: inactiveExecRef("FEISHU_DISABLED_ACCOUNT_VERIFICATION_TOKEN"),
            },
          },
        },
        googlechat: {
          enabled: false,
          serviceAccountRef: inactiveExecRef("GOOGLECHAT_DISABLED_SERVICE_ACCOUNT"),
          accounts: {
            disabled: {
              enabled: false,
              serviceAccountRef: inactiveExecRef("GOOGLECHAT_DISABLED_ACCOUNT_SERVICE_ACCOUNT"),
            },
          },
        },
        msteams: {
          enabled: false,
          appPassword: inactiveExecRef("MSTEAMS_DISABLED_APP_PASSWORD"),
        },
        "nextcloud-talk": {
          enabled: false,
          botSecret: inactiveExecRef("NEXTCLOUD_TALK_DISABLED_BOT_SECRET"),
          apiPassword: inactiveExecRef("NEXTCLOUD_TALK_DISABLED_API_PASSWORD"),
          accounts: {
            disabled: {
              enabled: false,
              botSecret: inactiveExecRef("NEXTCLOUD_TALK_DISABLED_ACCOUNT_BOT_SECRET"),
              apiPassword: inactiveExecRef("NEXTCLOUD_TALK_DISABLED_ACCOUNT_API_PASSWORD"),
            },
          },
        },
        zalo: {
          enabled: false,
          webhookUrl: "https://example.test/zalo-disabled",
          botToken: inactiveExecRef("ZALO_DISABLED_BOT_TOKEN"),
          webhookSecret: inactiveExecRef("ZALO_DISABLED_WEBHOOK_SECRET"),
          accounts: {
            disabled: {
              enabled: false,
              webhookUrl: "https://example.test/zalo-account-disabled",
              botToken: inactiveExecRef("ZALO_DISABLED_ACCOUNT_BOT_TOKEN"),
              webhookSecret: inactiveExecRef("ZALO_DISABLED_ACCOUNT_WEBHOOK_SECRET"),
            },
          },
        },
      },
    });

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
      loadablePluginOrigins: externalChannelOrigins(records),
    });

    expect(getPath(snapshot.config, ["channels", "discord", "token"])).toEqual(
      inactiveExecRef("DISCORD_DISABLED_TOKEN"),
    );
    expect(
      getPath(snapshot.config, ["channels", "zalo", "accounts", "disabled", "botToken"]),
    ).toEqual(inactiveExecRef("ZALO_DISABLED_ACCOUNT_BOT_TOKEN"));
    expect(snapshot.warnings.map((warning) => warning.path)).toEqual(
      expect.arrayContaining([
        "channels.bluebubbles.password",
        "channels.bluebubbles.accounts.disabled.password",
        "channels.discord.token",
        "channels.discord.pluralkit.token",
        "channels.discord.voice.tts.providers.openai.apiKey",
        "channels.discord.accounts.disabled.token",
        "channels.discord.accounts.disabled.pluralkit.token",
        "channels.discord.accounts.disabled.voice.tts.providers.openai.apiKey",
        "channels.feishu.appSecret",
        "channels.feishu.encryptKey",
        "channels.feishu.verificationToken",
        "channels.feishu.accounts.disabled.appSecret",
        "channels.feishu.accounts.disabled.encryptKey",
        "channels.feishu.accounts.disabled.verificationToken",
        "channels.googlechat.serviceAccount",
        "channels.googlechat.accounts.disabled.serviceAccount",
        "channels.msteams.appPassword",
        "channels.nextcloud-talk.botSecret",
        "channels.nextcloud-talk.apiPassword",
        "channels.nextcloud-talk.accounts.disabled.botSecret",
        "channels.nextcloud-talk.accounts.disabled.apiPassword",
        "channels.zalo.botToken",
        "channels.zalo.webhookSecret",
        "channels.zalo.accounts.disabled.botToken",
        "channels.zalo.accounts.disabled.webhookSecret",
      ]),
    );
    expectMetadataBackedContractsWereUsed();
  });
});

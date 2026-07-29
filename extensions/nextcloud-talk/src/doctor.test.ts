// Nextcloud Talk tests cover doctor plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPersistentDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NEXTCLOUD_TALK_PLUGIN_ID,
  NEXTCLOUD_TALK_REPLAY_DEDUPE_MAX_ENTRIES,
  NEXTCLOUD_TALK_REPLAY_DEDUPE_NAMESPACE_PREFIX,
  NEXTCLOUD_TALK_REPLAY_DEDUPE_TTL_MS,
} from "./replay-migration-contract.js";

const hoisted = vi.hoisted(() => ({
  probeNextcloudTalkBotResponseFeature: vi.fn(),
}));

vi.mock("./bot-preflight.js", () => ({
  probeNextcloudTalkBotResponseFeature: hoisted.probeNextcloudTalkBotResponseFeature,
}));

const { nextcloudTalkDoctor } = await import("./doctor.js");

function getNextcloudTalkCompatibilityNormalizer(): NonNullable<
  typeof nextcloudTalkDoctor.normalizeCompatibilityConfig
> {
  const normalize = nextcloudTalkDoctor.normalizeCompatibilityConfig;
  if (!normalize) {
    throw new Error("Expected nextcloud-talk doctor to expose normalizeCompatibilityConfig");
  }
  return normalize;
}

describe("nextcloud-talk doctor", () => {
  beforeEach(() => {
    hoisted.probeNextcloudTalkBotResponseFeature.mockReset();
    resetPluginStateStoreForTests();
  });

  it("normalizes legacy private-network aliases", () => {
    const normalize = getNextcloudTalkCompatibilityNormalizer();

    const result = normalize({
      cfg: {
        channels: {
          "nextcloud-talk": {
            allowPrivateNetwork: true,
            accounts: {
              work: {
                allowPrivateNetwork: false,
              },
            },
          },
        },
      } as never,
    });

    expect(result.config.channels?.["nextcloud-talk"]?.network).toEqual({
      dangerouslyAllowPrivateNetwork: true,
    });
    expect(
      (
        result.config.channels?.["nextcloud-talk"]?.accounts?.work as
          | { network?: Record<string, unknown> }
          | undefined
      )?.network,
    ).toEqual({
      dangerouslyAllowPrivateNetwork: false,
    });
  });

  it("warns when the configured bot is missing the response feature", async () => {
    hoisted.probeNextcloudTalkBotResponseFeature.mockResolvedValueOnce({
      ok: false,
      code: "missing_response_feature",
      message:
        'Nextcloud Talk bot "OpenClaw" (1) is missing the response feature (features=9); outbound replies will fail.',
    });

    await expect(
      nextcloudTalkDoctor.collectPreviewWarnings?.({
        cfg: {
          channels: {
            "nextcloud-talk": {
              baseUrl: "https://cloud.example.com",
              botSecret: "secret",
              apiUser: "admin",
              apiPassword: "app-password",
              webhookPublicUrl: "https://gateway.example.com/nextcloud-talk-webhook",
            },
          },
        } as never,
        doctorFixCommand: "openclaw doctor --fix",
      }),
    ).resolves.toEqual([
      '- channels.nextcloud-talk.default: Nextcloud Talk bot "OpenClaw" (1) is missing the response feature (features=9); outbound replies will fail.',
    ]);
  });

  it("migrates legacy replay dedupe JSON into SQLite during doctor repair", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-nextcloud-doctor-"));
    const canonicalStateDir = await fs.realpath(stateDir);
    const legacyDir = path.join(canonicalStateDir, "nextcloud-talk", "replay-dedupe");
    const legacyPath = path.join(legacyDir, "account-a.json");
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(
      legacyPath,
      JSON.stringify({
        "room-1:msg-1": Date.now(),
      }),
    );

    const env = { ...process.env, OPENCLAW_STATE_DIR: canonicalStateDir };
    const mutation = await nextcloudTalkDoctor.repairConfig?.({
      cfg: {
        channels: {
          "nextcloud-talk": {
            accounts: {
              "account-a": {
                baseUrl: "https://cloud.example.com",
                botSecret: "secret",
              },
            },
          },
        },
      } as never,
      doctorFixCommand: "openclaw doctor --fix",
      env,
    });

    expect(mutation?.changes.join("\n")).toContain(
      'Migrated Nextcloud Talk replay dedupe cache for account "account-a" to SQLite',
    );
    await expect(fs.access(legacyPath)).rejects.toThrow();

    const dedupe = createPersistentDedupe({
      ttlMs: NEXTCLOUD_TALK_REPLAY_DEDUPE_TTL_MS,
      memoryMaxSize: 0,
      pluginId: NEXTCLOUD_TALK_PLUGIN_ID,
      namespacePrefix: NEXTCLOUD_TALK_REPLAY_DEDUPE_NAMESPACE_PREFIX,
      stateMaxEntries: NEXTCLOUD_TALK_REPLAY_DEDUPE_MAX_ENTRIES,
      env,
    });
    await expect(dedupe.hasRecent("room-1:msg-1", { namespace: "account-a" })).resolves.toBe(true);
  });
});

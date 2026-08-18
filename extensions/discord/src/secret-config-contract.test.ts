import type { ResolverContext } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { describe, expect, it } from "vitest";
import {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "./secret-config-contract.js";

const secretRef = (id: string) => ({ source: "env", provider: "default", id }) as const;

function createContext(): ResolverContext {
  return {
    sourceConfig: {},
    env: {},
    cache: {},
    warnings: [],
    warningKeys: new Set(),
    assignments: [],
  };
}

describe("Discord secret target registry", () => {
  it.each([
    [
      "channels.discord.voice.realtime.providers.*.apiKey",
      "channels.discord.voice.realtime.providers.openai.apiKey",
    ],
    [
      "channels.discord.voice.tts.providers.*.apiKey",
      "channels.discord.voice.tts.providers.openai.apiKey",
    ],
    [
      "channels.discord.accounts.*.voice.realtime.providers.*.apiKey",
      "channels.discord.accounts.work.voice.realtime.providers.openai.apiKey",
    ],
    [
      "channels.discord.accounts.*.voice.tts.providers.*.apiKey",
      "channels.discord.accounts.work.voice.tts.providers.openai.apiKey",
    ],
  ])("identifies the provider segment for %s", (targetId, concretePath) => {
    const entry = secretTargetRegistryEntries.find((candidate) => candidate.id === targetId);

    expect(entry).toBeDefined();
    if (!entry || typeof entry.providerIdPathSegmentIndex !== "number") {
      throw new Error(`Missing provider segment metadata for ${targetId}`);
    }
    expect(concretePath.split(".")[entry.providerIdPathSegmentIndex]).toBe("openai");
  });

  it("partitions realtime owners by account and provider", () => {
    const context = createContext();
    collectRuntimeConfigAssignments({
      config: {
        channels: {
          discord: {
            voice: {
              enabled: true,
              realtime: {
                providers: {
                  openai: { apiKey: secretRef("ROOT_OPENAI") },
                  mistral: { apiKey: secretRef("ROOT_MISTRAL") },
                },
              },
            },
            accounts: {
              inherited: { enabled: true },
              work: {
                enabled: true,
                voice: {
                  enabled: true,
                  realtime: {
                    providers: {
                      openai: { apiKey: secretRef("WORK_OPENAI") },
                    },
                  },
                },
              },
            },
          },
        },
      },
      context,
    });

    expect(
      context.assignments
        .filter((assignment) => assignment.path.includes("voice.realtime"))
        .map(({ ownerId, path }) => ({ ownerId, path })),
    ).toStrictEqual([
      {
        ownerId: "discord:voice:realtime:inherited:openai",
        path: "channels.discord.voice.realtime.providers.openai.apiKey",
      },
      {
        ownerId: "discord:voice:realtime:inherited:mistral",
        path: "channels.discord.voice.realtime.providers.mistral.apiKey",
      },
      {
        ownerId: "discord:voice:realtime:work:openai",
        path: "channels.discord.accounts.work.voice.realtime.providers.openai.apiKey",
      },
    ]);
  });

  it("skips realtime provider refs when Discord voice uses stt-tts mode", () => {
    const context = createContext();
    collectRuntimeConfigAssignments({
      config: {
        channels: {
          discord: {
            voice: {
              enabled: true,
              mode: "stt-tts",
              realtime: {
                providers: {
                  openai: { apiKey: secretRef("UNUSED_REALTIME_KEY") },
                },
              },
            },
            accounts: {
              inherited: { enabled: true },
              work: {
                enabled: true,
                voice: {
                  enabled: true,
                  mode: "stt-tts",
                  realtime: {
                    providers: {
                      openai: { apiKey: secretRef("UNUSED_WORK_REALTIME_KEY") },
                    },
                  },
                },
              },
            },
          },
        },
      },
      context,
    });

    expect(context.assignments).toStrictEqual([]);
    expect(context.warnings).toMatchObject([
      {
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "channels.discord.voice.realtime.providers.openai.apiKey",
      },
      {
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "channels.discord.accounts.work.voice.realtime.providers.openai.apiKey",
      },
    ]);
  });
});

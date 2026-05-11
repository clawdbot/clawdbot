import { beforeEach, describe, expect, it, vi } from "vitest";

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
});

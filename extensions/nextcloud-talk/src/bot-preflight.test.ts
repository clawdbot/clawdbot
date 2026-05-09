import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";

const hoisted = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  ssrfPolicyFromPrivateNetworkOptIn: vi.fn(() => undefined),
}));

vi.mock("../runtime-api.js", () => ({
  fetchWithSsrFGuard: hoisted.fetchWithSsrFGuard,
}));

vi.mock("./send.runtime.js", () => ({
  ssrfPolicyFromPrivateNetworkOptIn: hoisted.ssrfPolicyFromPrivateNetworkOptIn,
}));

const { probeNextcloudTalkBotResponseFeature } = await import("./bot-preflight.js");

function account(
  overrides: Partial<ResolvedNextcloudTalkAccount> = {},
): ResolvedNextcloudTalkAccount {
  return {
    accountId: "default",
    enabled: true,
    baseUrl: "https://cloud.example.com",
    secret: "secret",
    secretSource: "config",
    config: {
      baseUrl: "https://cloud.example.com",
      botSecret: "secret",
      apiUser: "admin",
      apiPassword: "app-password",
      webhookPublicUrl: "https://bot.example.com/nextcloud-talk-webhook",
    },
    ...overrides,
  };
}

function mockBotAdmin(features: number): void {
  hoisted.fetchWithSsrFGuard.mockResolvedValueOnce({
    response: new Response(
      JSON.stringify({
        ocs: {
          data: [
            {
              id: 7,
              name: "OpenClaw",
              url: "https://bot.example.com/nextcloud-talk-webhook",
              features,
            },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    release: async () => {},
    finalUrl: "https://cloud.example.com/ocs/v2.php/apps/spreed/api/v1/bot/admin",
  });
}

describe("probeNextcloudTalkBotResponseFeature", () => {
  beforeEach(() => {
    hoisted.fetchWithSsrFGuard.mockClear();
  });

  afterEach(() => {
    hoisted.fetchWithSsrFGuard.mockReset();
  });

  it("passes when the matching bot has the response feature bit", async () => {
    mockBotAdmin(1 | 2 | 8);

    await expect(
      probeNextcloudTalkBotResponseFeature({ account: account() }),
    ).resolves.toMatchObject({
      ok: true,
      code: "ok",
      botId: "7",
      features: 11,
    });
  });

  it("reports missing response feature for the matching webhook bot", async () => {
    mockBotAdmin(1 | 8);

    await expect(
      probeNextcloudTalkBotResponseFeature({ account: account() }),
    ).resolves.toMatchObject({
      ok: false,
      code: "missing_response_feature",
      botId: "7",
      features: 9,
      message: expect.stringContaining("--feature response"),
    });
  });

  it("skips when API credentials are absent", async () => {
    await expect(
      probeNextcloudTalkBotResponseFeature({
        account: account({
          config: {
            baseUrl: "https://cloud.example.com",
            botSecret: "secret",
            webhookPublicUrl: "https://bot.example.com/nextcloud-talk-webhook",
          },
        }),
      }),
    ).resolves.toMatchObject({
      ok: true,
      skipped: true,
      code: "missing_api_credentials",
    });
    expect(hoisted.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });
});

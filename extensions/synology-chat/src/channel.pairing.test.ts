// Synology Chat tests cover channel pairing plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientModule = await import("./client.js");
const mockSendMessage = vi.spyOn(clientModule, "sendMessage").mockResolvedValue(true);

const { synologyChatPlugin } = await import("./channel.js");

const PAIRING_CFG = {
  channels: {
    "synology-chat": {
      token: "default-token",
      incomingUrl: "https://nas-default/incoming",
      webhookUrl: "https://gateway.example.com/w",
      allowInsecureSsl: false,
      accounts: {
        beta: {
          token: "beta-token",
          incomingUrl: "https://nas-beta/incoming",
          webhookUrl: "https://gateway.example.com/beta",
          allowInsecureSsl: true,
        },
      },
    },
  },
};

describe("synologyChatPlugin pairing.notifyApproval", () => {
  beforeEach(() => {
    vi.stubEnv("SYNOLOGY_CHAT_TOKEN", "");
    vi.stubEnv("SYNOLOGY_CHAT_INCOMING_URL", "");
    mockSendMessage.mockClear();
    mockSendMessage.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    {
      name: "the approved account",
      accountId: "beta",
      incomingUrl: "https://nas-beta/incoming",
      allowInsecureSsl: true,
    },
    {
      name: "the default account when no account was approved",
      accountId: undefined,
      incomingUrl: "https://nas-default/incoming",
      allowInsecureSsl: false,
    },
  ])("notifies through $name", async ({ accountId, incomingUrl, allowInsecureSsl }) => {
    const notifyApproval = synologyChatPlugin.pairing.notifyApproval;
    if (!notifyApproval) {
      throw new Error("synology-chat pairing helpers unavailable");
    }

    await notifyApproval({
      cfg: PAIRING_CFG,
      id: "USER2",
      ...(accountId ? { accountId } : {}),
    });

    expect(mockSendMessage).toHaveBeenCalledExactlyOnceWith(
      incomingUrl,
      expect.any(String),
      "USER2",
      allowInsecureSsl,
    );
  });
});

import { describe, expect, it, vi } from "vitest";
import { buildTelegramQaConfig, waitForTelegramChannelRunning } from "./telegram-api.runtime.js";

describe("Telegram QA API boundary", () => {
  it("builds the isolated Test Server gateway config", () => {
    const config = buildTelegramQaConfig(
      { plugins: { allow: ["qa-lab"] } },
      {
        apiRoot: "http://127.0.0.1:8080",
        groupId: "-100123",
        sutToken: "placeholder",
        testerUserId: "1",
        sutAccountId: "sut",
      },
    );

    expect(config.plugins?.allow).toEqual(["qa-lab", "telegram"]);
    expect(config.channels?.telegram?.groups).toBeUndefined();
    expect(config.channels?.telegram).toMatchObject({
      enabled: true,
      defaultAccount: "sut",
      accounts: {
        sut: {
          botToken: "placeholder",
          apiRoot: "http://127.0.0.1:8080",
          dmPolicy: "disabled",
          groups: {
            "-100123": {
              groupPolicy: "allowlist",
              allowFrom: ["1"],
              requireMention: true,
            },
          },
        },
      },
    });
  });

  it("allows only the leased tester in direct-message mode", () => {
    const config = buildTelegramQaConfig(
      {},
      {
        apiRoot: "http://127.0.0.1:8080",
        directMessageOnly: true,
        groupId: "-100123",
        sutToken: "placeholder",
        testerUserId: "1",
        sutAccountId: "sut",
      },
    );

    expect(config.channels?.telegram?.accounts?.sut).toMatchObject({
      allowFrom: ["1"],
      dmPolicy: "allowlist",
    });
  });

  it("waits for the selected Telegram account to connect", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        channelAccounts: {
          telegram: [{ accountId: "sut", running: true, connected: false }],
        },
      })
      .mockResolvedValueOnce({
        channelAccounts: {
          telegram: [{ accountId: "sut", running: true, connected: true }],
        },
      });

    await waitForTelegramChannelRunning({ call }, "sut", { timeoutMs: 100, pollMs: 1 });

    expect(call).toHaveBeenCalledTimes(2);
  });
});

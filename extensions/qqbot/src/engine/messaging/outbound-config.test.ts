import { describe, expect, it } from "vitest";
import type { GatewayAccount } from "../types.js";
import { sendMedia, sendText } from "./outbound.js";

function makeAccount(accountId: string): GatewayAccount {
  return {
    accountId,
    appId: "",
    clientSecret: "",
    markdownSupport: false,
    config: {},
  };
}

describe("QQBot outbound configuration guidance", () => {
  it("returns default-account recovery paths from sendText", async () => {
    const result = await sendText({
      account: makeAccount("default"),
      to: "user-openid",
      text: "hello",
    });

    expect(result.error).toContain("channels.qqbot.appId");
    expect(result.error).toContain("QQBOT_APP_ID and QQBOT_CLIENT_SECRET");
  });

  it("returns named-account recovery paths from sendMedia", async () => {
    const result = await sendMedia({
      account: makeAccount("operations"),
      accountId: "operations",
      to: "user-openid",
      text: "",
      mediaUrl: "https://example.com/image.png",
    });

    expect(result.error).toContain("channels.qqbot.accounts.operations.appId");
    expect(result.error).not.toContain("QQBOT_APP_ID");
    expect(result.error).not.toContain("QQBOT_CLIENT_SECRET");
  });

  it.each([
    ["default", "<qqimg>https://example.com/image.png</qqimg>", "channels.qqbot.appId", true],
    [
      "operations",
      "report <qqfile>https://example.com/report.pdf</qqfile>",
      "channels.qqbot.accounts.operations.appId",
      false,
    ],
  ] as const)(
    "preflights tagged media for the %s account",
    async (accountId, text, expectedPath, expectsDefaultEnv) => {
      const result = await sendText({
        account: makeAccount(accountId),
        to: "user-openid",
        text,
      });

      expect(result.error).toContain(expectedPath);
      if (expectsDefaultEnv) {
        expect(result.error).toContain("QQBOT_APP_ID and QQBOT_CLIENT_SECRET");
      } else {
        expect(result.error).not.toContain("QQBOT_APP_ID");
        expect(result.error).not.toContain("QQBOT_CLIENT_SECRET");
      }
    },
  );
});

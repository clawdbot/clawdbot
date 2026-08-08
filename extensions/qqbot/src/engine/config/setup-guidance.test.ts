import { describe, expect, it } from "vitest";
import {
  qqbotApiGuidance,
  qqbotNetworkGuidance,
  qqbotNotConfiguredMessage,
} from "./setup-guidance.js";

describe("QQBot setup guidance", () => {
  it("offers default-account config and environment variables", () => {
    const message = qqbotNotConfiguredMessage("default");

    expect(message).toContain("channels.qqbot.appId");
    expect(message).toContain("QQBOT_APP_ID and QQBOT_CLIENT_SECRET");
    expect(message).toContain("https://docs.openclaw.ai/channels/qqbot");
  });

  it("directs named accounts to account-scoped config without default-only environment variables", () => {
    const message = qqbotNotConfiguredMessage("operations");

    expect(message).toContain("channels.qqbot.accounts.operations.appId");
    expect(message).toContain("clientSecret (or clientSecretFile)");
    expect(message).not.toContain("QQBOT_APP_ID");
    expect(message).not.toContain("QQBOT_CLIENT_SECRET");
  });

  it("keeps authentication guidance account-neutral", () => {
    const message = qqbotApiGuidance(401);

    expect(message).toContain("QQBot account appId");
    expect(message).toContain("https://q.qq.com/");
    expect(message).not.toContain("QQBOT_APP_ID");
    expect(message).not.toContain("QQBOT_CLIENT_SECRET");
  });

  it("keeps network guidance cause-specific", () => {
    const message = qqbotNetworkGuidance();

    expect(message).toContain("network connectivity and DNS");
    expect(message).toContain("server IP whitelist");
    expect(message).not.toContain("appId");
    expect(message).not.toContain("clientSecret");
  });

  it("uses credential guidance for HTTP and QQ business-code auth failures", () => {
    expect(qqbotApiGuidance(401)).toContain("appId and clientSecret");
    expect(qqbotApiGuidance(500, 11244)).toContain("appId and clientSecret");
    expect(qqbotApiGuidance(403)).not.toContain("appId");
    expect(qqbotApiGuidance(500, 40034025)).not.toContain("appId");
    expect(qqbotApiGuidance(429)).not.toContain("appId");
  });
});

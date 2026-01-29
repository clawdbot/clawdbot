import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveZoomCredentials, clearZoomTokenCache } from "./token.js";

describe("resolveZoomCredentials", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    clearZoomTokenCache();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns undefined when no credentials configured", () => {
    delete process.env.ZOOM_CLIENT_ID;
    delete process.env.ZOOM_CLIENT_SECRET;
    delete process.env.ZOOM_ACCOUNT_ID;
    delete process.env.ZOOM_BOT_JID;

    const result = resolveZoomCredentials({});
    expect(result).toBeUndefined();
  });

  it("resolves credentials from config", () => {
    const result = resolveZoomCredentials({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      accountId: "test-account-id",
      botJid: "bot@xmpp.zoom.us",
    });

    expect(result).toEqual({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      accountId: "test-account-id",
      botJid: "bot@xmpp.zoom.us",
      webhookSecretToken: undefined,
    });
  });

  it("resolves credentials from environment variables", () => {
    process.env.ZOOM_CLIENT_ID = "env-client-id";
    process.env.ZOOM_CLIENT_SECRET = "env-client-secret";
    process.env.ZOOM_ACCOUNT_ID = "env-account-id";
    process.env.ZOOM_BOT_JID = "envbot@xmpp.zoom.us";

    const result = resolveZoomCredentials({});

    expect(result).toEqual({
      clientId: "env-client-id",
      clientSecret: "env-client-secret",
      accountId: "env-account-id",
      botJid: "envbot@xmpp.zoom.us",
      webhookSecretToken: undefined,
    });
  });

  it("prefers config over environment variables", () => {
    process.env.ZOOM_CLIENT_ID = "env-client-id";
    process.env.ZOOM_CLIENT_SECRET = "env-client-secret";
    process.env.ZOOM_ACCOUNT_ID = "env-account-id";
    process.env.ZOOM_BOT_JID = "envbot@xmpp.zoom.us";

    const result = resolveZoomCredentials({
      clientId: "config-client-id",
      clientSecret: "config-client-secret",
      accountId: "config-account-id",
      botJid: "configbot@xmpp.zoom.us",
    });

    expect(result).toEqual({
      clientId: "config-client-id",
      clientSecret: "config-client-secret",
      accountId: "config-account-id",
      botJid: "configbot@xmpp.zoom.us",
      webhookSecretToken: undefined,
    });
  });

  it("includes webhook secret token when provided", () => {
    const result = resolveZoomCredentials({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      accountId: "test-account-id",
      botJid: "bot@xmpp.zoom.us",
      webhookSecretToken: "webhook-secret",
    });

    expect(result?.webhookSecretToken).toBe("webhook-secret");
  });

  it("returns undefined when missing clientId", () => {
    const result = resolveZoomCredentials({
      clientSecret: "test-client-secret",
      accountId: "test-account-id",
      botJid: "bot@xmpp.zoom.us",
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when missing clientSecret", () => {
    const result = resolveZoomCredentials({
      clientId: "test-client-id",
      accountId: "test-account-id",
      botJid: "bot@xmpp.zoom.us",
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when missing accountId", () => {
    const result = resolveZoomCredentials({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      botJid: "bot@xmpp.zoom.us",
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when missing botJid", () => {
    const result = resolveZoomCredentials({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      accountId: "test-account-id",
    });
    expect(result).toBeUndefined();
  });

  it("trims whitespace from credentials", () => {
    const result = resolveZoomCredentials({
      clientId: "  test-client-id  ",
      clientSecret: "  test-client-secret  ",
      accountId: "  test-account-id  ",
      botJid: "  bot@xmpp.zoom.us  ",
    });

    expect(result).toEqual({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      accountId: "test-account-id",
      botJid: "bot@xmpp.zoom.us",
      webhookSecretToken: undefined,
    });
  });
});

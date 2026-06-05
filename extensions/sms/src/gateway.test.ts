// Sms tests cover gateway plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSmsWebhookRoute } from "./gateway.js";
import type { SmsChannelRuntime } from "./inbound.js";
import type { ResolvedSmsAccount } from "./types.js";

const registerPluginHttpRoute = vi.hoisted(() => vi.fn(() => vi.fn()));

vi.mock("openclaw/plugin-sdk/webhook-ingress", () => ({
  createFixedWindowRateLimiter: () => ({
    clear: vi.fn(),
    isRateLimited: vi.fn(() => false),
    size: vi.fn(() => 0),
  }),
  readRequestBodyWithLimit: vi.fn(async () => ""),
  registerPluginHttpRoute,
}));

const registeredRoutes: Array<() => void> = [];

function createAccount(accountId: string, webhookPath = "/webhooks/sms"): ResolvedSmsAccount {
  return {
    accountId,
    enabled: true,
    accountSid: `AC-${accountId}`,
    authToken: "secret",
    fromNumber: "+15557654321",
    messagingServiceSid: "",
    defaultTo: "",
    webhookPath,
    publicWebhookUrl: `https://gateway.example.com${webhookPath}`,
    dangerouslyDisableSignatureValidation: false,
    dmPolicy: "pairing",
    allowFrom: [],
    textChunkLimit: 1500,
  };
}

describe("registerSmsWebhookRoute", () => {
  beforeEach(() => {
    registerPluginHttpRoute.mockClear();
  });

  afterEach(() => {
    for (const unregister of registeredRoutes.toReversed()) {
      unregister();
    }
    registeredRoutes.length = 0;
  });

  function registerRoute(params: Parameters<typeof registerSmsWebhookRoute>[0]) {
    const unregister = registerSmsWebhookRoute(params);
    registeredRoutes.push(unregister);
    return unregister;
  }

  it("rejects duplicate webhook paths across SMS accounts", () => {
    const channelRuntime = {} as SmsChannelRuntime;
    registerRoute({
      cfg: {},
      account: createAccount("default"),
      channelRuntime,
    });

    expect(() =>
      registerRoute({
        cfg: {},
        account: createAccount("support"),
        channelRuntime,
      }),
    ).toThrow(/already registered by account default/u);
  });

  it("rejects duplicate webhook paths after route normalization", () => {
    const channelRuntime = {} as SmsChannelRuntime;
    registerRoute({
      cfg: {},
      account: createAccount("default", "/webhooks/sms"),
      channelRuntime,
    });

    expect(() =>
      registerRoute({
        cfg: {},
        account: createAccount("support", "webhooks/sms"),
        channelRuntime,
      }),
    ).toThrow(/already registered by account default/u);
    expect(registerPluginHttpRoute).toHaveBeenCalledTimes(1);
  });

  it("allows distinct webhook paths across SMS accounts", () => {
    const channelRuntime = {} as SmsChannelRuntime;
    registerRoute({
      cfg: {},
      account: createAccount("default"),
      channelRuntime,
    });
    registerRoute({
      cfg: {},
      account: createAccount("support", "/webhooks/sms/support"),
      channelRuntime,
    });

    expect(registerPluginHttpRoute).toHaveBeenCalledTimes(2);
  });
});

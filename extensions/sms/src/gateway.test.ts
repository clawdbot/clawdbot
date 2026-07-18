// Sms tests cover gateway plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSmsGatewayAccount } from "./gateway.js";
import type { SmsChannelRuntime } from "./inbound.js";
import type { ResolvedSmsAccount } from "./types.js";

const drainSmsIngress = vi.hoisted(() => vi.fn(async () => undefined));
const disposeSmsIngress = vi.hoisted(() => vi.fn());
const createSmsIngressSpool = vi.hoisted(() =>
  vi.fn(() => ({
    enqueue: vi.fn(),
    drainOnce: drainSmsIngress,
    dispose: disposeSmsIngress,
  })),
);

const { registeredRoutes, registerPluginHttpRoute, waitUntilAbort } = vi.hoisted(() => {
  const routeCleanups: Array<() => void> = [];
  return {
    registeredRoutes: routeCleanups,
    registerPluginHttpRoute: vi.fn(() => vi.fn()),
    waitUntilAbort: vi.fn(async (_signal: AbortSignal, onAbort?: () => void) => {
      if (onAbort) {
        routeCleanups.push(onAbort);
      }
    }),
  };
});

vi.mock("openclaw/plugin-sdk/channel-outbound", () => ({ waitUntilAbort }));

vi.mock("./ingress-spool.js", () => ({ createSmsIngressSpool }));

vi.mock("openclaw/plugin-sdk/webhook-ingress", () => ({
  createFixedWindowRateLimiter: () => ({
    clear: vi.fn(),
    isRateLimited: vi.fn(() => false),
    size: vi.fn(() => 0),
  }),
  readRequestBodyWithLimit: vi.fn(async () => ""),
  registerPluginHttpRoute,
}));

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

describe("startSmsGatewayAccount", () => {
  beforeEach(() => {
    registerPluginHttpRoute.mockClear();
    waitUntilAbort.mockClear();
    createSmsIngressSpool.mockClear();
    drainSmsIngress.mockClear();
    disposeSmsIngress.mockClear();
  });

  afterEach(() => {
    for (const unregister of registeredRoutes.toReversed()) {
      unregister();
    }
    registeredRoutes.length = 0;
  });

  async function startRoute(
    params: Omit<Parameters<typeof startSmsGatewayAccount>[0], "abortSignal">,
  ) {
    return await startSmsGatewayAccount({
      ...params,
      abortSignal: new AbortController().signal,
    });
  }

  it("rejects duplicate webhook paths across SMS accounts", async () => {
    const channelRuntime = {} as SmsChannelRuntime;
    await startRoute({
      cfg: {},
      account: createAccount("default"),
      channelRuntime,
    });

    await expect(
      startRoute({
        cfg: {},
        account: createAccount("support"),
        channelRuntime,
      }),
    ).rejects.toThrow(/already registered by account default/u);
  });

  it("rejects duplicate webhook paths after route normalization", async () => {
    const channelRuntime = {} as SmsChannelRuntime;
    await startRoute({
      cfg: {},
      account: createAccount("default", "/webhooks/sms"),
      channelRuntime,
    });

    await expect(
      startRoute({
        cfg: {},
        account: createAccount("support", "webhooks/sms"),
        channelRuntime,
      }),
    ).rejects.toThrow(/already registered by account default/u);
    expect(registerPluginHttpRoute).toHaveBeenCalledTimes(1);
  });

  it("allows distinct webhook paths across SMS accounts", async () => {
    const channelRuntime = {} as SmsChannelRuntime;
    await startRoute({
      cfg: {},
      account: createAccount("default"),
      channelRuntime,
    });
    await startRoute({
      cfg: {},
      account: createAccount("support", "/webhooks/sms/support"),
      channelRuntime,
    });

    expect(registerPluginHttpRoute).toHaveBeenCalledTimes(2);
  });
});

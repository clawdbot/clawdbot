// Sms tests cover gateway plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSmsGatewayAccount } from "./gateway.js";
import type { SmsChannelRuntime } from "./inbound.js";
import type { ResolvedSmsAccount } from "./types.js";

const startSmsIngress = vi.hoisted(() => vi.fn());
const pauseSmsIngress = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => {}));
const stopSmsIngress = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => {}));
const createSmsIngressSpool = vi.hoisted(() =>
  vi.fn((_params: { abortSignal?: AbortSignal }) => ({
    enqueue: vi.fn(),
    start: startSmsIngress,
    pause: pauseSmsIngress,
    stop: stopSmsIngress,
  })),
);

const { registeredRoutes, routeUnregisters, registerPluginHttpRoute, waitUntilAbort } = vi.hoisted(
  () => {
    const routeCleanups: Array<() => void | Promise<void>> = [];
    const unregisters: Array<ReturnType<typeof vi.fn>> = [];
    return {
      registeredRoutes: routeCleanups,
      routeUnregisters: unregisters,
      registerPluginHttpRoute: vi.fn(() => {
        const unregister = vi.fn();
        unregisters.push(unregister);
        return unregister;
      }),
      waitUntilAbort: vi.fn(async (_signal: AbortSignal, onAbort?: () => void | Promise<void>) => {
        if (onAbort) {
          routeCleanups.push(onAbort);
        }
      }),
    };
  },
);

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
    startSmsIngress.mockClear();
    pauseSmsIngress.mockClear();
    stopSmsIngress.mockClear();
    routeUnregisters.length = 0;
  });

  afterEach(async () => {
    for (const unregister of registeredRoutes.toReversed()) {
      await unregister();
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

  it("serializes overlapping replacements of the same webhook route", async () => {
    let releaseStop: (() => void) | undefined;
    stopSmsIngress.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseStop = resolve;
        }),
    );
    const params = {
      cfg: {},
      account: createAccount("default"),
      channelRuntime: {} as SmsChannelRuntime,
    };
    await startRoute(params);

    const firstReplacement = startRoute(params);
    await vi.waitFor(() => expect(stopSmsIngress).toHaveBeenCalledTimes(1));
    expect(registerPluginHttpRoute).toHaveBeenCalledTimes(2);
    expect(startSmsIngress).toHaveBeenCalledTimes(1);
    const secondReplacement = startRoute(params);
    await Promise.resolve();

    expect(registerPluginHttpRoute).toHaveBeenCalledTimes(3);
    expect(startSmsIngress).toHaveBeenCalledTimes(1);
    releaseStop?.();
    await Promise.all([firstReplacement, secondReplacement]);
    expect(startSmsIngress).toHaveBeenCalledTimes(2);
  });

  it("keeps a replacement route live while abort cleanup stops its predecessor", async () => {
    let releaseStop: (() => void) | undefined;
    stopSmsIngress.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseStop = resolve;
        }),
    );
    const params = {
      cfg: {},
      account: createAccount("default"),
      channelRuntime: {} as SmsChannelRuntime,
    };
    await startRoute(params);

    const shutdown = registeredRoutes[0]?.();
    await vi.waitFor(() => expect(stopSmsIngress).toHaveBeenCalledTimes(1));
    const replacement = startRoute(params);
    await Promise.resolve();

    expect(registerPluginHttpRoute).toHaveBeenCalledTimes(2);
    expect(startSmsIngress).toHaveBeenCalledTimes(1);
    releaseStop?.();
    await Promise.all([shutdown, replacement]);
    expect(startSmsIngress).toHaveBeenCalledTimes(2);
  });

  it("binds replacement abort cleanup before its predecessor finishes stopping", async () => {
    let releaseStop: (() => void) | undefined;
    stopSmsIngress.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseStop = resolve;
        }),
    );
    const params = {
      cfg: {},
      account: createAccount("default"),
      channelRuntime: {} as SmsChannelRuntime,
    };
    await startRoute(params);

    const replacement = startRoute(params);
    await vi.waitFor(() => expect(registeredRoutes).toHaveLength(2));
    await vi.waitFor(() => expect(stopSmsIngress).toHaveBeenCalledTimes(1));
    const abortReplacement = registeredRoutes[1]?.();

    expect(routeUnregisters[1]).toHaveBeenCalledOnce();
    releaseStop?.();
    await Promise.all([replacement, abortReplacement]);
    expect(startSmsIngress).toHaveBeenCalledTimes(1);
  });

  it("stops both ingress instances when predecessor pause fails", async () => {
    const params = {
      cfg: {},
      account: createAccount("default"),
      channelRuntime: {} as SmsChannelRuntime,
    };
    await startRoute(params);
    let replacementLifecycleSignal: AbortSignal | undefined;
    waitUntilAbort.mockImplementationOnce(async (signal, onAbort) => {
      replacementLifecycleSignal = signal;
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await onAbort?.();
    });
    pauseSmsIngress.mockRejectedValueOnce(new Error("pause failed"));

    await expect(startRoute(params)).rejects.toThrow("pause failed");

    expect(replacementLifecycleSignal?.aborted).toBe(true);
    expect(stopSmsIngress).toHaveBeenCalledTimes(2);
    registeredRoutes.length = 0;
  });

  it("pauses the predecessor pump before exposing a replacement route", async () => {
    let releasePause: (() => void) | undefined;
    pauseSmsIngress.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releasePause = resolve;
        }),
    );
    const params = {
      cfg: {},
      account: createAccount("default"),
      channelRuntime: {} as SmsChannelRuntime,
    };
    await startRoute(params);

    const replacement = startRoute(params);
    await vi.waitFor(() => expect(registerPluginHttpRoute).toHaveBeenCalledTimes(2));

    expect(pauseSmsIngress).toHaveBeenCalledTimes(1);
    expect(stopSmsIngress).not.toHaveBeenCalled();
    expect(createSmsIngressSpool.mock.calls[0]?.[0]).not.toHaveProperty("abortSignal");
    releasePause?.();
    await replacement;
    expect(stopSmsIngress).toHaveBeenCalledTimes(1);
  });
});

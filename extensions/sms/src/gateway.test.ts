// Sms tests cover gateway plugin behavior.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { registerPluginHttpRoute as registerPluginHttpRouteType } from "openclaw/plugin-sdk/webhook-ingress";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectSmsStartupWarnings, startSmsGatewayAccount } from "./gateway.js";
import type { SmsChannelRuntime } from "./inbound.js";
import type { ResolvedSmsAccount } from "./types.js";

const smsWebhookHandler = vi.hoisted(() => vi.fn(async (_req: unknown, _res: unknown) => true));
const createSmsWebhookHandler = vi.hoisted(() => vi.fn((_params: unknown) => smsWebhookHandler));
const tryHandleHostedSmsMediaRequest = vi.hoisted(() =>
  vi.fn(async (_req: unknown, _res: unknown, _accountId: string) => true),
);
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
      registerPluginHttpRoute: vi.fn<typeof registerPluginHttpRouteType>(() => {
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
vi.mock("./media.js", () => ({ tryHandleHostedSmsMediaRequest }));
vi.mock("./webhook.js", () => ({ createSmsWebhookHandler }));

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
    createSmsWebhookHandler.mockClear();
    smsWebhookHandler.mockClear();
    tryHandleHostedSmsMediaRequest.mockClear();
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

  it("publishes ready and stopped around an active webhook route", async () => {
    const statusSink = vi.fn();
    await startRoute({
      cfg: {},
      account: createAccount("default"),
      channelRuntime: {} as SmsChannelRuntime,
      statusSink,
    });

    expect(statusSink).toHaveBeenNthCalledWith(1, { lifecycle: "starting" });
    expect(statusSink).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: "ready", connected: true }),
    );
    expect(statusSink).toHaveBeenLastCalledWith(
      expect.objectContaining({ lifecycle: "stopped", running: false }),
    );
  });

  it("publishes stopped for disabled accounts and blocked for missing required config", async () => {
    const disabledSink = vi.fn();
    await startRoute({
      cfg: {},
      account: { ...createAccount("disabled"), enabled: false },
      channelRuntime: {} as SmsChannelRuntime,
      statusSink: disabledSink,
    });
    expect(disabledSink).toHaveBeenLastCalledWith(
      expect.objectContaining({ lifecycle: "stopped", running: false }),
    );

    const blockedSink = vi.fn();
    await startRoute({
      cfg: {},
      account: { ...createAccount("missing"), authToken: "" },
      channelRuntime: {} as SmsChannelRuntime,
      statusSink: blockedSink,
    });
    expect(blockedSink).toHaveBeenLastCalledWith(
      expect.objectContaining({ lifecycle: "blocked", terminalDisconnect: true }),
    );
    expect(registerPluginHttpRoute).not.toHaveBeenCalled();
  });

  it("stops ingress and rejects startup when the webhook route cannot bind", async () => {
    const statusSink = vi.fn();
    registerPluginHttpRoute.mockImplementationOnce(() => {
      throw new Error("SMS route conflict");
    });

    await expect(
      startRoute({
        cfg: {},
        account: createAccount("default"),
        channelRuntime: {} as SmsChannelRuntime,
        statusSink,
      }),
    ).rejects.toThrow("SMS route conflict");

    expect(registerPluginHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({ throwOnFailure: true }),
    );
    expect(stopSmsIngress).toHaveBeenCalledOnce();
    expect(startSmsIngress).not.toHaveBeenCalled();
    expect(statusSink).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
  });

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

  it("fails startup when the shared route registry rejects the route", async () => {
    registerPluginHttpRoute.mockImplementationOnce(() => {
      throw new Error("plugin: route conflict at /webhooks/sms (exact)");
    });

    await expect(
      startRoute({
        cfg: {},
        account: createAccount("default"),
        channelRuntime: {} as SmsChannelRuntime,
      }),
    ).rejects.toThrow("plugin: route conflict");

    expect(registerPluginHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({ throwOnFailure: true }),
    );
    expect(startSmsIngress).not.toHaveBeenCalled();
    expect(stopSmsIngress).toHaveBeenCalledOnce();
  });

  it("serves hosted media and Twilio callbacks from one exact route", async () => {
    await startRoute({
      cfg: {},
      account: createAccount("default"),
      channelRuntime: {} as SmsChannelRuntime,
    });

    type RegisteredRoute = {
      path?: string;
      match?: string;
      handler: (
        req: IncomingMessage,
        res: ServerResponse,
      ) => Promise<boolean | void> | boolean | void;
    };
    const route = registerPluginHttpRoute.mock.calls[0]?.[0] as RegisteredRoute | undefined;
    expect(route).toMatchObject({ path: "/webhooks/sms" });
    expect(route?.match).toBeUndefined();
    if (!route) {
      throw new Error("SMS route was not registered");
    }

    const getReq = { method: "GET" } as IncomingMessage;
    const getRes = {} as ServerResponse;
    await route.handler(getReq, getRes);
    expect(tryHandleHostedSmsMediaRequest).toHaveBeenCalledWith(getReq, getRes, "default");
    expect(smsWebhookHandler).not.toHaveBeenCalled();

    const headReq = { method: "HEAD" } as IncomingMessage;
    const headRes = {} as ServerResponse;
    await route.handler(headReq, headRes);
    expect(tryHandleHostedSmsMediaRequest).toHaveBeenCalledWith(headReq, headRes, "default");
    expect(smsWebhookHandler).not.toHaveBeenCalled();

    tryHandleHostedSmsMediaRequest.mockResolvedValueOnce(false);
    const postReq = { method: "POST" } as IncomingMessage;
    const postRes = {} as ServerResponse;
    await route.handler(postReq, postRes);
    expect(smsWebhookHandler).toHaveBeenCalledWith(postReq, postRes);
    expect(tryHandleHostedSmsMediaRequest).toHaveBeenCalledTimes(3);
  });

  it("falls through tokenless reads but keeps token-bearing non-GET media requests isolated", async () => {
    await startRoute({
      cfg: {},
      account: createAccount("default"),
      channelRuntime: {} as SmsChannelRuntime,
    });
    type RegisteredRoute = {
      handler: (
        req: IncomingMessage,
        res: ServerResponse,
      ) => Promise<boolean | void> | boolean | void;
    };
    const route = registerPluginHttpRoute.mock.calls[0]?.[0] as RegisteredRoute | undefined;
    if (!route) {
      throw new Error("SMS route was not registered");
    }

    tryHandleHostedSmsMediaRequest.mockResolvedValueOnce(false);
    const tokenlessGet = { method: "GET", url: "/webhooks/sms" } as IncomingMessage;
    const getRes = {} as ServerResponse;
    await route.handler(tokenlessGet, getRes);
    expect(smsWebhookHandler).toHaveBeenCalledWith(tokenlessGet, getRes);

    tryHandleHostedSmsMediaRequest.mockResolvedValueOnce(true);
    const tokenizedPost = {
      method: "POST",
      url: `/webhooks/sms?__openclaw_mms_token_${"a".repeat(24)}=secret`,
    } as IncomingMessage;
    await route.handler(tokenizedPost, {} as ServerResponse);
    expect(smsWebhookHandler).toHaveBeenCalledTimes(1);
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

describe("collectSmsStartupWarnings", () => {
  it("reports an unusable public webhook URL without disabling outbound SMS", () => {
    expect(
      collectSmsStartupWarnings({
        ...createAccount("default"),
        publicWebhookUrl: "https://sms_gateway.example.com/webhooks/sms",
      }),
    ).toContain(
      "- SMS: publicWebhookUrl must be a properly encoded absolute HTTP(S) URL with a valid hostname, no embedded credentials, and remain within OpenClaw's 4,000-character callback safety limit; OpenClaw will omit the per-message delivery callback until fixed.",
    );
  });
});

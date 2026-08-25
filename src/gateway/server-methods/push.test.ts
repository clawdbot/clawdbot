// Push method tests cover APNs direct/relay registrations, Web Push delivery
// outcomes, stale registration cleanup, config resolution, and error mapping.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { pushHandlers } from "./push.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../../infra/push-apns.js", () => ({
  clearApnsRegistrationIfCurrent: vi.fn(),
  loadApnsRegistration: vi.fn(),
  normalizeApnsEnvironment: vi.fn(),
  resolveApnsAuthConfigFromEnv: vi.fn(),
  resolveApnsRelayConfigFromEnv: vi.fn(),
  sendApnsAlert: vi.fn(),
  shouldClearStoredApnsRegistration: vi.fn(),
}));

vi.mock("../../infra/push-web.js", () => ({
  broadcastWebPush: vi.fn(),
  clearWebPushSubscriptionByEndpoint: vi.fn(),
  registerWebPushSubscription: vi.fn(),
  resolveVapidKeys: vi.fn(),
}));

import {
  type ApnsRegistration,
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  normalizeApnsEnvironment,
  resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv,
  sendApnsAlert,
  shouldClearStoredApnsRegistration,
} from "../../infra/push-apns.js";
import { broadcastWebPush, registerWebPushSubscription } from "../../infra/push-web.js";

type ApnsPushResult = Awaited<ReturnType<typeof sendApnsAlert>>;
type WebPushResults = Awaited<ReturnType<typeof broadcastWebPush>>;

type RespondCall = [boolean, unknown?, { code: string; message: string; details?: unknown }?];

const DEFAULT_DIRECT_REGISTRATION = {
  nodeId: "ios-node-1",
  transport: "direct",
  token: "abcd",
  topic: "ai.openclaw.ios",
  environment: "sandbox",
  updatedAtMs: 1,
} as const;

const DEFAULT_RELAY_REGISTRATION = {
  nodeId: "ios-node-1",
  transport: "relay",
  relayHandle: "relay-handle-123",
  sendGrant: "send-grant-123",
  installationId: "install-123",
  topic: "ai.openclaw.ios",
  environment: "production",
  distribution: "official",
  updatedAtMs: 1,
  tokenDebugSuffix: "abcd1234",
} as const;

function directRegistration(
  overrides: Partial<Extract<ApnsRegistration, { transport: "direct" }>> = {},
): Extract<ApnsRegistration, { transport: "direct" }> {
  return { ...DEFAULT_DIRECT_REGISTRATION, ...overrides };
}

function relayRegistration(
  overrides: Partial<Extract<ApnsRegistration, { transport: "relay" }>> = {},
): Extract<ApnsRegistration, { transport: "relay" }> {
  return { ...DEFAULT_RELAY_REGISTRATION, ...overrides };
}

function mockDirectAuth() {
  vi.mocked(resolveApnsAuthConfigFromEnv).mockResolvedValue({
    ok: true,
    value: {
      teamId: "TEAM123",
      keyId: "KEY123",
      privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", // pragma: allowlist secret
    },
  });
}

function apnsResult(overrides: Partial<ApnsPushResult>): ApnsPushResult {
  return {
    ok: true,
    status: 200,
    tokenSuffix: "1234abcd",
    topic: "ai.openclaw.ios",
    environment: "sandbox",
    transport: "direct",
    ...overrides,
  };
}

function createInvokeParams(params: Record<string, unknown>) {
  const respond = vi.fn();
  return {
    respond,
    invoke: async () =>
      await expectDefined(
        pushHandlers["push.test"],
        'pushHandlers["push.test"] test invariant',
      )({
        params,
        respond: respond as never,
        context: { getRuntimeConfig: () => mocks.getRuntimeConfig() } as never,
        client: null,
        req: { type: "req", id: "req-1", method: "push.test" },
        isWebchatConnect: () => false,
      }),
  };
}

function createWebPushTestInvokeParams(params: Record<string, unknown> = {}) {
  const respond = vi.fn();
  return {
    respond,
    invoke: async () =>
      await expectDefined(
        pushHandlers["push.web.test"],
        'pushHandlers["push.web.test"] test invariant',
      )({
        params,
        respond: respond as never,
        context: {} as never,
        client: null,
        req: { type: "req", id: "req-1", method: "push.web.test" },
        isWebchatConnect: () => false,
      }),
  };
}

function createWebPushSubscribeInvokeParams(options?: {
  deviceId?: string;
  userProfileId?: string;
  config?: Record<string, unknown>;
}) {
  const respond = vi.fn();
  return {
    respond,
    invoke: async () =>
      await expectDefined(
        pushHandlers["push.web.subscribe"],
        'pushHandlers["push.web.subscribe"] test invariant',
      )({
        params: {
          endpoint: "https://push.example.test/subscription",
          keys: { p256dh: "p256dh", auth: "auth" },
        },
        respond: respond as never,
        context: { getRuntimeConfig: () => options?.config ?? {} } as never,
        client: {
          connect: {
            device: options?.deviceId ? { id: options.deviceId } : undefined,
          },
          ...(options?.userProfileId
            ? {
                authenticatedUserProfile: {
                  profileId: options.userProfileId,
                },
              }
            : {}),
        } as never,
        req: { type: "req", id: "req-1", method: "push.web.subscribe" },
        isWebchatConnect: () => false,
      }),
  };
}

function expectInvalidRequestResponse(
  respond: ReturnType<typeof vi.fn>,
  expectedMessagePart: string,
) {
  const call = firstRespondCall(respond);
  expect(call?.[0]).toBe(false);
  expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
  expect(call?.[2]?.message).toContain(expectedMessagePart);
}

function firstRespondCall(respond: ReturnType<typeof vi.fn>): RespondCall | undefined {
  return respond.mock.calls[0] as RespondCall | undefined;
}

function expectSuccessfulPushTestResponse(respond: ReturnType<typeof vi.fn>): ApnsPushResult {
  expect(sendApnsAlert).toHaveBeenCalledTimes(1);
  const call = firstRespondCall(respond);
  expect(call?.[0]).toBe(true);
  const result = call?.[1] as ApnsPushResult | undefined;
  expect(result?.ok).toBe(true);
  expect(result?.status).toBe(200);
  return result as ApnsPushResult;
}

describe("push.test handler", () => {
  beforeEach(() => {
    mocks.getRuntimeConfig.mockClear();
    mocks.getRuntimeConfig.mockReturnValue({});
    vi.mocked(loadApnsRegistration).mockClear();
    vi.mocked(normalizeApnsEnvironment).mockClear();
    vi.mocked(resolveApnsAuthConfigFromEnv).mockClear();
    vi.mocked(resolveApnsRelayConfigFromEnv).mockClear();
    vi.mocked(sendApnsAlert).mockClear();
    vi.mocked(clearApnsRegistrationIfCurrent).mockClear();
    vi.mocked(shouldClearStoredApnsRegistration).mockReturnValue(false);
  });

  it("rejects invalid params", async () => {
    const { respond, invoke } = createInvokeParams({ title: "hello" });
    await invoke();
    expectInvalidRequestResponse(respond, "invalid push.test params");
  });

  it("returns invalid request when node has no APNs registration", async () => {
    vi.mocked(loadApnsRegistration).mockResolvedValue(null);
    const { respond, invoke } = createInvokeParams({ nodeId: "ios-node-1" });
    await invoke();
    expectInvalidRequestResponse(respond, "has no APNs registration");
  });

  it("sends push test when registration and auth are available", async () => {
    vi.mocked(loadApnsRegistration).mockResolvedValue(directRegistration());
    mockDirectAuth();
    vi.mocked(normalizeApnsEnvironment).mockReturnValue(null);
    vi.mocked(sendApnsAlert).mockResolvedValue(apnsResult({}));

    const { respond, invoke } = createInvokeParams({
      nodeId: "ios-node-1",
      title: "Wake",
      body: "Ping",
    });
    await invoke();

    expectSuccessfulPushTestResponse(respond);
  });

  it("sends push test through relay registrations", async () => {
    mocks.getRuntimeConfig.mockReturnValue({
      gateway: {
        push: {
          apns: {
            relay: {
              baseUrl: "https://relay.example.com",
              timeoutMs: 1000,
            },
          },
        },
      },
    });
    vi.mocked(loadApnsRegistration).mockResolvedValue(
      relayRegistration({ installationId: "install-1" }),
    );
    vi.mocked(resolveApnsRelayConfigFromEnv).mockReturnValue({
      ok: true,
      value: {
        baseUrl: "https://relay.example.com",
        timeoutMs: 1000,
      },
    });
    vi.mocked(normalizeApnsEnvironment).mockReturnValue(null);
    vi.mocked(sendApnsAlert).mockResolvedValue(
      apnsResult({
        tokenSuffix: "abcd1234",
        environment: "production",
        transport: "relay",
      }),
    );

    const { respond, invoke } = createInvokeParams({
      nodeId: "ios-node-1",
      title: "Wake",
      body: "Ping",
    });
    await invoke();

    expect(resolveApnsAuthConfigFromEnv).not.toHaveBeenCalled();
    expect(resolveApnsRelayConfigFromEnv).toHaveBeenCalledTimes(1);
    expect(resolveApnsRelayConfigFromEnv).toHaveBeenCalledWith(
      process.env,
      {
        push: {
          apns: {
            relay: {
              baseUrl: "https://relay.example.com",
              timeoutMs: 1000,
            },
          },
        },
      },
      { registrationRelayOrigin: undefined },
    );
    const result = expectSuccessfulPushTestResponse(respond);
    expect(result?.transport).toBe("relay");
  });

  it("clears stale registrations after invalid token push-test failures", async () => {
    const registration = directRegistration();
    vi.mocked(loadApnsRegistration).mockResolvedValue(registration);
    mockDirectAuth();
    vi.mocked(normalizeApnsEnvironment).mockReturnValue(null);
    vi.mocked(sendApnsAlert).mockResolvedValue(
      apnsResult({
        ok: false,
        status: 400,
        reason: "BadDeviceToken",
      }),
    );
    vi.mocked(shouldClearStoredApnsRegistration).mockReturnValue(true);

    const { invoke } = createInvokeParams({
      nodeId: "ios-node-1",
      title: "Wake",
      body: "Ping",
    });
    await invoke();

    expect(clearApnsRegistrationIfCurrent).toHaveBeenCalledWith({
      nodeId: "ios-node-1",
      registration,
    });
  });

  it("does not clear relay registrations after invalidation-shaped failures", async () => {
    const registration = relayRegistration();
    vi.mocked(loadApnsRegistration).mockResolvedValue(registration);
    vi.mocked(resolveApnsRelayConfigFromEnv).mockReturnValue({
      ok: true,
      value: {
        baseUrl: "https://relay.example.com",
        timeoutMs: 1000,
      },
    });
    vi.mocked(normalizeApnsEnvironment).mockReturnValue(null);
    const result = apnsResult({
      ok: false,
      status: 410,
      reason: "Unregistered",
      tokenSuffix: "abcd1234",
      environment: "production",
      transport: "relay",
    });
    vi.mocked(sendApnsAlert).mockResolvedValue(result);
    vi.mocked(shouldClearStoredApnsRegistration).mockReturnValue(false);

    const { invoke } = createInvokeParams({
      nodeId: "ios-node-1",
      title: "Wake",
      body: "Ping",
    });
    await invoke();

    expect(shouldClearStoredApnsRegistration).toHaveBeenCalledWith({
      registration,
      result,
      overrideEnvironment: null,
    });
    expect(clearApnsRegistrationIfCurrent).not.toHaveBeenCalled();
  });

  it("does not clear direct registrations when push.test overrides the environment", async () => {
    const registration = directRegistration();
    vi.mocked(loadApnsRegistration).mockResolvedValue(registration);
    mockDirectAuth();
    vi.mocked(normalizeApnsEnvironment).mockReturnValue("production");
    const result = apnsResult({
      ok: false,
      status: 400,
      reason: "BadDeviceToken",
      environment: "production",
    });
    vi.mocked(sendApnsAlert).mockResolvedValue(result);
    vi.mocked(shouldClearStoredApnsRegistration).mockReturnValue(false);

    const { invoke } = createInvokeParams({
      nodeId: "ios-node-1",
      title: "Wake",
      body: "Ping",
      environment: "production",
    });
    await invoke();

    expect(shouldClearStoredApnsRegistration).toHaveBeenCalledWith({
      registration,
      result,
      overrideEnvironment: "production",
    });
    expect(clearApnsRegistrationIfCurrent).not.toHaveBeenCalled();
  });
});

describe("push.web.test handler", () => {
  beforeEach(() => {
    vi.mocked(broadcastWebPush).mockReset();
  });

  it("returns unavailable with delivery results when every attempt fails", async () => {
    const results: WebPushResults = [
      {
        ok: false,
        subscriptionId: "expired-subscription",
        statusCode: 410,
        error: "Gone",
      },
      {
        ok: false,
        subscriptionId: "rejected-subscription",
        statusCode: 503,
        error: "Service Unavailable",
      },
    ];
    vi.mocked(broadcastWebPush).mockResolvedValue(results);

    const { respond, invoke } = createWebPushTestInvokeParams();
    await invoke();

    expect(respond).toHaveBeenCalledTimes(1);
    const call = firstRespondCall(respond);
    expect(call?.[0]).toBe(false);
    expect(call?.[1]).toBeUndefined();
    expect(call?.[2]?.code).toBe(ErrorCodes.UNAVAILABLE);
    expect(call?.[2]?.details).toEqual({ results });
  });

  it("returns all delivery results when at least one attempt succeeds", async () => {
    const results: WebPushResults = [
      {
        ok: true,
        subscriptionId: "active-subscription",
        statusCode: 201,
      },
      {
        ok: false,
        subscriptionId: "expired-subscription",
        statusCode: 410,
        error: "Gone",
      },
    ];
    vi.mocked(broadcastWebPush).mockResolvedValue(results);

    const { respond, invoke } = createWebPushTestInvokeParams();
    await invoke();

    expect(respond).toHaveBeenCalledTimes(1);
    expect(firstRespondCall(respond)).toEqual([true, { results }, undefined]);
  });

  it("returns invalid request when no subscriptions are registered", async () => {
    vi.mocked(broadcastWebPush).mockResolvedValue([]);

    const { respond, invoke } = createWebPushTestInvokeParams();
    await invoke();

    expectInvalidRequestResponse(respond, "no web push subscriptions registered");
  });
});

describe("push.web.subscribe handler", () => {
  beforeEach(() => {
    vi.mocked(registerWebPushSubscription).mockReset();
    vi.mocked(registerWebPushSubscription).mockResolvedValue({
      subscriptionId: "subscription-1",
      endpoint: "https://push.example.test/subscription",
      keys: { p256dh: "p256dh", auth: "auth" },
      createdAtMs: 1,
      updatedAtMs: 1,
    });
  });

  it("binds the subscription to the authenticated browser device and profile", async () => {
    const { respond, invoke } = createWebPushSubscribeInvokeParams({
      deviceId: "browser-device",
      userProfileId: "profile-1",
    });

    await invoke();

    expect(registerWebPushSubscription).toHaveBeenCalledWith({
      endpoint: "https://push.example.test/subscription",
      keys: { p256dh: "p256dh", auth: "auth" },
      binding: { deviceId: "browser-device", userProfileId: "profile-1" },
    });
    expect(firstRespondCall(respond)).toEqual([
      true,
      { subscriptionId: "subscription-1" },
      undefined,
    ]);
  });

  it("rejects subscriptions without a paired browser device identity", async () => {
    const { respond, invoke } = createWebPushSubscribeInvokeParams();

    await invoke();

    expectInvalidRequestResponse(respond, "paired browser device identity required");
    expect(registerWebPushSubscription).not.toHaveBeenCalled();
  });

  it("rejects profile-less subscriptions when Gateway roles are enabled", async () => {
    const { respond, invoke } = createWebPushSubscribeInvokeParams({
      deviceId: "browser-device",
      config: { gateway: { roles: { definitions: {} } } },
    });

    await invoke();

    expectInvalidRequestResponse(respond, "authenticated user profile");
    expect(registerWebPushSubscription).not.toHaveBeenCalled();
  });
});

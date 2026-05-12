import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
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

import {
  type ApnsPushResult,
  type ApnsRegistration,
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  normalizeApnsEnvironment,
  resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv,
  sendApnsAlert,
  shouldClearStoredApnsRegistration,
} from "../../infra/push-apns.js";

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

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
      await pushHandlers["push.test"]({
        params,
        respond: respond as never,
        context: { getRuntimeConfig: () => mocks.getRuntimeConfig() } as never,
        client: null,
        req: { type: "req", id: "req-1", method: "push.test" },
        isWebchatConnect: () => false,
      }),
  };
}

function expectInvalidRequestResponse(
  respond: ReturnType<typeof vi.fn>,
  expectedMessagePart: string,
) {
  const call = respond.mock.calls[0] as RespondCall | undefined;
  expect(call?.[0]).toBe(false);
  expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
  expect(call?.[2]?.message).toContain(expectedMessagePart);
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

    expect(sendApnsAlert).toHaveBeenCalledTimes(1);
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    const result = call?.[1] as ApnsPushResult | undefined;
    expect(result?.ok).toBe(true);
    expect(result?.status).toBe(200);
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
    expect(resolveApnsRelayConfigFromEnv).toHaveBeenCalledWith(process.env, {
      push: {
        apns: {
          relay: {
            baseUrl: "https://relay.example.com",
            timeoutMs: 1000,
          },
        },
      },
    });
    expect(sendApnsAlert).toHaveBeenCalledTimes(1);
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    const result = call?.[1] as ApnsPushResult | undefined;
    expect(result?.ok).toBe(true);
    expect(result?.status).toBe(200);
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

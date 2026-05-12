import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import {
  clearNodeWakeState,
  maybeSendNodeWakeNudge,
  maybeWakeNodeWithApns,
  nodeHandlers,
} from "./nodes.js";

type MockNodeCommandPolicyParams = {
  command: string;
  declaredCommands?: string[];
  allowlist: Set<string>;
};

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  resolveNodeCommandAllowlist: vi.fn<() => Set<string>>(() => new Set()),
  isNodeCommandAllowed: vi.fn<
    (params: MockNodeCommandPolicyParams) => { ok: true } | { ok: false; reason: string }
  >(() => ({ ok: true })),
  isForegroundRestrictedPluginNodeCommand: vi.fn((command: string) =>
    command.startsWith("canvas."),
  ),
  sanitizeNodeInvokeParamsForForwarding: vi.fn(({ rawParams }: { rawParams: unknown }) => ({
    ok: true,
    params: rawParams,
  })),
  clearApnsRegistrationIfCurrent: vi.fn(),
  loadApnsRegistration: vi.fn(),
  resolveApnsAuthConfigFromEnv: vi.fn(),
  resolveApnsRelayConfigFromEnv: vi.fn(),
  sendApnsBackgroundWake: vi.fn(),
  sendApnsAlert: vi.fn(),
  shouldClearStoredApnsRegistration: vi.fn(() => false),
  requestNodePairing: vi.fn(),
}));

vi.mock("../../config/io.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../node-command-policy.js", () => ({
  resolveNodeCommandAllowlist: mocks.resolveNodeCommandAllowlist,
  isNodeCommandAllowed: mocks.isNodeCommandAllowed,
  isForegroundRestrictedPluginNodeCommand: mocks.isForegroundRestrictedPluginNodeCommand,
}));

vi.mock("../node-invoke-sanitize.js", () => ({
  sanitizeNodeInvokeParamsForForwarding: mocks.sanitizeNodeInvokeParamsForForwarding,
}));

vi.mock("../../infra/push-apns.js", () => ({
  clearApnsRegistrationIfCurrent: mocks.clearApnsRegistrationIfCurrent,
  loadApnsRegistration: mocks.loadApnsRegistration,
  resolveApnsAuthConfigFromEnv: mocks.resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv: mocks.resolveApnsRelayConfigFromEnv,
  sendApnsBackgroundWake: mocks.sendApnsBackgroundWake,
  sendApnsAlert: mocks.sendApnsAlert,
  shouldClearStoredApnsRegistration: mocks.shouldClearStoredApnsRegistration,
}));

vi.mock("../../infra/node-pairing.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/node-pairing.js")>(
    "../../infra/node-pairing.js",
  );
  return {
    ...actual,
    requestNodePairing: mocks.requestNodePairing,
  };
});

type RespondCall = [
  boolean,
  unknown?,
  {
    code?: number;
    message?: string;
    details?: unknown;
  }?,
];

type MockCallSource = {
  mock: {
    calls: ArrayLike<ReadonlyArray<unknown>>;
  };
};

type TestNodeSession = {
  nodeId: string;
  commands: string[];
  platform?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(isRecord(value), `${label} must be an object`).toBe(true);
  return value as Record<string, unknown>;
}

function expectRecordFields(
  value: unknown,
  label: string,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(expectedValue);
  }
  return record;
}

function requireString(value: unknown, label: string): string {
  expect(typeof value, `${label} must be a string`).toBe("string");
  return value as string;
}

function mockCall(source: MockCallSource, callIndex = 0): ReadonlyArray<unknown> {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call ${callIndex}`);
  }
  return call;
}

function firstRespondCall(source: MockCallSource): RespondCall {
  return mockCall(source) as RespondCall;
}

function mockArg(source: MockCallSource, callIndex: number, argIndex: number) {
  return mockCall(source, callIndex)[argIndex];
}

function isLowerHex(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) {
      return false;
    }
  }
  return true;
}

function isUuidV4(value: string): boolean {
  const parts = value.split("-");
  if (parts.length !== 5) {
    return false;
  }
  const [part0, part1, part2, part3, part4] = parts;
  if (
    part0?.length !== 8 ||
    part1?.length !== 4 ||
    part2?.length !== 4 ||
    part3?.length !== 4 ||
    part4?.length !== 12
  ) {
    return false;
  }
  if (part2[0] !== "4" || !part3[0] || !"89ab".includes(part3[0])) {
    return false;
  }
  for (const part of parts) {
    if (!isLowerHex(part)) {
      return false;
    }
  }
  return true;
}

function requireRespondPayload(call: RespondCall | undefined, label: string) {
  expect(call?.[0], `${label} success`).toBe(true);
  return requireRecord(call?.[1], `${label} payload`);
}

function expectQueuedAction(
  payload: Record<string, unknown>,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  expect(Array.isArray(payload.actions), "payload.actions must be an array").toBe(true);
  const actions = payload.actions as unknown[];
  expect(actions).toHaveLength(1);
  return expectRecordFields(actions[0], "queued action", expected);
}

const WAKE_WAIT_TIMEOUT_MS = 3_001;
const DEFAULT_RELAY_CONFIG = {
  baseUrl: "https://relay.example.com",
  timeoutMs: 1000,
} as const;
type WakeResultOverrides = Partial<{
  ok: boolean;
  status: number;
  reason: string;
  tokenSuffix: string;
  topic: string;
  environment: "sandbox" | "production";
  transport: "direct" | "relay";
}>;

function directRegistration(nodeId: string) {
  return {
    nodeId,
    transport: "direct" as const,
    token: "abcd1234abcd1234abcd1234abcd1234",
    topic: "ai.openclaw.ios",
    environment: "sandbox" as const,
    updatedAtMs: 1,
  };
}

function relayRegistration(nodeId: string) {
  return {
    nodeId,
    transport: "relay" as const,
    relayHandle: "relay-handle-123",
    sendGrant: "send-grant-123",
    installationId: "install-123",
    topic: "ai.openclaw.ios",
    environment: "production" as const,
    distribution: "official" as const,
    updatedAtMs: 1,
    tokenDebugSuffix: "abcd1234",
  };
}

function mockDirectWakeConfig(nodeId: string, overrides: WakeResultOverrides = {}) {
  mocks.loadApnsRegistration.mockResolvedValue(directRegistration(nodeId));
  mocks.resolveApnsAuthConfigFromEnv.mockResolvedValue({
    ok: true,
    value: {
      teamId: "TEAM123",
      keyId: "KEY123",
      privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", // pragma: allowlist secret
    },
  });
  mocks.sendApnsBackgroundWake.mockResolvedValue({
    ok: true,
    status: 200,
    tokenSuffix: "1234abcd",
    topic: "ai.openclaw.ios",
    environment: "sandbox",
    transport: "direct",
    ...overrides,
  });
}

function mockRelayWakeConfig(nodeId: string, overrides: WakeResultOverrides = {}) {
  mocks.getRuntimeConfig.mockReturnValue({
    gateway: {
      push: {
        apns: {
          relay: DEFAULT_RELAY_CONFIG,
        },
      },
    },
  });
  mocks.loadApnsRegistration.mockResolvedValue(relayRegistration(nodeId));
  mocks.resolveApnsRelayConfigFromEnv.mockReturnValue({
    ok: true,
    value: DEFAULT_RELAY_CONFIG,
  });
  mocks.sendApnsBackgroundWake.mockResolvedValue({
    ok: true,
    status: 200,
    tokenSuffix: "abcd1234",
    topic: "ai.openclaw.ios",
    environment: "production",
    transport: "relay",
    ...overrides,
  });
}

function makeNodeInvokeParams(overrides?: Partial<Record<string, unknown>>) {
  return {
    nodeId: "ios-node-1",
    command: "camera.capture",
    params: { quality: "high" },
    timeoutMs: 5000,
    idempotencyKey: "idem-node-invoke",
    ...overrides,
  };
}

async function invokeNode(params: {
  nodeRegistry: {
    get: (nodeId: string) => TestNodeSession | undefined;
    invoke: (payload: {
      nodeId: string;
      command: string;
      params?: unknown;
      timeoutMs?: number;
      idempotencyKey?: string;
    }) => Promise<{
      ok: boolean;
      payload?: unknown;
      payloadJSON?: string | null;
      error?: { code?: string; message?: string } | null;
    }>;
  };
  requestParams?: Partial<Record<string, unknown>>;
}) {
  const respond = vi.fn();
  const logGateway = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  await nodeHandlers["node.invoke"]({
    params: makeNodeInvokeParams(params.requestParams),
    respond: respond as never,
    context: {
      nodeRegistry: params.nodeRegistry,
      execApprovalManager: undefined,
      logGateway,
      getRuntimeConfig: () => mocks.getRuntimeConfig(),
    } as never,
    client: null,
    req: { type: "req", id: "req-node-invoke", method: "node.invoke" },
    isWebchatConnect: () => false,
  });
  return respond;
}

function createNodeClient(nodeId: string, commands?: string[]) {
  return {
    connect: {
      ...(commands ? { commands } : {}),
      role: "node" as const,
      client: {
        id: nodeId,
        mode: "node" as const,
        name: "ios-test",
        platform: "iOS 26.4.0",
        version: "test",
      },
    },
  };
}

async function pullPending(nodeId: string, commands?: string[]) {
  const respond = vi.fn();
  await nodeHandlers["node.pending.pull"]({
    params: {},
    respond: respond as never,
    context: { getRuntimeConfig: () => mocks.getRuntimeConfig() } as never,
    client: createNodeClient(nodeId, commands) as never,
    req: { type: "req", id: "req-node-pending", method: "node.pending.pull" },
    isWebchatConnect: () => false,
  });
  return respond;
}

async function ackPending(nodeId: string, ids: string[], commands?: string[]) {
  const respond = vi.fn();
  await nodeHandlers["node.pending.ack"]({
    params: { ids },
    respond: respond as never,
    context: { getRuntimeConfig: () => mocks.getRuntimeConfig() } as never,
    client: createNodeClient(nodeId, commands) as never,
    req: { type: "req", id: "req-node-pending-ack", method: "node.pending.ack" },
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("node.pair.request", () => {
  it("passes permissions and resolves superseded prompts before broadcasting replacement requests", async () => {
    mocks.requestNodePairing.mockResolvedValue({
      status: "pending",
      created: true,
      request: {
        requestId: "req-new",
        nodeId: "ios-node-1",
        commands: ["canvas.snapshot"],
        permissions: { camera: true },
        ts: 1,
      },
      superseded: [{ requestId: "req-old", nodeId: "ios-node-1" }],
    });
    const respond = vi.fn();
    const broadcast = vi.fn();

    await nodeHandlers["node.pair.request"]({
      params: {
        nodeId: "ios-node-1",
        commands: ["canvas.snapshot"],
        permissions: { camera: true },
      },
      respond: respond as never,
      context: { broadcast } as never,
      client: null,
      req: { type: "req", id: "req-node-pair", method: "node.pair.request" },
      isWebchatConnect: () => false,
    });

    expect(mocks.requestNodePairing).toHaveBeenCalledWith({
      nodeId: "ios-node-1",
      displayName: undefined,
      platform: undefined,
      version: undefined,
      coreVersion: undefined,
      uiVersion: undefined,
      deviceFamily: undefined,
      modelIdentifier: undefined,
      caps: undefined,
      commands: ["canvas.snapshot"],
      permissions: { camera: true },
      remoteIp: undefined,
      silent: undefined,
    });
    expect(mockArg(broadcast, 0, 0)).toBe("node.pair.resolved");
    expect(mockArg(broadcast, 0, 1)).toEqual({
      requestId: "req-old",
      nodeId: "ios-node-1",
      decision: "rejected",
      ts: expect.any(Number),
    });
    expect(mockArg(broadcast, 1, 0)).toBe("node.pair.requested");
    expect(mockArg(broadcast, 1, 1)).toEqual({
      requestId: "req-new",
      nodeId: "ios-node-1",
      commands: ["canvas.snapshot"],
      permissions: { camera: true },
      ts: 1,
    });
    expect(firstRespondCall(respond)[0]).toBe(true);
  });
});

describe("node plugin surface refresh", () => {
  it("refreshes generic plugin surface capability urls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const respond = vi.fn();
    const client = {
      connect: {
        client: { id: "node-1", mode: "node" },
      },
      pluginSurfaceUrls: {
        canvas: "http://127.0.0.1:18789/__openclaw__/cap/old-token",
      },
      pluginNodeCapabilitySurfaces: {
        canvas: { surface: "canvas", ttlMs: 100 },
      },
    };

    await nodeHandlers["node.pluginSurface.refresh"]({
      req: { type: "req", id: "r1", method: "node.pluginSurface.refresh", params: {} },
      params: { surface: "canvas" },
      client: client as never,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(respond).toHaveBeenCalledTimes(1);
    const call = firstRespondCall(respond);
    expect(call[0]).toBe(true);
    expect(call[2]).toBeUndefined();
    const payload = requireRecord(call[1], "refresh payload");
    expect(payload.surface).toBe("canvas");
    expect(payload.expiresAtMs).toBe(1_100);
    const pluginSurfaceUrls = requireRecord(payload.pluginSurfaceUrls, "refresh surface urls");
    const canvasUrl = requireString(pluginSurfaceUrls.canvas, "refresh canvas url");
    const parsedCanvasUrl = new URL(canvasUrl);
    expect(parsedCanvasUrl.origin).toBe("http://127.0.0.1:18789");
    expect(parsedCanvasUrl.pathname.startsWith("/__openclaw__/cap/")).toBe(true);
    const capabilityToken = parsedCanvasUrl.pathname.slice("/__openclaw__/cap/".length);
    expect(capabilityToken.length).toBeGreaterThan(0);
    expect(capabilityToken).not.toBe("old-token");
    expect(client.pluginSurfaceUrls.canvas).toBe(canvasUrl);
  });
});

describe("node.invoke APNs wake path", () => {
  beforeEach(() => {
    mocks.getRuntimeConfig.mockClear();
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.resolveNodeCommandAllowlist.mockClear();
    mocks.resolveNodeCommandAllowlist.mockReturnValue(new Set());
    mocks.isNodeCommandAllowed.mockClear();
    mocks.isNodeCommandAllowed.mockReturnValue({ ok: true });
    mocks.isForegroundRestrictedPluginNodeCommand.mockClear();
    mocks.isForegroundRestrictedPluginNodeCommand.mockImplementation((command: string) =>
      command.startsWith("canvas."),
    );
    mocks.sanitizeNodeInvokeParamsForForwarding.mockClear();
    mocks.sanitizeNodeInvokeParamsForForwarding.mockImplementation(
      ({ rawParams }: { rawParams: unknown }) => ({ ok: true, params: rawParams }),
    );
    mocks.loadApnsRegistration.mockClear();
    mocks.clearApnsRegistrationIfCurrent.mockClear();
    mocks.resolveApnsAuthConfigFromEnv.mockClear();
    mocks.resolveApnsRelayConfigFromEnv.mockClear();
    mocks.sendApnsBackgroundWake.mockClear();
    mocks.sendApnsAlert.mockClear();
    mocks.shouldClearStoredApnsRegistration.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the existing not-connected response when wake path is unavailable", async () => {
    mocks.loadApnsRegistration.mockResolvedValue(null);

    const nodeRegistry = {
      get: vi.fn(() => undefined),
      invoke: vi.fn().mockResolvedValue({ ok: true }),
    };

    const respond = await invokeNode({ nodeRegistry });
    const call = firstRespondCall(respond);
    expect(call[0]).toBe(false);
    expect(call[2]?.code).toBe(ErrorCodes.UNAVAILABLE);
    expect(call[2]?.message).toBe("node not connected");
    expect(mocks.sendApnsBackgroundWake).not.toHaveBeenCalled();
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
  });

  it("does not throttle repeated relay wake attempts when relay config is missing", async () => {
    mocks.loadApnsRegistration.mockResolvedValue(relayRegistration("ios-node-relay-no-auth"));
    mocks.resolveApnsRelayConfigFromEnv.mockReturnValue({
      ok: false,
      error: "relay config missing",
    });

    const first = await maybeWakeNodeWithApns("ios-node-relay-no-auth");
    const second = await maybeWakeNodeWithApns("ios-node-relay-no-auth");

    expectRecordFields(first, "first wake result", {
      available: false,
      throttled: false,
      path: "no-auth",
      apnsReason: "relay config missing",
    });
    expectRecordFields(second, "second wake result", {
      available: false,
      throttled: false,
      path: "no-auth",
      apnsReason: "relay config missing",
    });
    expect(mocks.resolveApnsRelayConfigFromEnv).toHaveBeenCalledTimes(2);
    expect(mocks.sendApnsBackgroundWake).not.toHaveBeenCalled();
  });

  it("clears wake and nudge throttle state when a node disconnects", async () => {
    mockDirectWakeConfig("ios-node-clear-wake");
    mocks.sendApnsAlert.mockResolvedValue({
      ok: true,
      status: 200,
      tokenSuffix: "1234abcd",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
      transport: "direct",
    });

    expectRecordFields(await maybeWakeNodeWithApns("ios-node-clear-wake"), "wake result", {
      path: "sent",
      throttled: false,
    });
    expectRecordFields(await maybeSendNodeWakeNudge("ios-node-clear-wake"), "nudge result", {
      sent: true,
      throttled: false,
    });
    expectRecordFields(await maybeWakeNodeWithApns("ios-node-clear-wake"), "wake result", {
      path: "throttled",
      throttled: true,
    });
    expectRecordFields(await maybeSendNodeWakeNudge("ios-node-clear-wake"), "nudge result", {
      sent: false,
      throttled: true,
    });

    clearNodeWakeState("ios-node-clear-wake");

    expectRecordFields(await maybeWakeNodeWithApns("ios-node-clear-wake"), "wake result", {
      path: "sent",
      throttled: false,
    });
    expectRecordFields(await maybeSendNodeWakeNudge("ios-node-clear-wake"), "nudge result", {
      sent: true,
      throttled: false,
    });
    expect(mocks.sendApnsBackgroundWake).toHaveBeenCalledTimes(2);
    expect(mocks.sendApnsAlert).toHaveBeenCalledTimes(2);
  });

  it("wakes and retries invoke after the node reconnects", async () => {
    vi.useFakeTimers();
    mockDirectWakeConfig("ios-node-reconnect");

    let connected = false;
    const session: TestNodeSession = { nodeId: "ios-node-reconnect", commands: ["camera.capture"] };
    const nodeRegistry = {
      get: vi.fn((nodeId: string) => {
        if (nodeId !== "ios-node-reconnect") {
          return undefined;
        }
        return connected ? session : undefined;
      }),
      invoke: vi.fn().mockResolvedValue({
        ok: true,
        payload: { ok: true },
        payloadJSON: '{"ok":true}',
      }),
    };

    const invokePromise = invokeNode({
      nodeRegistry,
      requestParams: { nodeId: "ios-node-reconnect", idempotencyKey: "idem-reconnect" },
    });
    setTimeout(() => {
      connected = true;
    }, 300);

    await vi.advanceTimersByTimeAsync(WAKE_WAIT_TIMEOUT_MS);
    const respond = await invokePromise;

    expect(mocks.sendApnsBackgroundWake).toHaveBeenCalledTimes(1);
    expect(nodeRegistry.invoke).toHaveBeenCalledTimes(1);
    expectRecordFields(mockArg(nodeRegistry.invoke, 0, 0), "node invoke payload", {
      nodeId: "ios-node-reconnect",
      command: "camera.capture",
    });
    const call = firstRespondCall(respond);
    expect(call[0]).toBe(true);
    expectRecordFields(call[1], "respond payload", { ok: true, nodeId: "ios-node-reconnect" });
  });

  it("broadcasts canonical Talk capture events for successful PTT node commands", async () => {
    const respond = vi.fn();
    const broadcast = vi.fn();
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "android-talk-node",
        commands: ["talk.ptt.start"],
        capabilities: ["talk"],
        platform: "android",
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: true,
        payloadJSON: '{"captureId":"capture-1"}',
      }),
    };

    await nodeHandlers["node.invoke"]({
      params: {
        nodeId: "android-talk-node",
        command: "talk.ptt.start",
        idempotencyKey: "idem-talk-ptt-start",
      },
      respond: respond as never,
      context: {
        nodeRegistry,
        execApprovalManager: undefined,
        logGateway: { info: vi.fn(), warn: vi.fn() },
        getRuntimeConfig: () => mocks.getRuntimeConfig(),
        broadcast,
      } as never,
      client: null,
      req: { type: "req", id: "req-talk-ptt", method: "node.invoke" },
      isWebchatConnect: () => false,
    });

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(mockArg(broadcast, 0, 0)).toBe("talk.event");
    const broadcastPayload = expectRecordFields(mockArg(broadcast, 0, 1), "broadcast payload", {
      nodeId: "android-talk-node",
      command: "talk.ptt.start",
    });
    const talkEvent = expectRecordFields(broadcastPayload.talkEvent, "talk event", {
      type: "capture.started",
      sessionId: "node:android-talk-node:talk:capture-1",
      captureId: "capture-1",
      mode: "stt-tts",
      transport: "managed-room",
      brain: "agent-consult",
      final: false,
    });
    expect(talkEvent.seq).toBeTypeOf("number");
    expectRecordFields(talkEvent.payload, "talk event payload", {
      nodeId: "android-talk-node",
      command: "talk.ptt.start",
    });
    expect(mockArg(broadcast, 0, 2)).toEqual({ dropIfSlow: true });
  });

  it("clears stale registrations after an invalid device token wake failure", async () => {
    const registration = directRegistration("ios-node-stale");
    mocks.loadApnsRegistration.mockResolvedValue(registration);
    mockDirectWakeConfig("ios-node-stale", {
      ok: false,
      status: 400,
      reason: "BadDeviceToken",
    });
    mocks.shouldClearStoredApnsRegistration.mockReturnValue(true);
    const wake = await maybeWakeNodeWithApns("ios-node-stale", { force: true });

    expectRecordFields(wake, "wake result", {
      available: true,
      throttled: false,
      path: "send-error",
      apnsReason: "BadDeviceToken",
      apnsStatus: 400,
    });
    expect(mocks.clearApnsRegistrationIfCurrent).toHaveBeenCalledWith({
      nodeId: "ios-node-stale",
      registration,
    });
  });

  it("does not clear relay registrations from wake failures", async () => {
    const registration = relayRegistration("ios-node-relay");
    mockRelayWakeConfig("ios-node-relay", {
      ok: false,
      status: 410,
      reason: "Unregistered",
    });
    mocks.shouldClearStoredApnsRegistration.mockReturnValue(false);
    const wake = await maybeWakeNodeWithApns("ios-node-relay", { force: true });

    expectRecordFields(wake, "wake result", {
      available: true,
      throttled: false,
      path: "send-error",
      apnsReason: "Unregistered",
      apnsStatus: 410,
    });
    expect(mocks.resolveApnsRelayConfigFromEnv).toHaveBeenCalledWith(process.env, {
      push: {
        apns: {
          relay: DEFAULT_RELAY_CONFIG,
        },
      },
    });
    expect(mocks.shouldClearStoredApnsRegistration).toHaveBeenCalledWith({
      registration,
      result: {
        ok: false,
        status: 410,
        reason: "Unregistered",
        tokenSuffix: "abcd1234",
        topic: "ai.openclaw.ios",
        environment: "production",
        transport: "relay",
      },
    });
    expect(mocks.clearApnsRegistrationIfCurrent).not.toHaveBeenCalled();
  });

  it("forces one retry wake when the first wake still fails to reconnect", async () => {
    vi.useFakeTimers();
    mockDirectWakeConfig("ios-node-throttle");

    const nodeRegistry = {
      get: vi.fn(() => undefined),
      invoke: vi.fn().mockResolvedValue({ ok: true }),
    };

    const invokePromise = invokeNode({
      nodeRegistry,
      requestParams: { nodeId: "ios-node-throttle", idempotencyKey: "idem-throttle-1" },
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await invokePromise;

    expect(mocks.sendApnsBackgroundWake).toHaveBeenCalledTimes(2);
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
  });

  it("queues iOS foreground-only command failures and keeps them until acked", async () => {
    mocks.loadApnsRegistration.mockResolvedValue(null);

    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-queued",
        commands: ["canvas.navigate"],
        platform: "iOS 26.4.0",
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: "NODE_BACKGROUND_UNAVAILABLE",
          message: "NODE_BACKGROUND_UNAVAILABLE: canvas/camera/screen commands require foreground",
        },
      }),
    };

    const respond = await invokeNode({
      nodeRegistry,
      requestParams: {
        nodeId: "ios-node-queued",
        command: "canvas.navigate",
        params: { url: "http://example.com/" },
        idempotencyKey: "idem-queued",
      },
    });
    const call = firstRespondCall(respond);
    expect(call[0]).toBe(false);
    expect(call[2]?.code).toBe(ErrorCodes.UNAVAILABLE);
    expect(call[2]?.message).toBe("node command queued until iOS returns to foreground");
    expect(mocks.sendApnsBackgroundWake).not.toHaveBeenCalled();

    const pullRespond = await pullPending("ios-node-queued", ["canvas.navigate"]);
    const pullCall = firstRespondCall(pullRespond);
    const pullPayload = requireRespondPayload(pullCall, "pull response");
    expectRecordFields(pullPayload, "pull payload", {
      nodeId: "ios-node-queued",
    });
    expectQueuedAction(pullPayload, {
      command: "canvas.navigate",
      paramsJSON: JSON.stringify({ url: "http://example.com/" }),
    });

    const repeatedPullRespond = await pullPending("ios-node-queued", ["canvas.navigate"]);
    const repeatedPullCall = firstRespondCall(repeatedPullRespond);
    const repeatedPullPayload = requireRespondPayload(repeatedPullCall, "repeated pull response");
    expectRecordFields(repeatedPullPayload, "repeated pull payload", {
      nodeId: "ios-node-queued",
    });
    expectQueuedAction(repeatedPullPayload, {
      command: "canvas.navigate",
      paramsJSON: JSON.stringify({ url: "http://example.com/" }),
    });

    const queuedActionId = requireString(
      (pullPayload.actions as Array<{ id?: string }> | undefined)?.[0]?.id,
      "queued action id",
    );
    expect(isUuidV4(queuedActionId)).toBe(true);

    const ackRespond = await ackPending("ios-node-queued", [queuedActionId], ["canvas.navigate"]);
    const ackCall = firstRespondCall(ackRespond);
    expectRecordFields(requireRespondPayload(ackCall, "ack response"), "ack payload", {
      nodeId: "ios-node-queued",
      ackedIds: [queuedActionId],
      remainingCount: 0,
    });

    const emptyPullRespond = await pullPending("ios-node-queued", ["canvas.navigate"]);
    const emptyPullCall = firstRespondCall(emptyPullRespond);
    expectRecordFields(
      requireRespondPayload(emptyPullCall, "empty pull response"),
      "empty pull payload",
      {
        nodeId: "ios-node-queued",
        actions: [],
      },
    );
  });

  it("drops queued actions that are no longer allowed at pull time", async () => {
    mocks.loadApnsRegistration.mockResolvedValue(null);
    const allowlistedCommands = new Set(["camera.snap", "canvas.navigate"]);
    mocks.resolveNodeCommandAllowlist.mockImplementation(() => new Set(allowlistedCommands));
    mocks.isNodeCommandAllowed.mockImplementation(
      ({ command, declaredCommands, allowlist }: MockNodeCommandPolicyParams) => {
        if (!allowlist.has(command)) {
          return { ok: false, reason: "command not allowlisted" };
        }
        if (!declaredCommands?.includes(command)) {
          return { ok: false, reason: "command not declared by node" };
        }
        return { ok: true };
      },
    );

    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-policy",
        commands: ["camera.snap", "canvas.navigate"],
        platform: "iOS 26.4.0",
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: "NODE_BACKGROUND_UNAVAILABLE",
          message: "NODE_BACKGROUND_UNAVAILABLE: canvas/camera/screen commands require foreground",
        },
      }),
    };

    await invokeNode({
      nodeRegistry,
      requestParams: {
        nodeId: "ios-node-policy",
        command: "camera.snap",
        params: { facing: "front" },
        idempotencyKey: "idem-policy",
      },
    });

    const preChangePullRespond = await pullPending("ios-node-policy", [
      "camera.snap",
      "canvas.navigate",
    ]);
    const preChangePullCall = firstRespondCall(preChangePullRespond);
    const preChangePayload = requireRespondPayload(preChangePullCall, "pre-change pull response");
    expectRecordFields(preChangePayload, "pre-change pull payload", {
      nodeId: "ios-node-policy",
    });
    expectQueuedAction(preChangePayload, {
      command: "camera.snap",
      paramsJSON: JSON.stringify({ facing: "front" }),
    });

    allowlistedCommands.delete("camera.snap");

    const pullRespond = await pullPending("ios-node-policy", ["camera.snap", "canvas.navigate"]);
    const pullCall = firstRespondCall(pullRespond);
    expectRecordFields(requireRespondPayload(pullCall, "pull response"), "pull payload", {
      nodeId: "ios-node-policy",
      actions: [],
    });
  });

  it("dedupes queued foreground actions by idempotency key", async () => {
    mocks.loadApnsRegistration.mockResolvedValue(null);

    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-dedupe",
        commands: ["canvas.navigate"],
        platform: "iPadOS 26.4.0",
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: "NODE_BACKGROUND_UNAVAILABLE",
          message: "NODE_BACKGROUND_UNAVAILABLE: canvas/camera/screen commands require foreground",
        },
      }),
    };

    await invokeNode({
      nodeRegistry,
      requestParams: {
        nodeId: "ios-node-dedupe",
        command: "canvas.navigate",
        params: { url: "http://example.com/first" },
        idempotencyKey: "idem-dedupe",
      },
    });
    await invokeNode({
      nodeRegistry,
      requestParams: {
        nodeId: "ios-node-dedupe",
        command: "canvas.navigate",
        params: { url: "http://example.com/first" },
        idempotencyKey: "idem-dedupe",
      },
    });

    const pullRespond = await pullPending("ios-node-dedupe", ["canvas.navigate"]);
    const pullCall = firstRespondCall(pullRespond);
    const pullPayload = requireRespondPayload(pullCall, "pull response");
    expectRecordFields(pullPayload, "pull payload", {
      nodeId: "ios-node-dedupe",
    });
    expectQueuedAction(pullPayload, {
      command: "canvas.navigate",
      paramsJSON: JSON.stringify({ url: "http://example.com/first" }),
    });
  });
});

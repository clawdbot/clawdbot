import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_SERVER_CAPS,
  type HelloOk,
} from "../../../../packages/gateway-protocol/src/index.js";

// Hello update-scope tests cover authenticated role/scope and recovery ownership projection.

const {
  buildGatewaySnapshotMock,
  emitGatewayAuthSecurityEventMock,
  getHealthCacheMock,
  listControlUiPluginTabsMock,
  listControlUiPluginWidgetKindsMock,
  readCurrentRuntimeConfigHealthMock,
  redeemDeviceBootstrapTokenProfileMock,
} = vi.hoisted(() => ({
  emitGatewayAuthSecurityEventMock: vi.fn(),
  getHealthCacheMock: vi.fn<() => HelloOk["snapshot"]["health"] | null>(() => null),
  listControlUiPluginTabsMock: vi.fn((_scopes: readonly string[]) => []),
  listControlUiPluginWidgetKindsMock: vi.fn((_scopes: readonly string[]) => []),
  readCurrentRuntimeConfigHealthMock: vi.fn<() => HelloOk["snapshot"]["health"]["runtimeConfig"]>(
    () => undefined,
  ),
  redeemDeviceBootstrapTokenProfileMock: vi.fn(),
  buildGatewaySnapshotMock: vi.fn((opts?: { includeUpdateDetails?: boolean }) => {
    const updateAvailable = {
      currentVersion: "2026.8.7",
      latestVersion: "2026.8.8",
      channel: "dev",
    };
    return {
      presence: [],
      health: {},
      stateVersion: { presence: 1, health: 1 },
      uptimeMs: 1,
      sessionDefaults: {
        defaultAgentId: "main",
        mainKey: "main",
        mainSessionKey: "main",
        scope: "per-sender",
      },
      updateAvailable: opts?.includeUpdateDetails
        ? {
            ...updateAvailable,
            currentSha: "1111111111111111111111111111111111111111",
            upstreamRef: "origin/main",
            upstreamSha: "2222222222222222222222222222222222222222",
            commitsBehind: 1,
            commits: [{ sha: "2222222", subject: "Detailed commit subject" }],
          }
        : updateAvailable,
      ...(opts?.includeUpdateDetails
        ? {
            updateSchedule: {
              channel: "dev",
              autoEnabled: true,
              install: { kind: "git" },
            },
          }
        : {}),
    };
  }),
}));

vi.mock("../../../infra/device-bootstrap.js", () => ({
  redeemDeviceBootstrapTokenProfile: redeemDeviceBootstrapTokenProfileMock,
  restoreGenericDeviceBootstrapToken: vi.fn(async () => undefined),
}));

vi.mock("../../device-pair-setup-completion.js", () => ({
  broadcastSetupHandoffDeliveryUncertain: vi.fn(),
  broadcastSetupHandoffCompletion: vi.fn(),
  confirmSetupHandoffDelivery: vi.fn(async () => undefined),
  consumeSetupHandoff: vi.fn(async () => undefined),
}));

vi.mock("../health-state.js", () => ({
  buildGatewaySnapshot: buildGatewaySnapshotMock,
  getHealthCache: getHealthCacheMock,
  getHealthVersion: vi.fn(() => 1),
  readCurrentRuntimeConfigHealth: readCurrentRuntimeConfigHealthMock,
}));

vi.mock("../../../state/user-profiles.js", () => ({
  hasMultipleSessionSharingIdentities: vi.fn(() => false),
}));

vi.mock("../../control-ui-plugin-tabs.js", () => ({
  listControlUiPluginTabs: listControlUiPluginTabsMock,
  listControlUiPluginWidgetKinds: listControlUiPluginWidgetKindsMock,
}));

vi.mock("./connect-auth-security.js", () => ({
  emitGatewayAuthSecurityEvent: emitGatewayAuthSecurityEventMock,
}));

vi.mock("../../../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../version.js")>()),
  resolveRuntimeServiceBuildId: () => "build-a",
}));

import { sendGatewayHello } from "./connect-hello.js";

function makeContext(role: "operator" | "node", scopes: string[]) {
  return {
    handler: {
      connId: `conn-${role}`,
      bootId: "gateway-boot-a",
      gatewayMethods: [],
      events: [],
      buildRequestContext: () => ({ nodeRegistry: { get: () => undefined } }),
      refreshHealthSnapshot: vi.fn(async () => ({})),
      close: vi.fn(),
      advanceHandshakePhase: vi.fn(),
      setCloseCause: vi.fn(),
      logGateway: { warn: vi.fn() },
      logHealth: { error: vi.fn() },
    },
    frame: { id: `hello-${role}` },
    connectParams: {
      client: { id: "gateway-client", version: "dev", platform: "test", mode: "backend" },
      role,
      scopes,
    },
    configSnapshot: {},
    sendFrame: vi.fn(async () => undefined),
    pendingNodePairingCleanup: {},
    releasePendingNodePairingCleanup: vi.fn(async () => undefined),
  };
}

function makeState(role: "operator" | "node", scopes: string[]) {
  return {
    resolvedAuth: { mode: "none" },
    role,
    scopes,
    device: null,
    hasTokenAuth: false,
    hasPasswordAuth: false,
    authResult: { ok: true, method: "none" },
    authMethod: "none",
    issuedBootstrapProfile: null,
    handoffBootstrapProfile: null,
    deviceToken: null,
    bootstrapDeviceTokens: [],
  };
}

function helloPayload(context: ReturnType<typeof makeContext>) {
  const response = context.sendFrame.mock.calls.at(0)?.at(0) as { payload?: HelloOk } | undefined;
  return response?.payload;
}

function helloSnapshot(context: ReturnType<typeof makeContext>) {
  return helloPayload(context)?.snapshot;
}

function expectRedactedHelloSnapshot(context: ReturnType<typeof makeContext>) {
  expect(helloSnapshot(context)).toEqual(
    expect.objectContaining({
      updateAvailable: {
        currentVersion: "2026.8.7",
        latestVersion: "2026.8.8",
        channel: "dev",
      },
    }),
  );
  expect(helloSnapshot(context)?.updateSchedule).toBeUndefined();
}

describe("sendGatewayHello update detail scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHealthCacheMock.mockReturnValue(null);
    readCurrentRuntimeConfigHealthMock.mockReturnValue(undefined);
    redeemDeviceBootstrapTokenProfileMock.mockResolvedValue({ fullyRedeemed: false });
  });

  it("includes the synchronously current shared health publication before passive refresh", async () => {
    getHealthCacheMock.mockReturnValue({
      ok: true,
      ts: 1,
      durationMs: 1,
      channels: {},
      channelOrder: [],
      channelLabels: {},
      heartbeatSeconds: 0,
      defaultAgentId: "main",
      agents: [],
      sessions: { path: "sessions.db", count: 0, recent: [] },
      runtimeConfig: {
        state: "drift",
        driftPaths: ["gateway.auth"],
        message:
          "Live gateway runtime config differs from the latest completed reload observation; restart is required.",
      },
    });
    const context = makeContext("operator", ["operator.admin"]);

    await sendGatewayHello(
      context as never,
      makeState("operator", ["operator.admin"]) as never,
      {},
    );

    expect(helloSnapshot(context)?.health.runtimeConfig).toEqual({
      state: "drift",
      driftPaths: ["gateway.auth"],
      message:
        "Live gateway runtime config differs from the latest completed reload observation; restart is required.",
    });
    expect(helloSnapshot(context)?.health.runtimeConfig).not.toHaveProperty(
      "liveSourceFingerprint",
    );
    expect(helloSnapshot(context)?.health.runtimeConfig).not.toHaveProperty(
      "observedSourceFingerprint",
    );
    expect(getHealthCacheMock.mock.invocationCallOrder[0]).toBeLessThan(
      context.sendFrame.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(context.sendFrame.mock.invocationCallOrder[0]).toBeLessThan(
      context.handler.refreshHealthSnapshot.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("projects current config health when observation invalidation clears the full cache", async () => {
    readCurrentRuntimeConfigHealthMock.mockReturnValue({
      state: "drift",
      driftPaths: ["agents.entries"],
      message:
        "Live gateway runtime config differs from the latest completed reload observation; restart is required.",
    });
    const context = makeContext("operator", ["operator.read"]);

    await sendGatewayHello(context as never, makeState("operator", ["operator.read"]) as never, {});

    expect(helloSnapshot(context)?.health.runtimeConfig).toEqual({
      state: "drift",
      driftPaths: ["agents.entries"],
      message:
        "Live gateway runtime config differs from the latest completed reload observation; restart is required.",
    });
    expect(getHealthCacheMock.mock.invocationCallOrder[0]).toBeLessThan(
      readCurrentRuntimeConfigHealthMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(readCurrentRuntimeConfigHealthMock.mock.invocationCallOrder[0]).toBeLessThan(
      context.sendFrame.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(context.sendFrame.mock.invocationCallOrder[0]).toBeLessThan(
      context.handler.refreshHealthSnapshot.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("finalizes config health after awaited bootstrap bookkeeping", async () => {
    const oldHealth: HelloOk["snapshot"]["health"] = {
      ok: true,
      ts: 1,
      durationMs: 1,
      channels: {},
      channelOrder: [],
      channelLabels: {},
      heartbeatSeconds: 0,
      defaultAgentId: "main",
      agents: [],
      sessions: { path: "sessions.db", count: 0, recent: [] },
      runtimeConfig: { state: "ok" as const },
    };
    let releaseRedemption: (() => void) | undefined;
    const redemptionStarted = new Promise<void>((resolve) => {
      redeemDeviceBootstrapTokenProfileMock.mockImplementationOnce(async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseRedemption = release;
        });
        return { fullyRedeemed: false };
      });
    });
    getHealthCacheMock.mockReturnValue(oldHealth);
    const context = makeContext("operator", ["operator.read"]);
    const state = {
      ...makeState("operator", ["operator.read"]),
      device: { id: "device-a" },
      devicePublicKey: "public-key-a",
      bootstrapTokenCandidate: "bootstrap-a",
      authResult: { ok: true, method: "bootstrap-token" },
      authMethod: "bootstrap-token",
      issuedBootstrapProfile: { kind: "test" },
    };

    const hello = sendGatewayHello(context as never, state as never, {});
    await redemptionStarted;
    getHealthCacheMock.mockReturnValue(null);
    readCurrentRuntimeConfigHealthMock.mockReturnValue({
      state: "drift",
      driftPaths: ["agents.entries"],
      message:
        "Live gateway runtime config differs from the latest completed reload observation; restart is required.",
    });
    releaseRedemption?.();
    await hello;

    expect(helloSnapshot(context)?.health).toEqual({
      runtimeConfig: {
        state: "drift",
        driftPaths: ["agents.entries"],
        message:
          "Live gateway runtime config differs from the latest completed reload observation; restart is required.",
      },
    });
    expect(helloSnapshot(context)?.health).not.toMatchObject(oldHealth);
    expect(getHealthCacheMock).toHaveBeenCalledOnce();
    expect(readCurrentRuntimeConfigHealthMock.mock.invocationCallOrder[0]).toBeLessThan(
      context.sendFrame.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it.each([
    { label: "pairing-only operator", role: "operator" as const, scopes: ["operator.pairing"] },
    { label: "node", role: "node" as const, scopes: ["operator.read"] },
  ])("omits update details for a $label", async ({ role, scopes }) => {
    const context = makeContext(role, scopes);
    await sendGatewayHello(context as never, makeState(role, scopes) as never, {});

    expect(buildGatewaySnapshotMock).toHaveBeenCalledWith({
      includeSensitive: false,
      includeUpdateDetails: false,
    });
    expectRedactedHelloSnapshot(context);
  });

  it("includes update details for an operator.read client", async () => {
    const context = makeContext("operator", ["operator.read"]);
    await sendGatewayHello(context as never, makeState("operator", ["operator.read"]) as never, {});

    expect(buildGatewaySnapshotMock).toHaveBeenCalledWith({
      includeSensitive: false,
      includeUpdateDetails: true,
    });
    expect(helloSnapshot(context)).toEqual(
      expect.objectContaining({
        updateAvailable: expect.objectContaining({
          upstreamRef: "origin/main",
          upstreamSha: "2222222222222222222222222222222222222222",
          commitsBehind: 1,
          commits: [{ sha: "2222222", subject: "Detailed commit subject" }],
        }),
        updateSchedule: {
          channel: "dev",
          autoEnabled: true,
          install: { kind: "git" },
        },
      }),
    );
    expect(helloPayload(context)?.server.buildId).toBe("build-a");
    expect(helloPayload(context)?.server.bootId).toBe("gateway-boot-a");
    expect(helloPayload(context)?.server.controlUiBuildSource).toBe("bundled");
    expect(helloPayload(context)?.features.capabilities).toContain(
      GATEWAY_SERVER_CAPS.SESSION_UNREAD_ACK_CONTRACT,
    );
  });

  it("omits package build identity for independently built configured UI roots", async () => {
    const context = makeContext("operator", ["operator.read"]);
    context.configSnapshot = { gateway: { controlUi: { root: "/custom/ui" } } };

    await sendGatewayHello(context as never, makeState("operator", ["operator.read"]) as never, {});

    expect(helloPayload(context)?.server.buildId).toBeUndefined();
    expect(helloPayload(context)?.server.controlUiBuildSource).toBe("configured");
  });

  it("keeps hello projection and telemetry at effective scopes", async () => {
    const state = {
      ...makeState("operator", ["operator.pairing"]),
      deviceToken: {
        token: "paired-token",
        role: "operator",
        scopes: ["operator.read", "operator.admin"],
        createdAtMs: 1,
      },
    };

    const context = makeContext("operator", ["operator.pairing"]);
    await sendGatewayHello(context as never, state as never, {});

    expect(buildGatewaySnapshotMock).toHaveBeenCalledWith({
      includeSensitive: false,
      includeUpdateDetails: false,
    });
    expectRedactedHelloSnapshot(context);
    expect(helloPayload(context)?.auth).toEqual({
      role: "operator",
      scopes: ["operator.pairing"],
      recoveryMigrationAllowed: true,
      recoveryScope: expect.stringMatching(/^[A-Za-z0-9_-]+$/u),
      deviceToken: "paired-token",
      issuedAtMs: 1,
    });
    expect(listControlUiPluginTabsMock).toHaveBeenCalledWith(["operator.pairing"], {
      requireGatewayAuthGrant: false,
    });
    expect(listControlUiPluginWidgetKindsMock).toHaveBeenCalledWith(["operator.pairing"]);
    expect(emitGatewayAuthSecurityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: "operator", scopes: ["operator.pairing"] }),
    );
  });

  it("keeps recovery scope owned by the canonical authenticated principal", async () => {
    const sendFor = async (principal: string, token: string, generation: string) => {
      const context = makeContext("operator", ["operator.read"]);
      const state = {
        ...makeState("operator", ["operator.read"]),
        device: { id: "device-a" },
        deviceToken: {
          token,
          role: "operator",
          scopes: ["operator.read"],
          createdAtMs: 1,
        },
        sessionSharedGatewaySessionGeneration: generation,
      };
      await sendGatewayHello(context as never, state as never, {}, principal);
      const auth = helloPayload(context)?.auth;
      expect(auth?.recoveryMigrationAllowed).toBeUndefined();
      return auth?.recoveryScope;
    };

    const alice = await sendFor("profile-alice", "device-token-a", "shared-generation-a");
    const rotated = await sendFor("profile-alice", "device-token-b", "shared-generation-b");
    const bob = await sendFor("profile-bob", "device-token-a", "shared-generation-a");

    expect(rotated).toBe(alice);
    expect(bob).not.toBe(alice);
    for (const scope of [alice, rotated, bob]) {
      expect(scope).toMatch(/^[A-Za-z0-9_-]+$/u);
      expect(scope).not.toContain("profile-");
      expect(scope).not.toContain("device-token-");
    }
  });
});

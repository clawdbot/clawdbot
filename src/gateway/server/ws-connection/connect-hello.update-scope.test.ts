import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HelloOk } from "../../../../packages/gateway-protocol/src/index.js";

// Hello update-scope tests cover authenticated role/scope and recovery ownership projection.

const {
  buildGatewaySnapshotMock,
  emitGatewayAuthSecurityEventMock,
  listControlUiPluginTabsMock,
  listControlUiPluginWidgetKindsMock,
} = vi.hoisted(() => ({
  emitGatewayAuthSecurityEventMock: vi.fn(),
  listControlUiPluginTabsMock: vi.fn((_scopes: readonly string[]) => []),
  listControlUiPluginWidgetKindsMock: vi.fn((_scopes: readonly string[]) => []),
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

vi.mock("../health-state.js", () => ({
  buildGatewaySnapshot: buildGatewaySnapshotMock,
  getHealthCache: vi.fn(() => null),
  getHealthVersion: vi.fn(() => 1),
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
    controlUiDeviceAuthMigrationPending: false,
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
    expect(helloPayload(context)?.server.controlUiBuildSource).toBe("bundled");
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

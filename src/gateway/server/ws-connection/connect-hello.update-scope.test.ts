// Hello update-scope tests cover the authenticated role/scope projection passed to snapshots.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { buildGatewaySnapshotMock } = vi.hoisted(() => ({
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
  listProfiles: vi.fn(() => []),
}));

vi.mock("./connect-auth-security.js", () => ({
  emitGatewayAuthSecurityEvent: vi.fn(),
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
    authMethod: "none",
    issuedBootstrapProfile: null,
    handoffBootstrapProfile: null,
    deviceToken: null,
    bootstrapDeviceTokens: [],
    controlUiDeviceAuthMigrationPending: false,
  };
}

function helloSnapshot(context: ReturnType<typeof makeContext>) {
  const response = context.sendFrame.mock.calls.at(0)?.at(0) as
    | {
        payload?: {
          snapshot?: {
            updateAvailable?: Record<string, unknown>;
            updateSchedule?: unknown;
          };
        };
      }
    | undefined;
  return response?.payload?.snapshot;
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
  });

  it("does not widen the snapshot to broader reusable device-token scopes", async () => {
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
  });
});

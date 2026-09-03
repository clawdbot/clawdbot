// WebSocket message-handler health tests cover post-connect startup-unavailable and health-gated dispatch.
import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { WebSocket } from "ws";
import { ConnectErrorDetailCodes } from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import { ErrorCodes, PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { prepareSystemAgentRunAdmission } from "../../../agents/admitted-run-context.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticSecurityEvent,
} from "../../../infra/diagnostic-events.js";
import {
  getActiveDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import {
  ensureProfileForEmail,
  setDisplayName,
  ensureProfileForTailscaleIdentity,
  setAvatar,
  syncGitHubIdentity,
} from "../../../state/user-profiles.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { mintAgentRuntimeIdentityToken } from "../../agent-runtime-identity-token.js";
import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "../../auth.js";
import { ControlUiGitHubError } from "../../control-ui-github-api.js";
import type { HealthSummary } from "../../health/types.js";
import type { GatewayAttributedIngress } from "../../ingress-attribution.js";
import { getGatewayLocalUserIngress } from "../../local-user-ingress.js";
import { getOperatorApprovalRuntimeToken } from "../../operator-approval-runtime-token.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "../../server-constants.js";
import { handleGatewayRequest } from "../../server-methods.js";
import { resolveGatewayCronCreatorAuthorityAdmission } from "../../server-methods/cron-creator-authority-admission.js";
import type { GatewayRequestContext } from "../../server-methods/types.js";
import {
  enforceSharedGatewaySessionGenerationForConfigWrite,
  getRequiredSharedGatewaySessionGeneration,
} from "../../server-shared-auth-generation.js";
import { resolveSharedGatewaySessionGeneration } from "../ws-shared-generation.js";
import { resolvePinnedClientMetadata } from "./connect-device-metadata.js";
import { GatewayNodeLifecycleDispatchTracker } from "./node-lifecycle-dispatch.js";

const {
  buildGatewaySnapshotMock,
  getHealthCacheMock,
  getHealthVersionMock,
  incrementPresenceVersionMock,
  loadConfigMock,
  createAuthenticatedGitHubIdentitySyncMock,
  adoptTailscaleProfileAvatarMock,
  ensureProfileForEmailMock,
  ensureGatewayOwnerProfileMock,
  prepareGatewayNodeConnectMock,
  resolveConnectAuthStateMock,
  upsertPresenceMock,
} = vi.hoisted(() => ({
  buildGatewaySnapshotMock: vi.fn(() => ({
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
  })),
  getHealthCacheMock: vi.fn(() => null),
  getHealthVersionMock: vi.fn(() => 1),
  incrementPresenceVersionMock: vi.fn(() => 2),
  loadConfigMock: vi.fn(() => ({
    gateway: {
      auth: { mode: "none" },
      controlUi: {
        allowedOrigins: ["http://127.0.0.1:19001"],
      },
    },
  })),
  createAuthenticatedGitHubIdentitySyncMock: vi.fn(),
  adoptTailscaleProfileAvatarMock: vi.fn(),
  ensureProfileForEmailMock: vi.fn(),
  ensureGatewayOwnerProfileMock: vi.fn(),
  prepareGatewayNodeConnectMock: vi.fn(),
  resolveConnectAuthStateMock: vi.fn(),
  upsertPresenceMock: vi.fn(),
}));

vi.mock("../../../state/user-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../state/user-profiles.js")>();
  adoptTailscaleProfileAvatarMock.mockImplementation(actual.adoptTailscaleProfileAvatar);
  ensureProfileForEmailMock.mockImplementation(actual.ensureProfileForEmail);
  ensureGatewayOwnerProfileMock.mockImplementation(actual.ensureGatewayOwnerProfile);
  return {
    ...actual,
    adoptTailscaleProfileAvatar: adoptTailscaleProfileAvatarMock,
    ensureProfileForEmail: ensureProfileForEmailMock,
    ensureGatewayOwnerProfile: ensureGatewayOwnerProfileMock,
  };
});

vi.mock("../../../infra/host-account-name.js", () => ({
  resolveHostAccountName: vi.fn(async () => "Gateway Person"),
}));

vi.mock("../../github-user-identity.js", () => ({
  createAuthenticatedGitHubIdentitySync: createAuthenticatedGitHubIdentitySyncMock,
}));

vi.mock("./auth-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth-context.js")>();
  resolveConnectAuthStateMock.mockImplementation(actual.resolveConnectAuthState);
  return { ...actual, resolveConnectAuthState: resolveConnectAuthStateMock };
});

vi.mock("./connect-node-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./connect-node-session.js")>();
  prepareGatewayNodeConnectMock.mockImplementation(actual.prepareGatewayNodeConnect);
  return { ...actual, prepareGatewayNodeConnect: prepareGatewayNodeConnectMock };
});

vi.mock("../../../config/config.js", () => ({
  getRuntimeConfig: loadConfigMock,
  loadConfig: loadConfigMock,
}));

function localUserIngressFor(client: unknown) {
  return typeof client === "object" && client !== null
    ? getGatewayLocalUserIngress(client)
    : undefined;
}

vi.mock("../../../config/io.js", () => ({
  getRuntimeConfig: loadConfigMock,
}));
vi.mock("../../../infra/system-presence.js", () => ({
  upsertPresence: upsertPresenceMock,
  listSystemPresence: vi.fn(() => []),
}));

vi.mock("../../server-methods.js", () => ({
  handleGatewayRequest: vi.fn(),
}));

vi.mock("../health-state.js", () => ({
  buildGatewaySnapshot: buildGatewaySnapshotMock,
  getHealthCache: getHealthCacheMock,
  getHealthVersion: getHealthVersionMock,
}));

import { attachGatewayWsMessageHandler } from "./message-handler.js";

const DEVICE_TOKEN_MUTATION_PARAMS = {
  deviceId: "device-1",
  role: "operator",
} as const satisfies Record<string, unknown>;
const NODE_PAIR_REMOVE_PARAMS = {
  nodeId: "device-1",
} as const satisfies Record<string, unknown>;

function waitForFast(assertion: () => void | Promise<void>) {
  return vi.waitFor(assertion, { interval: 1 });
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createHealthSummary(): HealthSummary {
  return {
    ok: true,
    ts: 1,
    durationMs: 1,
    channels: {},
    channelOrder: [],
    channelLabels: {},
    heartbeatSeconds: 0,
    defaultAgentId: "main",
    agents: [],
    sessions: {
      path: "",
      count: 0,
      recent: [],
    },
  };
}

async function createTestAgentRuntimeIdentityLease() {
  const prepared = prepareSystemAgentRunAdmission(
    {},
    "run-1",
    "ops",
    "message-handler.post-connect-health.test",
  );
  await prepared.admit("embedded");
  onTestFinished(prepared.close);
  return {
    close: prepared.close,
    token: await mintAgentRuntimeIdentityToken({
      agentId: "ops",
      sessionKey: "agent:ops:telegram:direct:alice",
      operationalRunInstance: prepared.operationalRunInstance,
    }),
  };
}

type ConnectedTestClient = {
  invalidated: boolean;
  invalidatedReason?: string;
  connect: {
    client: {
      id: string;
      version: string;
      platform: string;
      mode: string;
    };
    role: "operator";
    scopes: string[];
  };
  connId: string;
  usesSharedGatewayAuth: false;
};

type CloseGatewayConnection = (code?: number, reason?: string) => void;
type SetCloseCause = (cause: string, meta?: Record<string, unknown>) => void;

function createConnectedTestClient(params: {
  connId: string;
  invalidated?: boolean;
  invalidatedReason?: string;
}): ConnectedTestClient {
  return {
    invalidated: params.invalidated ?? false,
    ...(params.invalidatedReason ? { invalidatedReason: params.invalidatedReason } : {}),
    connect: {
      client: {
        id: "openclaw-control-ui",
        version: "dev",
        platform: "test",
        mode: "ui",
      },
      role: "operator",
      scopes: [],
    },
    connId: params.connId,
    usesSharedGatewayAuth: false,
  };
}

function createCloseMock() {
  return vi.fn<CloseGatewayConnection>();
}

function createSetCloseCauseMock() {
  return vi.fn<SetCloseCause>();
}

function captureSecurityEvents(): {
  events: DiagnosticSecurityEvent[];
  stop: () => void;
} {
  const events: DiagnosticSecurityEvent[] = [];
  const stop = onInternalDiagnosticEvent((event, metadata) => {
    if (metadata.trusted && event.type === "security.event") {
      events.push(event);
    }
  });
  return { events, stop };
}

function attachGatewayHarness(options: {
  connId: string;
  connectNonce: string;
  refreshHealthSnapshot?: GatewayRequestContext["refreshHealthSnapshot"];
  requestOrigin?: string;
  requestHost?: string;
  headers?: Record<string, string>;
  ingressAttribution?: GatewayAttributedIngress;
  remoteAddr?: string;
  localAddr?: string;
  resolvedAuth?: ResolvedGatewayAuth;
  getRequiredSharedGatewaySessionGeneration?: () => string | undefined;
  rateLimiter?: AuthRateLimiter;
  client?: unknown;
  close?: CloseGatewayConnection;
  isClosed?: () => boolean;
  setCloseCause?: SetCloseCause;
}) {
  const socketSend = vi.fn((_payload: string, cb?: (err?: Error) => void) => {
    cb?.();
  });
  let onMessage: ((data: string) => void) | undefined;
  const socket = {
    readyState: 1,
    _receiver: { _maxPayload: MAX_PREAUTH_PAYLOAD_BYTES, _allowSynchronousEvents: false },
    send: socketSend,
    on: vi.fn((event: string, handler: (data: string) => void) => {
      if (event === "message") {
        onMessage = handler;
      }
      return socket;
    }),
  } as unknown as WebSocket;
  const send = vi.fn((_frame: unknown) => ({ kind: "sent" }) as const);
  let client: unknown = options.client ?? null;
  const requestHost = options.requestHost ?? "127.0.0.1:19001";
  const remoteAddr = options.remoteAddr ?? "127.0.0.1";
  const localAddr = options.localAddr ?? "127.0.0.1";
  const resolvedAuth: ResolvedGatewayAuth = options.resolvedAuth ?? {
    mode: "none",
    allowTailscale: false,
  };
  const advanceHandshakePhase = vi.fn();
  const logWsControl = createLogger();
  const refreshConnectedUserProfile = vi.fn<
    NonNullable<GatewayRequestContext["refreshConnectedUserProfile"]>
  >((profile) => {
    const authenticatedUserProfile = (
      client as { authenticatedUserProfile?: Record<string, unknown> } | null
    )?.authenticatedUserProfile;
    if (authenticatedUserProfile) {
      Object.assign(authenticatedUserProfile, {
        profileId: profile.id,
        displayName: profile.displayName,
        avatarRevision: profile.avatarRevision,
        hasAvatar: profile.hasAvatar,
        updatedAt: profile.updatedAt,
      });
    }
  });
  attachGatewayWsMessageHandler({
    socket,
    bootId: "post-connect-health-test-boot",
    upgradeReq: {
      headers: {
        host: requestHost,
        ...(options.requestOrigin ? { origin: options.requestOrigin } : {}),
        ...options.headers,
      },
      socket: { localAddress: localAddr, remoteAddress: remoteAddr },
    } as unknown as IncomingMessage,
    ingressAttribution:
      options.ingressAttribution ??
      (remoteAddr === "127.0.0.1"
        ? {
            kind: "direct-local",
            clientIp: remoteAddr,
            rateLimit: { subject: { key: remoteAddr }, resetOnSuccess: true },
          }
        : {
            kind: "direct-remote",
            clientIp: remoteAddr,
            rateLimit: { subject: { key: remoteAddr }, resetOnSuccess: true },
          }),
    connId: options.connId,
    remoteAddr,
    localAddr,
    requestHost,
    requestOrigin: options.requestOrigin,
    connectNonce: options.connectNonce,
    getResolvedAuth: () => resolvedAuth,
    getRequiredSharedGatewaySessionGeneration: options.getRequiredSharedGatewaySessionGeneration,
    rateLimiter: options.rateLimiter,
    gatewayMethods: [],
    events: [],
    extraHandlers: {},
    buildRequestContext: () =>
      ({
        refreshConnectedUserProfile,
        broadcast: vi.fn(),
        incrementPresenceVersion: incrementPresenceVersionMock,
        getHealthVersion: getHealthVersionMock,
      }) as never,
    nodeLifecycleDispatch: new GatewayNodeLifecycleDispatchTracker(),
    refreshHealthSnapshot:
      options.refreshHealthSnapshot ?? vi.fn(async () => createHealthSummary()),
    send,
    close: options.close ?? createCloseMock(),
    isClosed: options.isClosed ?? vi.fn(() => false),
    clearHandshakeTimer: vi.fn(),
    getClient: () => client as never,
    setClient: (next) => {
      client = next;
      return true;
    },
    setHandshakeState: vi.fn(),
    advanceHandshakePhase,
    setCloseCause: options.setCloseCause ?? createSetCloseCauseMock(),
    setLastFrameMeta: vi.fn(),
    originCheckMetrics: { hostHeaderFallbackAccepted: 0 },
    logGateway: createLogger() as never,
    logHealth: createLogger() as never,
    logWsControl: logWsControl as never,
  });
  if (onMessage === undefined) {
    throw new Error("expected websocket message handler");
  }
  const sendMessage = onMessage;
  return {
    advanceHandshakePhase,
    logWsControl,
    refreshConnectedUserProfile,
    send,
    socketSend,
    sendRequest: (
      id: string,
      method: string,
      params: Record<string, unknown> = {},
      traceparent?: string,
    ) => {
      sendMessage(
        JSON.stringify({
          type: "req",
          id,
          method,
          params,
          ...(traceparent ? { traceparent } : {}),
        }),
      );
    },
    sendConnect: (id: string, params: Record<string, unknown>, traceparent?: string) => {
      sendMessage(
        JSON.stringify({
          type: "req",
          id,
          method: "connect",
          params,
          ...(traceparent ? { traceparent } : {}),
        }),
      );
    },
    get client() {
      return client;
    },
  };
}

describe("WebSocket request trace context", () => {
  const upstreamTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const upstreamSpanId = "00f067aa0ba902b7";
  const upstreamTraceparent = `00-${upstreamTraceId}-${upstreamSpanId}-01`;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not carry connect-frame trace context into later requests", async () => {
    let observed: DiagnosticTraceContext | undefined;
    vi.mocked(handleGatewayRequest).mockImplementation(async () => {
      observed = getActiveDiagnosticTraceContext();
    });
    const harness = attachGatewayHarness({
      connId: "conn-connect-trace",
      connectNonce: "nonce-connect-trace",
    });

    harness.sendConnect(
      "connect-1",
      {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: "gateway-client",
          version: "dev",
          platform: "test",
          mode: "backend",
        },
        role: "operator",
        caps: [],
      },
      upstreamTraceparent,
    );
    await waitForFast(() => {
      expect(harness.client).not.toBeNull();
    });

    harness.sendRequest("untraced-1", "status.summary");

    await waitForFast(() => {
      expect(observed).toBeDefined();
    });
    expect(observed?.traceId).not.toBe(upstreamTraceId);
  });
});

function connectTrustedProxyUser(connId: string, clientOverrides: Record<string, unknown> = {}) {
  loadConfigMock.mockImplementationOnce(() => ({
    gateway: {
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
        },
      },
      trustedProxies: ["10.0.0.1"],
      controlUi: {
        allowedOrigins: ["http://127.0.0.1:19001"],
      },
    },
  }));
  const harness = attachGatewayHarness({
    connId,
    connectNonce: `nonce-${connId}`,
    requestHost: "gateway.example.com:18789",
    requestOrigin: "http://127.0.0.1:19001",
    remoteAddr: "10.0.0.1",
    resolvedAuth: {
      mode: "trusted-proxy",
      allowTailscale: false,
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
      },
    },
    headers: {
      "x-forwarded-for": "203.0.113.10",
      "x-forwarded-user": "alice@example.com",
      "x-forwarded-proto": "https",
    },
    ingressAttribution: {
      kind: "trusted-proxy",
      clientIp: "203.0.113.10",
      rateLimit: { subject: { key: "203.0.113.10" }, resetOnSuccess: true },
    },
  });
  harness.sendConnect(`connect-${connId}`, {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: "openclaw-control-ui",
      version: "dev",
      platform: "test",
      mode: "ui",
      ...clientOverrides,
    },
    role: "operator",
    caps: [],
  });
  return harness;
}

describe("attachGatewayWsMessageHandler post-connect health refresh", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    vi.clearAllMocks();
    createAuthenticatedGitHubIdentitySyncMock.mockImplementation(
      (params: {
        authResult: { method?: string; tailscaleIdentity?: { login: string } };
        authConfig?: { trustedProxy?: { userHeader?: string; requiredHeaders?: string[] } };
      }) => {
        const tailscaleGitHub = params.authResult.tailscaleIdentity?.login.endsWith("@github");
        const trustedProxy = params.authConfig?.trustedProxy;
        const cloudflareAccess =
          params.authResult.method === "trusted-proxy" &&
          trustedProxy?.userHeader?.toLowerCase() === "cf-access-authenticated-user-email" &&
          trustedProxy.requiredHeaders?.some(
            (header) => header.toLowerCase() === "cf-access-jwt-assertion",
          );
        if (!tailscaleGitHub && !cloudflareAccess) {
          return undefined;
        }
        return vi.fn(async () => {
          const profile = params.authResult.tailscaleIdentity
            ? ensureProfileForTailscaleIdentity(params.authResult.tailscaleIdentity)
            : ensureProfileForEmailMock("authenticated@example.test");
          return { profileId: profile.id, updatedAt: profile.updatedAt };
        });
      },
    );
  });

  it("keeps one editable owner profile across shared-secret and device-token reconnects", async () => {
    await withOpenClawTestState({ label: "gateway-owner-reconnect" }, async () => {
      let profileId: string | undefined;
      for (const authMethod of ["token", "password", "device-token", "none"] as const) {
        resolveConnectAuthStateMock.mockResolvedValueOnce({
          authResult: { ok: true, method: authMethod },
          authOk: true,
          authMethod,
          sharedAuthOk: true,
        });
        const harness = attachGatewayHarness({
          connId: `owner-${authMethod}`,
          connectNonce: `nonce-${authMethod}`,
        });
        harness.sendConnect(`connect-${authMethod}`, {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: { id: "test", version: "dev", platform: "test", mode: "test" },
          role: "operator",
          scopes: ["operator.read"],
          caps: [],
        });
        await waitForFast(() => expect(harness.client).not.toBeNull());
        const client = harness.client as {
          authenticatedUserId?: string;
          authenticatedUserProfile?: { profileId: string; displayName: string };
          connect: { scopes: string[] };
        };
        expect(client.authenticatedUserId).toBeUndefined();
        expect(client.authenticatedUserProfile).toMatchObject({
          displayName: profileId ? "Saved Owner" : "Gateway Person",
        });
        if (profileId) {
          expect(client.authenticatedUserProfile?.profileId).toBe(profileId);
        } else {
          profileId = client.authenticatedUserProfile!.profileId;
          setDisplayName(profileId, "Saved Owner");
        }
        expect(client.connect.scopes).toEqual(
          authMethod === "token" || authMethod === "password" ? [] : ["operator.read"],
        );
        expect(upsertPresenceMock).toHaveBeenCalledWith(
          `owner-${authMethod}`,
          expect.objectContaining({
            user: expect.objectContaining({
              id: profileId,
              identity: { type: "profile", id: profileId },
            }),
          }),
        );
      }
    });
  });

  it.each(["token", "password", "device-token", "none"] as const)(
    "limits owner attribution to shared-secret %s access when roles are configured",
    async (authMethod) => {
      await withOpenClawTestState({ label: "gateway-owner-role-gate" }, async () => {
        loadConfigMock.mockImplementationOnce(() => ({
          gateway: {
            auth: { mode: "none" },
            roles: {
              default: "reader",
              definitions: {
                reader: {
                  sessions: { others: "view" as const },
                  agents: "*" as const,
                  scopes: ["operator.read" as const],
                },
              },
            },
            controlUi: { allowedOrigins: ["http://127.0.0.1:19001"] },
          },
        }));
        resolveConnectAuthStateMock.mockResolvedValueOnce({
          authResult: { ok: true, method: authMethod },
          authOk: true,
          authMethod,
          sharedAuthOk: true,
        });
        const harness = attachGatewayHarness({
          connId: `roles-${authMethod}`,
          connectNonce: `roles-${authMethod}`,
        });
        harness.sendConnect("connect", {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: { id: "test", version: "dev", platform: "test", mode: "test" },
          role: "operator",
          auth: { token: "owner-fixture" },
          scopes: ["operator.read", "operator.admin"],
          caps: [],
        });
        const owner = authMethod === "token" || authMethod === "password";
        if (!owner) {
          await waitForFast(() =>
            expect(harness.send).toHaveBeenCalledWith(
              expect.objectContaining({
                ok: false,
                error: expect.objectContaining({
                  details: expect.objectContaining({
                    code: ConnectErrorDetailCodes.AUTH_VERIFIED_USER_REQUIRED,
                  }),
                }),
              }),
            ),
          );
          expect(harness.client).toBeNull();
          expect(ensureGatewayOwnerProfileMock).not.toHaveBeenCalled();
          return;
        }
        await waitForFast(() => expect(harness.client).not.toBeNull());
        const client = harness.client as {
          authenticatedUserId?: string;
          authenticatedUserProfile?: unknown;
          connect: { scopes: string[] };
          internal?: { operatorRoleActor?: unknown };
        };
        expect(client.authenticatedUserId).toBeUndefined();
        expect(Boolean(client.authenticatedUserProfile)).toBe(owner);
        expect(client.connect.scopes).toEqual([]);
        expect(client.internal?.operatorRoleActor).toEqual(owner ? { kind: "system" } : undefined);
      });
    },
  );

  it("continues an owner connect without a profile when storage fails", async () => {
    resolveConnectAuthStateMock.mockResolvedValueOnce({
      authResult: { ok: true, method: "token" },
      authOk: true,
      authMethod: "token",
      sharedAuthOk: true,
    });
    ensureGatewayOwnerProfileMock.mockImplementationOnce(() => {
      throw new Error("profile storage unavailable");
    });
    const harness = attachGatewayHarness({
      connId: "owner-storage-failure",
      connectNonce: "owner-storage-failure",
    });
    harness.sendConnect("connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: { id: "test", version: "dev", platform: "test", mode: "test" },
      role: "operator",
      auth: { token: "owner-fixture" },
      caps: [],
    });
    await waitForFast(() => expect(harness.client).not.toBeNull());
    expect(harness.client).not.toHaveProperty("authenticatedUserProfile");
    expect(harness.logWsControl.warn).toHaveBeenCalledWith(
      expect.stringContaining("user profile resolution failed"),
    );
    expect(harness.socketSend).toHaveBeenCalled();
  });

  it.each(["cli", "backend", "probe"])(
    "keeps ephemeral %s connections unidentified",
    async (mode) => {
      await withOpenClawTestState({ label: "gateway-owner-ephemeral" }, async () => {
        resolveConnectAuthStateMock.mockResolvedValueOnce({
          authResult: { ok: true, method: "token" },
          authOk: true,
          authMethod: "token",
          sharedAuthOk: true,
        });
        const harness = attachGatewayHarness({
          connId: `ephemeral-${mode}`,
          connectNonce: `nonce-${mode}`,
        });
        harness.sendConnect("connect", {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: { id: "gateway-client", version: "dev", platform: "test", mode },
          role: "operator",
          auth: { token: "owner-fixture" },
          caps: [],
        });
        await waitForFast(() => expect(harness.client).not.toBeNull());
        expect(harness.client).not.toHaveProperty("authenticatedUserProfile");
      });
    },
  );

  it("closes invalidated clients before dispatching queued requests", () => {
    const close = createCloseMock();
    const setCloseCause = createSetCloseCauseMock();
    const client = createConnectedTestClient({
      connId: "conn-invalidated",
      invalidated: true,
      invalidatedReason: "device-token-revoked",
    });
    const harness = attachGatewayHarness({
      connId: "conn-invalidated",
      connectNonce: "nonce-invalidated",
      client,
      close,
      setCloseCause,
    });

    harness.sendRequest("queued-1", "status.summary");

    expect(setCloseCause).toHaveBeenCalledWith("client-invalidated", {
      reason: "device-token-revoked",
      method: "status.summary",
    });
    expect(close).toHaveBeenCalledWith(4001, "client invalidated: device-token-revoked");
    expect(handleGatewayRequest).not.toHaveBeenCalled();
  });

  it("waits for credential mutation requests before dispatching later queued requests", async () => {
    let releaseMutation: (() => void) | undefined;
    const close = createCloseMock();
    const setCloseCause = createSetCloseCauseMock();
    const client = createConnectedTestClient({ connId: "conn-invalidating" });
    vi.mocked(handleGatewayRequest).mockImplementation(async (opts) => {
      expect(opts.req.method).toBe("device.token.revoke");
      await new Promise<void>((resolve) => {
        releaseMutation = resolve;
      });
      client.invalidated = true;
      client.invalidatedReason = "device-token-revoked";
    });

    const harness = attachGatewayHarness({
      connId: "conn-invalidating",
      connectNonce: "nonce-invalidating",
      client,
      close,
      setCloseCause,
    });

    harness.sendRequest("revoke-1", "device.token.revoke", DEVICE_TOKEN_MUTATION_PARAMS);
    harness.sendRequest("queued-1", "status.summary");

    await waitForFast(() => {
      expect(handleGatewayRequest).toHaveBeenCalledTimes(1);
      expect(releaseMutation).toBeTypeOf("function");
    });

    releaseMutation?.();

    await waitForFast(() => {
      expect(close).toHaveBeenCalledWith(4001, "client invalidated: device-token-revoked");
    });
    expect(handleGatewayRequest).toHaveBeenCalledTimes(1);
    expect(setCloseCause).toHaveBeenCalledWith("client-invalidated", {
      reason: "device-token-revoked",
      method: "status.summary",
    });
  });

  it("waits for device-backed node removal before dispatching later queued requests", async () => {
    let releaseMutation: (() => void) | undefined;
    const close = createCloseMock();
    const setCloseCause = createSetCloseCauseMock();
    const client = createConnectedTestClient({ connId: "conn-node-invalidating" });
    vi.mocked(handleGatewayRequest).mockImplementation(async (opts) => {
      expect(opts.req.method).toBe("node.pair.remove");
      await new Promise<void>((resolve) => {
        releaseMutation = resolve;
      });
      client.invalidated = true;
      client.invalidatedReason = "device-pair-removed";
    });

    const harness = attachGatewayHarness({
      connId: "conn-node-invalidating",
      connectNonce: "nonce-node-invalidating",
      client,
      close,
      setCloseCause,
    });

    harness.sendRequest("remove-node-1", "node.pair.remove", NODE_PAIR_REMOVE_PARAMS);
    harness.sendRequest("queued-1", "status.summary");

    await waitForFast(() => {
      expect(handleGatewayRequest).toHaveBeenCalledTimes(1);
      expect(releaseMutation).toBeTypeOf("function");
    });

    releaseMutation?.();

    await waitForFast(() => {
      expect(close).toHaveBeenCalledWith(4001, "client invalidated: device-pair-removed");
    });
    expect(handleGatewayRequest).toHaveBeenCalledTimes(1);
    expect(setCloseCause).toHaveBeenCalledWith("client-invalidated", {
      reason: "device-pair-removed",
      method: "status.summary",
    });
  });

  it("drains credential mutation barriers installed by earlier queued requests", async () => {
    let releaseFirstMutation: (() => void) | undefined;
    let releaseSecondMutation: (() => void) | undefined;
    const close = createCloseMock();
    const client = createConnectedTestClient({ connId: "conn-chained-invalidating" });
    vi.mocked(handleGatewayRequest).mockImplementation(async (opts) => {
      if (opts.req.method === "device.token.rotate") {
        await new Promise<void>((resolve) => {
          releaseFirstMutation = resolve;
        });
        return;
      }
      expect(opts.req.method).toBe("device.token.revoke");
      await new Promise<void>((resolve) => {
        releaseSecondMutation = resolve;
      });
      client.invalidated = true;
      client.invalidatedReason = "device-token-revoked";
    });

    const harness = attachGatewayHarness({
      connId: "conn-chained-invalidating",
      connectNonce: "nonce-chained-invalidating",
      client,
      close,
    });

    harness.sendRequest("rotate-1", "device.token.rotate", DEVICE_TOKEN_MUTATION_PARAMS);
    harness.sendRequest("revoke-1", "device.token.revoke", DEVICE_TOKEN_MUTATION_PARAMS);
    harness.sendRequest("queued-1", "status.summary");

    await waitForFast(() => {
      expect(handleGatewayRequest).toHaveBeenCalledTimes(1);
      expect(releaseFirstMutation).toBeTypeOf("function");
    });

    releaseFirstMutation?.();
    await waitForFast(() => {
      expect(handleGatewayRequest).toHaveBeenCalledTimes(2);
      expect(releaseSecondMutation).toBeTypeOf("function");
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(handleGatewayRequest).toHaveBeenCalledTimes(2);

    releaseSecondMutation?.();
    await waitForFast(() => {
      expect(close).toHaveBeenCalledWith(4001, "client invalidated: device-token-revoked");
    });
    expect(handleGatewayRequest).toHaveBeenCalledTimes(2);
  });

  it("uses the injected runtime-aware health refresh after hello", async () => {
    let resolveRefresh: (() => void) | undefined;
    const refreshHealthSnapshot = vi.fn<GatewayRequestContext["refreshHealthSnapshot"]>(
      () =>
        new Promise((resolve) => {
          resolveRefresh = () => resolve(createHealthSummary());
        }),
    );
    const isClosed = vi.fn(() => false);
    const harness = attachGatewayHarness({
      connId: "conn-1",
      connectNonce: "nonce-1",
      refreshHealthSnapshot,
      isClosed,
    });
    const captured = captureSecurityEvents();

    try {
      harness.sendConnect("connect-1", {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: "gateway-client",
          version: "dev",
          platform: "test",
          mode: "backend",
        },
        role: "operator",
        caps: [],
      });

      await waitForFast(() => {
        expect(harness.socketSend).toHaveBeenCalled();
      });
    } finally {
      captured.stop();
    }
    const hello = JSON.parse(harness.socketSend.mock.calls.at(0)?.[0] ?? "{}") as { ok?: boolean };
    expect(hello.ok).toBe(true);
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      action: "gateway.auth.succeeded",
      outcome: "success",
      severity: "low",
      actor: { kind: "operator", role: "operator" },
      target: { kind: "gateway", name: "websocket" },
      policy: { id: "gateway.websocket-auth", decision: "allow" },
      control: { id: "gateway.ws.connect", family: "auth" },
      attributes: {
        auth_mode: "none",
        auth_method: "none",
        auth_provided: "none",
        client_mode: "backend",
        has_device_identity: false,
        scope_count: 0,
      },
    });

    await waitForFast(() => {
      expect(refreshHealthSnapshot).toHaveBeenCalledWith({ probe: false });
    });
    resolveRefresh?.();
  });

  it("projects a stable durable profile into presence and refreshes avatar state on reconnect", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      await withOpenClawTestState({ label: "gateway-profile-presence" }, async () => {
        const connect = async (suffix: string) => {
          const connId = `conn-trusted-proxy-user-${suffix}`;
          const harness = connectTrustedProxyUser(connId);
          await waitForFast(() => {
            expect(upsertPresenceMock).toHaveBeenCalledWith(connId, expect.anything());
          });
          const presence = upsertPresenceMock.mock.calls.find(([key]) => key === connId)?.[1] as {
            user?: { id: string; email?: string; name?: string; avatarUrl?: string };
          };
          return { connId, harness, presence };
        };

        const first = await connect("first");
        const profileId = first.presence.user?.id;
        expect(profileId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        );
        expect(first.presence.user).toEqual({
          id: profileId,
          identity: { type: "profile", id: profileId },
          email: "alice@example.com",
          name: "alice",
          avatarUrl: expect.stringMatching(
            new RegExp(`^/api/users/${profileId}/avatar\\?v=\\d+$`, "u"),
          ),
        });
        expect(first.harness.client).toMatchObject({
          authenticatedUserId: "alice@example.com",
          authenticatedUserProfile: {
            profileId,
            displayName: "alice",
            hasAvatar: false,
          },
        });
        expect(localUserIngressFor(first.harness.client)).toMatchObject({
          facts: {
            ingress: {
              kind: "gateway-client",
              rawSourceRef: profileId,
              state: "present",
            },
            invoker: {
              state: "present",
              kind: "person",
              rawPrincipalRef: profileId,
              displayLabel: "alice",
            },
            assurance: expect.arrayContaining([
              expect.objectContaining({ kind: "durable-profile" }),
              expect.objectContaining({ kind: "trusted-proxy" }),
            ]),
          },
        });

        expect(setAvatar(profileId!, new Uint8Array([1, 2, 3]), "image/png").ok).toBe(true);
        const second = await connect("second");
        const secondAvatarUrl = second.presence.user?.avatarUrl;
        expect(second.presence.user).toEqual({
          id: profileId,
          identity: { type: "profile", id: profileId },
          email: "alice@example.com",
          name: "alice",
          avatarUrl: expect.stringMatching(
            new RegExp(`^/api/users/${profileId}/avatar\\?v=[0-9a-f]{64}-png$`, "u"),
          ),
        });
        expect(second.harness.client).toMatchObject({
          authenticatedUserProfile: { profileId, hasAvatar: true },
        });

        expect(setAvatar(profileId!, new Uint8Array([4, 5, 6]), "image/png").ok).toBe(true);
        const third = await connect("third");
        expect(third.presence.user?.avatarUrl).not.toBe(secondAvatarUrl);
        expect(third.presence.user?.avatarUrl).toMatch(
          new RegExp(`^/api/users/${profileId}/avatar\\?v=[0-9a-f]{64}-png$`, "u"),
        );

        expect(ensureProfileForEmailMock).toHaveBeenCalledTimes(3);
        expect(first.harness.logWsControl.info).toHaveBeenCalledWith(
          "authenticated user connected conn=conn-trusted-proxy-user-first user=alice@example.com",
        );
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("registers a verified profile before detached Tailscale avatar adoption completes", async () => {
    await withOpenClawTestState({ label: "gateway-tailscale-avatar-detached" }, async () => {
      let resolveAvatar:
        | ((profile: {
            id: string;
            displayName: string | null;
            avatarMime: "image/png" | "image/jpeg" | "image/webp" | null;
            mergedInto: string | null;
            createdAt: number;
            updatedAt: number;
          }) => void)
        | undefined;
      adoptTailscaleProfileAvatarMock.mockImplementationOnce(
        async () =>
          await new Promise((resolve) => {
            resolveAvatar = resolve;
          }),
      );
      resolveConnectAuthStateMock.mockResolvedValueOnce({
        authResult: {
          ok: true,
          method: "tailscale",
          user: "ada@passkey",
          tailscaleIdentity: {
            login: "ada@passkey",
            name: "Ada Lovelace",
            profilePic: "https://avatars.example.test/ada.png",
          },
        },
        authOk: true,
        authMethod: "tailscale",
        sharedAuthOk: true,
      });
      const harness = attachGatewayHarness({
        connId: "conn-tailscale-avatar-detached",
        connectNonce: "nonce-tailscale-avatar-detached",
      });

      harness.sendConnect("connect-tailscale-avatar-detached", {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: "gateway-client",
          version: "dev",
          platform: "test",
          mode: "backend",
        },
        role: "operator",
        caps: [],
      });

      await waitForFast(() => {
        expect(harness.client).toMatchObject({
          authenticatedUserId: "ada@passkey",
          authenticatedUserIsTailscaleProvider: true,
          authenticatedUserProfile: { displayName: "Ada Lovelace", hasAvatar: false },
        });
        expect(localUserIngressFor(harness.client)).toMatchObject({
          facts: {
            invoker: { state: "present", kind: "person", displayLabel: "Ada Lovelace" },
            assurance: expect.arrayContaining([
              expect.objectContaining({ kind: "durable-profile" }),
              expect.objectContaining({ kind: "tailscale-whois" }),
            ]),
          },
        });
        expect(adoptTailscaleProfileAvatarMock).toHaveBeenCalledOnce();
      });
      expect(harness.socketSend).toHaveBeenCalled();

      const profile = (
        harness.client as {
          authenticatedUserProfile: { profileId: string; displayName: string; updatedAt: number };
        }
      ).authenticatedUserProfile;
      expect(setAvatar(profile.profileId, new Uint8Array([7, 8, 9]), "image/png").ok).toBe(true);
      const adoptedUpdatedAt = profile.updatedAt + 1;
      resolveAvatar?.({
        id: profile.profileId,
        displayName: profile.displayName,
        avatarMime: "image/png",
        mergedInto: null,
        createdAt: profile.updatedAt,
        updatedAt: adoptedUpdatedAt,
      });
      await waitForFast(() => {
        expect(harness.client).toMatchObject({
          authenticatedUserProfile: { hasAvatar: true, updatedAt: adoptedUpdatedAt },
        });
      });
      expect(createAuthenticatedGitHubIdentitySyncMock).toHaveBeenCalledWith(
        expect.objectContaining({
          authResult: expect.objectContaining({ method: "tailscale", user: "ada@passkey" }),
        }),
      );
    });
  });

  it.each([false, true])(
    "completes deferred identity sync only while its socket is live (closed=%s)",
    async (closedBeforeSync) => {
      await withOpenClawTestState({ label: "gateway-github-profile-deferred" }, async () => {
        const canonical = ensureProfileForEmail("canonical@example.test");
        let finishSync: (() => void) | undefined;
        const sync = vi.fn(
          async () =>
            await new Promise<{ profileId: string; updatedAt: number }>((resolve) => {
              finishSync = () =>
                resolve({ profileId: canonical.id, updatedAt: canonical.updatedAt });
            }),
        );
        createAuthenticatedGitHubIdentitySyncMock.mockReturnValueOnce(sync);
        resolveConnectAuthStateMock.mockResolvedValueOnce({
          authResult: {
            ok: true,
            method: "tailscale",
            user: "ada@github",
            tailscaleIdentity: { login: "ada@github", name: "Ada Lovelace" },
          },
          authOk: true,
          authMethod: "tailscale",
          sharedAuthOk: true,
        });
        let closed = false;
        const harness = attachGatewayHarness({
          connId: "conn-github-identity-detached",
          connectNonce: "nonce-github-identity-detached",
          isClosed: () => closed,
        });

        harness.sendConnect("connect-github-identity-detached", {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: "test",
            version: "dev",
            platform: "test",
            mode: "test",
          },
          role: "operator",
          caps: [],
        });

        await waitForFast(() => {
          expect(harness.socketSend).toHaveBeenCalled();
          expect(harness.client).toMatchObject({
            authenticatedUserId: "ada@github",
            authenticatedGitHubIdentitySync: expect.any(Function),
          });
          expect(harness.client).not.toHaveProperty("authenticatedUserProfile");
          expect(localUserIngressFor(harness.client)).toMatchObject({
            facts: { invoker: { state: "unknown" } },
          });
          expect(createAuthenticatedGitHubIdentitySyncMock).toHaveBeenCalledWith(
            expect.objectContaining({
              authResult: expect.objectContaining({ method: "tailscale", user: "ada@github" }),
            }),
          );
          expect(sync).toHaveBeenCalledOnce();
        });
        const initialPresence = upsertPresenceMock.mock.calls.find(
          ([key]) => key === "conn-github-identity-detached",
        )?.[1];
        expect(initialPresence).not.toHaveProperty("user");
        expect(harness.socketSend.mock.invocationCallOrder[0]).toBeLessThan(
          sync.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
        expect(finishSync).toBeTypeOf("function");
        closed = closedBeforeSync;
        finishSync?.();

        if (closedBeforeSync) {
          await vi.dynamicImportSettled();
          expect(harness.client).not.toHaveProperty("authenticatedUserProfile");
          expect(harness.refreshConnectedUserProfile).not.toHaveBeenCalled();
          return;
        }

        await waitForFast(() => {
          expect(harness.client).toMatchObject({
            authenticatedUserProfile: { profileId: canonical.id },
          });
          expect(localUserIngressFor(harness.client)).toMatchObject({
            facts: {
              invoker: { state: "present", kind: "person", rawPrincipalRef: canonical.id },
            },
          });
          expect(harness.refreshConnectedUserProfile).toHaveBeenCalledWith(
            expect.objectContaining({ id: canonical.id }),
          );
        });
      });
    },
  );

  it("resolves a GitHub-backed role before registering the connection or sending hello", async () => {
    await withOpenClawTestState({ label: "gateway-github-role-before-hello" }, async () => {
      const canonical = ensureProfileForEmail("canonical@example.test");
      const syncCompletion = createDeferred<{ profileId: string; updatedAt: number }>();
      const sync = vi.fn(async () => await syncCompletion.promise);
      createAuthenticatedGitHubIdentitySyncMock.mockReturnValueOnce(sync);
      loadConfigMock.mockImplementationOnce(() => ({
        gateway: {
          auth: {
            mode: "none",
            identityScopes: { "ada@github": ["operator.read", "operator.admin"] },
          },
          roles: {
            default: "guest",
            definitions: {
              guest: {
                sessions: { others: "view" as const },
                agents: "*" as const,
                scopes: ["operator.read" as const],
              },
            },
          },
          controlUi: { allowedOrigins: ["http://127.0.0.1:19001"] },
        },
      }));
      resolveConnectAuthStateMock.mockResolvedValueOnce({
        authResult: {
          ok: true,
          method: "tailscale",
          user: "ada@github",
          tailscaleIdentity: { login: "ada@github", name: "Ada Lovelace" },
        },
        authOk: true,
        authMethod: "tailscale",
        sharedAuthOk: true,
      });
      const harness = attachGatewayHarness({
        connId: "conn-github-role-before-hello",
        connectNonce: "nonce-github-role-before-hello",
      });

      harness.sendConnect("connect-github-role-before-hello", {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: { id: "test", version: "dev", platform: "test", mode: "test" },
        role: "operator",
        caps: [],
      });

      await waitForFast(() => expect(sync).toHaveBeenCalledOnce());
      expect(harness.client).toBeNull();
      expect(harness.socketSend).not.toHaveBeenCalled();
      syncCompletion.resolve({ profileId: canonical.id, updatedAt: canonical.updatedAt });

      await waitForFast(() => {
        expect(harness.client).toMatchObject({
          connect: { scopes: ["operator.read"] },
          authenticatedUserProfile: { profileId: canonical.id },
        });
        expect(harness.socketSend).toHaveBeenCalled();
      });
      expect(sync.mock.invocationCallOrder[0]).toBeLessThan(
        harness.socketSend.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
    });
  });

  it.each([
    {
      error: new Error("private upstream failure"),
      message: "profile verification is unavailable",
    },
    {
      error: new ControlUiGitHubError(429, "private upstream failure"),
      message: "GitHub is rate limiting profile verification",
    },
  ])(
    "rejects unavailable configured-role identity with actionable guidance ($message)",
    async ({ error, message }) => {
      await withOpenClawTestState(
        { label: "gateway-github-role-verification-failure" },
        async () => {
          createAuthenticatedGitHubIdentitySyncMock.mockReturnValueOnce(
            vi.fn(async () => {
              throw error;
            }),
          );
          loadConfigMock.mockImplementationOnce(() => ({
            gateway: {
              auth: {
                mode: "none",
                identityScopes: { "ada@github": ["operator.admin"] },
              },
              roles: {
                default: "guest",
                definitions: {
                  guest: {
                    sessions: { others: "view" as const },
                    agents: "*" as const,
                    scopes: ["operator.read" as const],
                  },
                },
              },
              controlUi: { allowedOrigins: ["http://127.0.0.1:19001"] },
            },
          }));
          resolveConnectAuthStateMock.mockResolvedValueOnce({
            authResult: {
              ok: true,
              method: "tailscale",
              user: "ada@github",
              tailscaleIdentity: { login: "ada@github", name: "Ada Lovelace" },
            },
            authOk: true,
            authMethod: "tailscale",
            sharedAuthOk: true,
          });
          const close = createCloseMock();
          const harness = attachGatewayHarness({
            connId: "conn-github-role-verification-failure",
            connectNonce: "nonce-github-role-verification-failure",
            close,
          });

          harness.sendConnect("connect-github-role-verification-failure", {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: { id: "test", version: "dev", platform: "test", mode: "test" },
            role: "operator",
            caps: [],
          });

          await waitForFast(() => {
            expect(harness.send).toHaveBeenCalledWith(
              expect.objectContaining({
                id: "connect-github-role-verification-failure",
                ok: false,
                error: expect.objectContaining({
                  code: ErrorCodes.UNAVAILABLE,
                  message: expect.stringContaining(message),
                  retryable: true,
                  details: { code: "AUTHENTICATED_PROFILE_UNAVAILABLE" },
                }),
              }),
            );
            expect(close).toHaveBeenCalledWith(1013, expect.stringContaining(message));
          });
          expect(harness.client).toBeNull();
          expect(harness.socketSend).not.toHaveBeenCalled();
          expect(JSON.stringify(harness.send.mock.calls)).not.toContain("private upstream failure");
        },
      );
    },
  );

  it("keeps a mutable GitHub alias unattributed when immutable sync fails", async () => {
    await withOpenClawTestState({ label: "gateway-github-profile-failure" }, async () => {
      syncGitHubIdentity({
        identity: { accountId: 10, login: "prior-owner" },
        authenticationAlias: { kind: "github-login", login: "released-login" },
        initialDisplayName: "Prior Verified Owner",
      });
      const sync = vi.fn(async () => {
        throw new Error("GitHub unavailable");
      });
      createAuthenticatedGitHubIdentitySyncMock.mockReturnValueOnce(sync);
      resolveConnectAuthStateMock.mockResolvedValueOnce({
        authResult: {
          ok: true,
          method: "tailscale",
          user: "released-login@github",
          tailscaleIdentity: { login: "released-login@github", name: "New Account" },
        },
        authOk: true,
        authMethod: "tailscale",
        sharedAuthOk: true,
      });
      const harness = attachGatewayHarness({
        connId: "conn-github-identity-failure",
        connectNonce: "nonce-github-identity-failure",
      });

      harness.sendConnect("connect-github-identity-failure", {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: { id: "test", version: "dev", platform: "test", mode: "test" },
        role: "operator",
        caps: [],
      });

      await waitForFast(() => {
        expect(harness.socketSend).toHaveBeenCalled();
        expect(sync).toHaveBeenCalledOnce();
      });
      await waitForFast(() => {
        expect(harness.client).not.toHaveProperty("authenticatedUserProfile");
        expect(localUserIngressFor(harness.client)).toMatchObject({
          facts: { invoker: { state: "unknown" } },
        });
      });
      const presence = upsertPresenceMock.mock.calls.find(
        ([key]) => key === "conn-github-identity-failure",
      )?.[1];
      expect(presence).not.toHaveProperty("user");
      expect(harness.refreshConnectedUserProfile).not.toHaveBeenCalled();
    });
  });

  it("mints Cloudflare sync only for the standard trusted-proxy header contract", async () => {
    const assertion = "header.payload.signature";
    loadConfigMock.mockImplementationOnce(() => ({
      gateway: {
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "cf-access-authenticated-user-email",
            requiredHeaders: ["CF-Access-JWT-Assertion"],
          },
        },
        trustedProxies: ["10.0.0.1"],
        controlUi: { allowedOrigins: ["https://team.openclaw.ai"] },
      },
    }));
    const resolvedAuth: ResolvedGatewayAuth = {
      mode: "trusted-proxy",
      allowTailscale: false,
      trustedProxy: {
        userHeader: "cf-access-authenticated-user-email",
        requiredHeaders: ["CF-Access-JWT-Assertion"],
      },
    };
    const harness = attachGatewayHarness({
      connId: "conn-cloudflare-access",
      connectNonce: "nonce-cloudflare-access",
      requestHost: "team.openclaw.ai",
      requestOrigin: "https://team.openclaw.ai",
      remoteAddr: "10.0.0.1",
      resolvedAuth,
      headers: {
        "cf-access-authenticated-user-email": "ada@example.com",
        "cf-access-jwt-assertion": assertion,
        "x-forwarded-for": "203.0.113.10",
      },
      ingressAttribution: {
        kind: "trusted-proxy",
        clientIp: "203.0.113.10",
        rateLimit: { subject: { key: "203.0.113.10" }, resetOnSuccess: true },
      },
    });

    harness.sendConnect("connect-cloudflare-access", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "openclaw-control-ui",
        version: "dev",
        platform: "test",
        mode: "ui",
      },
      role: "operator",
      caps: [],
    });

    await waitForFast(() => {
      expect(harness.client).toMatchObject({
        authenticatedUserId: "ada@example.com",
        authenticatedGitHubIdentitySync: expect.any(Function),
      });
      expect(createAuthenticatedGitHubIdentitySyncMock).toHaveBeenCalledWith(
        expect.objectContaining({
          authResult: expect.objectContaining({
            method: "trusted-proxy",
            user: "ada@example.com",
          }),
          authConfig: expect.objectContaining({ mode: "trusted-proxy" }),
          requestHeaders: expect.objectContaining({
            "cf-access-jwt-assertion": assertion,
          }),
        }),
      );
    });
  });

  it("carries the client-reported time zone into the presence entry", async () => {
    connectTrustedProxyUser("conn-time-zone", { timeZone: "Europe/Vienna" });

    await waitForFast(() => {
      expect(upsertPresenceMock).toHaveBeenCalledWith(
        "conn-time-zone",
        expect.objectContaining({ timeZone: "Europe/Vienna" }),
      );
    });
  });

  it("does not mint Cloudflare sync for a generic or non-required-header proxy", async () => {
    const harness = connectTrustedProxyUser("conn-generic-proxy-github");
    await waitForFast(() => expect(harness.client).not.toBeNull());

    expect(createAuthenticatedGitHubIdentitySyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authResult: expect.objectContaining({ method: "trusted-proxy" }),
        authConfig: expect.objectContaining({
          trustedProxy: expect.objectContaining({ userHeader: "x-forwarded-user" }),
        }),
      }),
    );
    expect(harness.client).not.toHaveProperty("authenticatedGitHubIdentitySync");
  });

  it("keeps presence fallback but records unknown invoker when profile resolution fails", async () => {
    ensureProfileForEmailMock.mockImplementationOnce(() => {
      throw new Error("profile store unavailable");
    });
    const harness = connectTrustedProxyUser("conn-profile-store-failure");

    await waitForFast(() => {
      expect(upsertPresenceMock).toHaveBeenCalledWith(
        "conn-profile-store-failure",
        expect.objectContaining({
          user: { id: "alice@example.com", email: "alice@example.com" },
        }),
      );
    });
    expect(harness.client).toMatchObject({ authenticatedUserId: "alice@example.com" });
    expect(localUserIngressFor(harness.client)).toMatchObject({
      facts: {
        ingress: expect.not.objectContaining({ rawSourceRef: expect.anything() }),
        invoker: { state: "unknown" },
        assurance: [
          {
            kind: "trusted-proxy",
            rawEvidenceRef: "gateway-auth:trusted-proxy",
            strength: "boundary-verified",
          },
        ],
      },
    });
    expect(harness.client).not.toMatchObject({ authenticatedUserProfile: expect.anything() });
    expect(harness.logWsControl.warn).toHaveBeenCalledTimes(1);
    expect(harness.logWsControl.warn).toHaveBeenCalledWith(
      expect.stringContaining("profile store unavailable"),
    );
  });

  it("does not project user identity for a token-authenticated backend", async () => {
    const harness = attachGatewayHarness({
      connId: "conn-token-userless",
      connectNonce: "nonce-token-userless",
      resolvedAuth: {
        mode: "token",
        token: "gateway-token",
        allowTailscale: false,
      },
    });

    harness.sendConnect("connect-token-userless", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        version: "dev",
        platform: "test",
        mode: "backend",
      },
      role: "operator",
      caps: [],
      auth: { token: "gateway-token" },
    });

    await waitForFast(() => {
      expect(harness.socketSend.mock.calls.length + harness.send.mock.calls.length).toBeGreaterThan(
        0,
      );
    });
    const tokenHello = harness.socketSend.mock.calls.at(0)?.[0];
    expect(
      typeof tokenHello === "string" ? JSON.parse(tokenHello) : harness.send.mock.calls.at(0)?.[0],
    ).toMatchObject({
      ok: true,
    });
    expect(upsertPresenceMock).not.toHaveBeenCalled();
    expect(harness.client).not.toMatchObject({ authenticatedUserId: expect.anything() });
    const localUserIngress = localUserIngressFor(harness.client);
    expect(localUserIngress).toMatchObject({
      facts: { ingress: expect.not.objectContaining({ rawSourceRef: expect.anything() }) },
    });
    expect(localUserIngress?.facts.invoker).toBeUndefined();
    expect(ensureProfileForEmailMock).not.toHaveBeenCalled();
  });

  it("rejects a shared-auth handshake when credentials rotate before session attachment", async () => {
    const oldAuth = {
      mode: "token" as const,
      token: "gateway-token-old",
      allowTailscale: false,
    };
    const oldGeneration = resolveSharedGatewaySessionGeneration(oldAuth, []);
    const newGeneration = resolveSharedGatewaySessionGeneration(
      { ...oldAuth, token: "gateway-token-new" },
      [],
    );
    expect(oldGeneration).toBeTypeOf("string");
    expect(newGeneration).toBeTypeOf("string");
    const generationState = { current: oldGeneration, required: null };
    const preparationStarted = createDeferred();
    const releasePreparation = createDeferred();
    prepareGatewayNodeConnectMock.mockImplementationOnce(async () => {
      preparationStarted.resolve();
      await releasePreparation.promise;
      return true;
    });
    const close = createCloseMock();
    const setCloseCause = createSetCloseCauseMock();
    const harness = attachGatewayHarness({
      connId: "conn-token-rotated-during-connect",
      connectNonce: "nonce-token-rotated-during-connect",
      resolvedAuth: oldAuth,
      getRequiredSharedGatewaySessionGeneration: () =>
        getRequiredSharedGatewaySessionGeneration(generationState),
      close,
      setCloseCause,
    });

    harness.sendConnect("connect-token-rotated-during-connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        version: "dev",
        platform: "test",
        mode: "backend",
      },
      role: "operator",
      caps: [],
      auth: { token: oldAuth.token },
    });
    await preparationStarted.promise;
    enforceSharedGatewaySessionGenerationForConfigWrite({
      state: generationState,
      nextConfig: {
        gateway: {
          auth: { mode: "token", token: "gateway-token-new" },
          reload: { mode: "off" },
        },
      },
      resolveRuntimeSnapshotGeneration: () => newGeneration,
      clients: [],
    });
    releasePreparation.resolve();

    await waitForFast(() => {
      expect(close).toHaveBeenCalledWith(4001, "gateway auth changed");
    });
    expect(setCloseCause).toHaveBeenCalledWith("gateway-auth-rotated", {
      authGenerationStale: true,
    });
    expect(harness.client).toBeNull();
    expect(harness.socketSend).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it("emits a security event for rejected gateway auth", async () => {
    const close = createCloseMock();
    const harness = attachGatewayHarness({
      connId: "conn-auth-failed",
      connectNonce: "nonce-auth-failed",
      requestHost: "gateway.example.com:18789",
      remoteAddr: "203.0.113.50",
      resolvedAuth: {
        mode: "token",
        token: "gateway-token",
        allowTailscale: false,
      },
      close,
    });
    const captured = captureSecurityEvents();

    try {
      harness.sendConnect("connect-auth-failed", {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: "gateway-client",
          version: "dev",
          platform: "test",
          mode: "backend",
        },
        role: "operator",
        scopes: ["operator.admin"],
        caps: [],
        auth: { token: "wrong-token" },
      });

      await waitForFast(() => {
        expect(close).toHaveBeenCalledWith(1008, expect.stringContaining("unauthorized"));
      });
    } finally {
      captured.stop();
    }

    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      action: "gateway.auth.failed",
      outcome: "denied",
      severity: "medium",
      reason: "token_mismatch",
      actor: { kind: "operator", role: "operator" },
      target: { kind: "gateway", name: "websocket" },
      policy: {
        id: "gateway.websocket-auth",
        decision: "deny",
        reason: "token_mismatch",
      },
      control: { id: "gateway.ws.connect", family: "auth" },
      attributes: {
        auth_mode: "token",
        auth_method: "token",
        auth_provided: "token",
        client_mode: "backend",
        has_device_identity: false,
        scope_count: 0,
        rate_limited: false,
      },
    });
    expect(JSON.stringify(captured.events)).not.toContain("wrong-token");
    expect(JSON.stringify(captured.events)).not.toContain("gateway-token");
    const response = harness.send.mock.calls.at(0)?.[0] as
      | { error?: Record<string, unknown> }
      | undefined;
    expect(response?.error).not.toHaveProperty("retryable");
    expect(response?.error).not.toHaveProperty("retryAfterMs");
  });

  it("returns retry timing when gateway auth is rate-limited", async () => {
    const retryAfterMs = 15_000;
    const rateLimiter: AuthRateLimiter = {
      check: vi.fn(() => ({ allowed: false, remaining: 0, retryAfterMs })),
      recordFailure: vi.fn(),
      recordFailureAndDelay: vi.fn(async () => {}),
      reset: vi.fn(),
      size: vi.fn(() => 0),
      prune: vi.fn(),
      dispose: vi.fn(),
    };
    const close = createCloseMock();
    const harness = attachGatewayHarness({
      connId: "conn-auth-rate-limited",
      connectNonce: "nonce-auth-rate-limited",
      requestHost: "gateway.example.com:18789",
      remoteAddr: "203.0.113.51",
      resolvedAuth: {
        mode: "token",
        token: "test-token",
        allowTailscale: false,
      },
      rateLimiter,
      close,
    });

    harness.sendConnect("connect-auth-rate-limited", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        version: "dev",
        platform: "test",
        mode: "backend",
      },
      role: "operator",
      scopes: [],
      caps: [],
      auth: { token: "test-token" },
    });

    await waitForFast(() => {
      expect(close).toHaveBeenCalledWith(1008, expect.stringContaining("retry later"));
    });

    const response = harness.send.mock.calls.at(0)?.[0] as
      | { error?: Record<string, unknown> }
      | undefined;
    expect(response?.error).toMatchObject({
      code: ErrorCodes.INVALID_REQUEST,
      message: "unauthorized: too many failed authentication attempts (retry later)",
      retryable: true,
      details: {
        code: ConnectErrorDetailCodes.AUTH_RATE_LIMITED,
        authReason: "rate_limited",
      },
    });
    expect(response?.error?.retryAfterMs).toBeGreaterThan(0);
  });

  it("records credential and hello preparation phases during connect", async () => {
    const harness = attachGatewayHarness({
      connId: "conn-phases",
      connectNonce: "nonce-phases",
      resolvedAuth: {
        mode: "token",
        token: "gateway-token",
        allowTailscale: false,
      },
    });

    harness.sendConnect("connect-phases", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        version: "dev",
        platform: "test",
        mode: "backend",
      },
      role: "operator",
      scopes: [],
      caps: [],
      auth: {
        token: "gateway-token",
      },
    });

    await waitForFast(() => {
      expect(harness.socketSend).toHaveBeenCalled();
    });
    expect(harness.advanceHandshakePhase.mock.calls.map(([phase]) => phase)).toEqual([
      "auth_credentials_received",
      "auth_validated",
      "session_attached",
      "hello_payload_prepared",
      "ready",
    ]);
    expect(upsertPresenceMock).not.toHaveBeenCalled();
  });

  it("does not mark local backend self-pairing clients as approval runtimes", async () => {
    const refreshHealthSnapshot = vi.fn<GatewayRequestContext["refreshHealthSnapshot"]>(async () =>
      createHealthSummary(),
    );
    const harness = attachGatewayHarness({
      connId: "conn-approval-runtime-spoof",
      connectNonce: "nonce-approval-runtime-spoof",
      refreshHealthSnapshot,
    });

    harness.sendConnect("connect-approval-runtime-spoof", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        version: "dev",
        platform: "test",
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.approvals"],
      caps: [],
    });

    await waitForFast(() => {
      expect(harness.socketSend).toHaveBeenCalled();
    });
    const connectedClient = harness.client as {
      connect?: { scopes?: string[] };
      internal?: { approvalRuntime?: boolean };
    } | null;
    expect(connectedClient?.connect?.scopes).toEqual(["operator.approvals"]);
    expect(connectedClient?.internal?.approvalRuntime).not.toBe(true);
  });

  it("retains handshake-attested locality for direct operator admission", async () => {
    const refreshHealthSnapshot = vi.fn<GatewayRequestContext["refreshHealthSnapshot"]>(async () =>
      createHealthSummary(),
    );
    const harness = attachGatewayHarness({
      connId: "conn-local-operator-authority",
      connectNonce: "nonce-local-operator-authority",
      refreshHealthSnapshot,
    });

    harness.sendConnect("connect-local-operator-authority", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        version: "dev",
        platform: "test",
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.admin"],
      caps: [],
    });

    await waitForFast(() => {
      expect(harness.socketSend).toHaveBeenCalled();
    });
    const connectedClient = harness.client as {
      clientIp?: string;
      internal?: { isLocalClient?: true };
    } | null;
    expect(connectedClient?.clientIp).toBeUndefined();
    expect(connectedClient?.internal?.isLocalClient).toBe(true);

    const admission = resolveGatewayCronCreatorAuthorityAdmission({
      runId: "local-operator-run",
      resolvedSessionKey: "agent:main:main",
      client: harness.client as never,
      request: { message: "hello", idempotencyKey: "local-operator-run" },
      hasRestoredCronContinuation: false,
      isOneShotModelRun: false,
      isRestartRecoveryResumeRun: false,
    });
    expect(admission).toEqual({
      runId: "local-operator-run",
      callerOrigin: { kind: "local" },
    });
  });

  it("does not carry local operator authority for an authenticated remote client", async () => {
    const refreshHealthSnapshot = vi.fn<GatewayRequestContext["refreshHealthSnapshot"]>(async () =>
      createHealthSummary(),
    );
    const harness = attachGatewayHarness({
      connId: "conn-remote-operator-authority",
      connectNonce: "nonce-remote-operator-authority",
      requestHost: "gateway.example.com:18789",
      remoteAddr: "203.0.113.50",
      resolvedAuth: {
        mode: "token",
        token: "gateway-token",
        allowTailscale: false,
      },
      refreshHealthSnapshot,
    });

    harness.sendConnect("connect-remote-operator-authority", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        version: "dev",
        platform: "test",
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.admin"],
      caps: [],
      auth: { token: "gateway-token" },
    });

    await waitForFast(() => {
      expect(harness.socketSend).toHaveBeenCalled();
    });
    const connectedClient = harness.client as {
      clientIp?: string;
      internal?: { isLocalClient?: true };
    } | null;
    expect(connectedClient?.clientIp).toBe("203.0.113.50");
    expect(connectedClient?.internal?.isLocalClient).toBeUndefined();

    const admission = resolveGatewayCronCreatorAuthorityAdmission({
      runId: "remote-operator-run",
      resolvedSessionKey: "agent:main:main",
      client: harness.client as never,
      request: { message: "hello", idempotencyKey: "remote-operator-run" },
      hasRestoredCronContinuation: false,
      isOneShotModelRun: false,
      isRestartRecoveryResumeRun: false,
    });
    expect(admission).toBeUndefined();
  });

  it("marks operator approval clients with the server runtime token", async () => {
    const refreshHealthSnapshot = vi.fn<GatewayRequestContext["refreshHealthSnapshot"]>(async () =>
      createHealthSummary(),
    );
    const harness = attachGatewayHarness({
      connId: "conn-approval-runtime-token",
      connectNonce: "nonce-approval-runtime-token",
      refreshHealthSnapshot,
    });

    harness.sendConnect("connect-approval-runtime-token", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        version: "dev",
        platform: "test",
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.approvals"],
      caps: [],
      auth: {
        approvalRuntimeToken: getOperatorApprovalRuntimeToken(),
      },
    });

    await waitForFast(() => {
      expect(harness.socketSend).toHaveBeenCalled();
    });
    const connectedClient = harness.client as {
      internal?: { approvalRuntime?: boolean };
    } | null;
    expect(connectedClient?.internal?.approvalRuntime).toBe(true);
  });

  it("does not trust approval runtime tokens from remote clients", async () => {
    const refreshHealthSnapshot = vi.fn<GatewayRequestContext["refreshHealthSnapshot"]>(async () =>
      createHealthSummary(),
    );
    const harness = attachGatewayHarness({
      connId: "conn-remote-approval-runtime-token",
      connectNonce: "nonce-remote-approval-runtime-token",
      requestHost: "gateway.example.com:18789",
      remoteAddr: "203.0.113.50",
      resolvedAuth: {
        mode: "token",
        token: "gateway-token",
        allowTailscale: false,
      },
      refreshHealthSnapshot,
    });

    harness.sendConnect("connect-remote-approval-runtime-token", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        version: "dev",
        platform: "test",
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.approvals"],
      caps: [],
      auth: {
        token: "gateway-token",
        approvalRuntimeToken: getOperatorApprovalRuntimeToken(),
      },
    });

    await waitForFast(() => {
      expect(harness.socketSend).toHaveBeenCalled();
    });
    const connectedClient = harness.client as {
      internal?: { approvalRuntime?: boolean };
    } | null;
    expect(connectedClient?.internal?.approvalRuntime).not.toBe(true);
  });

  it("marks local backend clients with a valid agent runtime identity token", async () => {
    const refreshHealthSnapshot = vi.fn<GatewayRequestContext["refreshHealthSnapshot"]>(async () =>
      createHealthSummary(),
    );
    const harness = attachGatewayHarness({
      connId: "conn-agent-runtime-token",
      connectNonce: "nonce-agent-runtime-token",
      refreshHealthSnapshot,
    });

    const identityLease = await createTestAgentRuntimeIdentityLease();
    harness.sendConnect("connect-agent-runtime-token", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        version: "dev",
        platform: "test",
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.write"],
      caps: [],
      auth: {
        agentRuntimeIdentityToken: identityLease.token,
      },
    });

    await waitForFast(() => {
      expect(harness.socketSend).toHaveBeenCalled();
    });
    const connectedClient = harness.client as {
      internal?: {
        agentRuntimeIdentity?: { agentId?: string; sessionKey?: string };
      };
    } | null;
    expect(connectedClient?.internal?.agentRuntimeIdentity).toMatchObject({
      agentId: "ops",
      sessionKey: "agent:ops:telegram:direct:alice",
    });
    identityLease.close();
  });

  it("rejects agent runtime identity tokens from remote clients", async () => {
    const refreshHealthSnapshot = vi.fn<GatewayRequestContext["refreshHealthSnapshot"]>(async () =>
      createHealthSummary(),
    );
    const close = createCloseMock();
    const harness = attachGatewayHarness({
      connId: "conn-remote-agent-runtime-token",
      connectNonce: "nonce-remote-agent-runtime-token",
      requestHost: "gateway.example.com:18789",
      remoteAddr: "203.0.113.50",
      resolvedAuth: {
        mode: "token",
        token: "gateway-token",
        allowTailscale: false,
      },
      refreshHealthSnapshot,
      close,
    });

    const identityLease = await createTestAgentRuntimeIdentityLease();
    harness.sendConnect("connect-remote-agent-runtime-token", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        version: "dev",
        platform: "test",
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.write"],
      caps: [],
      auth: {
        token: "gateway-token",
        agentRuntimeIdentityToken: identityLease.token,
      },
    });

    await waitForFast(() => {
      expect(close).toHaveBeenCalledWith(
        1008,
        "agent runtime identity token is only accepted from local backend gateway clients",
      );
    });
    expect(harness.client).toBeNull();
    identityLease.close();
  });

  it("rejects invalid local agent runtime identity tokens", async () => {
    const refreshHealthSnapshot = vi.fn<GatewayRequestContext["refreshHealthSnapshot"]>(async () =>
      createHealthSummary(),
    );
    const close = createCloseMock();
    const harness = attachGatewayHarness({
      connId: "conn-invalid-agent-runtime-token",
      connectNonce: "nonce-invalid-agent-runtime-token",
      refreshHealthSnapshot,
      close,
    });

    harness.sendConnect("connect-invalid-agent-runtime-token", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        version: "dev",
        platform: "test",
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.write"],
      caps: [],
      auth: {
        agentRuntimeIdentityToken: "not-a-valid-token",
      },
    });

    await waitForFast(() => {
      expect(close).toHaveBeenCalledWith(1008, "invalid agent runtime identity token");
    });
    expect(harness.client).toBeNull();
  });
});

describe("resolvePinnedClientMetadata", () => {
  it.each([
    ["darwin", "macos"],
    ["win32", "windows"],
  ])(
    "pins legacy node-host platform alias %s to paired canonical %s",
    (claimedPlatform, pairedPlatform) => {
      expect(
        resolvePinnedClientMetadata({
          clientId: "node-host",
          clientMode: "node",
          claimedPlatform,
          claimedDeviceFamily: pairedPlatform === "macos" ? "Mac" : "Windows",
          pairedPlatform,
          pairedDeviceFamily: pairedPlatform === "macos" ? "Mac" : "Windows",
        }),
      ).toEqual({
        platformMismatch: false,
        deviceFamilyMismatch: false,
        pinnedPlatform: pairedPlatform,
        pinnedDeviceFamily: pairedPlatform === "macos" ? "Mac" : "Windows",
      });
    },
  );

  it.each([
    ["darwin", "macos", "Mac"],
    ["win32", "windows", "Windows"],
  ])(
    "normalizes exact legacy node-host platform %s to canonical %s",
    (legacyPlatform, canonicalPlatform, deviceFamily) => {
      expect(
        resolvePinnedClientMetadata({
          clientId: "node-host",
          clientMode: "node",
          claimedPlatform: legacyPlatform,
          claimedDeviceFamily: deviceFamily,
          pairedPlatform: legacyPlatform,
          pairedDeviceFamily: deviceFamily,
        }),
      ).toEqual({
        platformMismatch: false,
        deviceFamilyMismatch: false,
        pinnedPlatform: canonicalPlatform,
        pinnedDeviceFamily: deviceFamily,
      });
    },
  );

  it.each([
    ["macos", "darwin", "Mac"],
    ["windows", "win32", "Windows"],
  ])(
    "pins canonical node-host platform %s over paired legacy alias %s",
    (claimedPlatform, pairedPlatform, deviceFamily) => {
      expect(
        resolvePinnedClientMetadata({
          clientId: "node-host",
          clientMode: "node",
          claimedPlatform,
          claimedDeviceFamily: deviceFamily,
          pairedPlatform,
          pairedDeviceFamily: deviceFamily,
        }),
      ).toEqual({
        platformMismatch: false,
        deviceFamilyMismatch: false,
        pinnedPlatform: claimedPlatform,
        pinnedDeviceFamily: deviceFamily,
      });
    },
  );

  it.each([
    ["openclaw-ios", "iOS 26.5.0", "iOS 26.4.2", "iPhone"],
    ["openclaw-ios", "iPadOS 26.5.0", "iPadOS 26.4.2", "iPad"],
    ["openclaw-ios", "iPadOS 26.5.0", "iOS 26.4.2", "iPad"],
    ["openclaw-android", "Android 16", "Android 15", "Android"],
    ["openclaw-macos", "macOS 26.5.1", "macOS 26.5.0", "Mac"],
    ["openclaw-macos", "macOS 27.0.0", "macOS 26.5.1", "Mac"],
  ])(
    "allows %s platform version refresh without metadata-upgrade approval",
    (clientId, claimedPlatform, pairedPlatform, deviceFamily) => {
      expect(
        resolvePinnedClientMetadata({
          clientId,
          clientMode: "node",
          claimedPlatform,
          claimedDeviceFamily: deviceFamily,
          pairedPlatform,
          pairedDeviceFamily: deviceFamily,
        }),
      ).toEqual({
        platformMismatch: false,
        deviceFamilyMismatch: false,
        pinnedPlatform: claimedPlatform,
        pinnedDeviceFamily: deviceFamily,
        refreshPairedPlatform: claimedPlatform,
      });
    },
  );

  it.each(["node", "ui"])("allows a macOS platform version refresh in %s mode", (clientMode) => {
    expect(
      resolvePinnedClientMetadata({
        clientId: "openclaw-macos",
        clientMode,
        claimedPlatform: "macOS 26.5.2",
        claimedDeviceFamily: "Mac",
        pairedPlatform: "macOS 26.5.1",
        pairedDeviceFamily: "Mac",
      }),
    ).toEqual({
      platformMismatch: false,
      deviceFamilyMismatch: false,
      pinnedPlatform: "macOS 26.5.2",
      pinnedDeviceFamily: "Mac",
      refreshPairedPlatform: "macOS 26.5.2",
    });
  });

  it("accepts a node-host macOS alias against the shared Mac app platform pin", () => {
    expect(
      resolvePinnedClientMetadata({
        clientId: "node-host",
        clientMode: "node",
        claimedPlatform: "macos",
        claimedDeviceFamily: "Mac",
        pairedPlatform: "macOS 26.5.2",
        pairedDeviceFamily: "Mac",
      }),
    ).toEqual({
      platformMismatch: false,
      deviceFamilyMismatch: false,
      pinnedPlatform: "macOS 26.5.2",
      pinnedDeviceFamily: "Mac",
    });
  });

  it("refreshes a shared node-host macOS pin from the native Mac app", () => {
    expect(
      resolvePinnedClientMetadata({
        clientId: "openclaw-macos",
        clientMode: "ui",
        claimedPlatform: "macOS 26.5.2",
        claimedDeviceFamily: "Mac",
        pairedPlatform: "macos",
        pairedDeviceFamily: "Mac",
      }),
    ).toEqual({
      platformMismatch: false,
      deviceFamilyMismatch: false,
      pinnedPlatform: "macOS 26.5.2",
      pinnedDeviceFamily: "Mac",
      refreshPairedPlatform: "macOS 26.5.2",
    });
  });

  it("still requires approval when an iOS device family changes", () => {
    expect(
      resolvePinnedClientMetadata({
        clientId: "openclaw-ios",
        clientMode: "node",
        claimedPlatform: "iOS 26.5.0",
        claimedDeviceFamily: "iPad",
        pairedPlatform: "iOS 26.4.2",
        pairedDeviceFamily: "iPhone",
      }),
    ).toEqual({
      platformMismatch: false,
      deviceFamilyMismatch: true,
      pinnedPlatform: "iOS 26.5.0",
      pinnedDeviceFamily: "iPhone",
      refreshPairedPlatform: "iOS 26.5.0",
    });
  });

  it("still requires approval when a macOS device family changes", () => {
    expect(
      resolvePinnedClientMetadata({
        clientId: "openclaw-macos",
        clientMode: "node",
        claimedPlatform: "macOS 26.5.2",
        claimedDeviceFamily: "VirtualMac",
        pairedPlatform: "macOS 26.5.1",
        pairedDeviceFamily: "Mac",
      }),
    ).toEqual({
      platformMismatch: false,
      deviceFamilyMismatch: true,
      pinnedPlatform: "macOS 26.5.2",
      pinnedDeviceFamily: "Mac",
      refreshPairedPlatform: "macOS 26.5.2",
    });
  });

  it.each([
    ["node-host", "macOS 26.5.2", "macOS 26.5.1"],
    ["openclaw-macos", "macOS anything", "macOS previous"],
    ["openclaw-macos", "macOS", "macOS 26.5.1"],
  ])(
    "keeps non-version macOS platform changes approval-bound for %s",
    (clientId, claimed, paired) => {
      expect(
        resolvePinnedClientMetadata({
          clientId,
          clientMode: "node",
          claimedPlatform: claimed,
          claimedDeviceFamily: "Mac",
          pairedPlatform: paired,
          pairedDeviceFamily: "Mac",
        }),
      ).toMatchObject({
        platformMismatch: true,
        deviceFamilyMismatch: false,
        pinnedPlatform: undefined,
      });
    },
  );

  it("keeps non-native-app platform version changes approval-bound", () => {
    expect(
      resolvePinnedClientMetadata({
        clientId: "node-host",
        clientMode: "node",
        claimedPlatform: "linux 6.9",
        claimedDeviceFamily: "Linux",
        pairedPlatform: "linux 6.8",
        pairedDeviceFamily: "Linux",
      }),
    ).toEqual({
      platformMismatch: true,
      deviceFamilyMismatch: false,
      pinnedPlatform: undefined,
      pinnedDeviceFamily: "Linux",
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

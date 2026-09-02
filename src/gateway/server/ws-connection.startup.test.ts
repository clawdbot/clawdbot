/**
 * WebSocket connection startup regression tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/index.js";
import {
  GATEWAY_STARTUP_CLOSE_CODE,
  GATEWAY_STARTUP_CLOSE_REASON,
  GATEWAY_STARTUP_PENDING_CLOSE_CAUSE,
  GATEWAY_STARTUP_UNAVAILABLE_REASON,
} from "../../../packages/gateway-protocol/src/startup-unavailable.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  consumeDeviceBootstrapTokenWithSetupCompletion,
  ensureDevicePairSetupBootstrapToken,
  issueDevicePairSetupBootstrapToken,
  readDevicePairSetupCompletion,
  verifyDeviceBootstrapToken,
} from "../../infra/device-bootstrap.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../../infra/device-identity.js";
import { approveDevicePairing } from "../../infra/device-pairing-approval.js";
import { approveNodePairing, requestNodePairing } from "../../infra/device-pairing-node.js";
import { requestDevicePairing } from "../../infra/device-pairing.js";
import { createSafeGatewayRestartPreflight } from "../../infra/restart-coordinator.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import {
  CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
} from "../../shared/device-bootstrap-profile.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  AUTH_RATE_LIMIT_SCOPE_BOOTSTRAP_TOKEN,
  createAuthRateLimiter,
} from "../auth-rate-limit.js";
import * as gatewayAuth from "../auth.js";
import { buildDeviceAuthPayload } from "../device-auth.js";
import { createWorkerEnvironmentStore } from "../worker-environments/store.js";
import { attachGatewayWsConnectionHandler } from "./ws-connection.js";
import {
  attachGatewayWsForTest,
  createGatewayWsTestLogger,
  createGatewayWsTestRequestContext,
  createGatewayWsTestSocket,
} from "./ws-connection.test-helpers.js";

type StartupConnectResponse = {
  type?: unknown;
  id?: unknown;
  ok?: unknown;
  error?: { code?: unknown; retryable?: unknown; details?: unknown };
};

afterEach(() => {
  resetGatewayWorkAdmission();
  closeOpenClawStateDatabaseForTest();
});

async function attachStartupNodeConnect(params: {
  bootstrapToken?: string;
  sharedToken?: string;
  gatewayToken?: string;
  identityPath: string;
  isPendingWorkerNodeSetup: (setupId: string, deviceId: string) => boolean;
  rateLimiter?: ReturnType<typeof createAuthRateLimiter>;
  onNodeRegistered?: () => void;
}) {
  const sent: unknown[] = [];
  const connectResponse = createDeferred<StartupConnectResponse>();
  const clients = new Set<unknown>();
  const socket = createGatewayWsTestSocket({
    onSend: (data) => {
      const frame = JSON.parse(data) as StartupConnectResponse;
      sent.push(frame);
      if (frame.id === "startup-node-connect") {
        connectResponse.resolve(frame);
      }
    },
  });
  let registeredNode:
    | {
        nodeId: string;
        connId: string;
        displayName: string;
        platform: string;
        commands: string[];
        connectedAtMs: number;
        pairingGeneration?: string;
      }
    | undefined;
  const nodeRegistry = {
    register: vi.fn(
      (client: { connId: string; connect: { device?: { id?: string } } }, options) => {
        params.onNodeRegistered?.();
        registeredNode = {
          nodeId: client.connect.device?.id ?? "node-host",
          connId: client.connId,
          displayName: "Cloud worker",
          platform: "linux",
          commands: [],
          connectedAtMs: Date.now(),
          ...(options.pairingGeneration
            ? { pairingGeneration: String(options.pairingGeneration) }
            : {}),
        };
        return registeredNode;
      },
    ),
    get: vi.fn(() => undefined),
    getForPairingGeneration: vi.fn(() => undefined),
    unregister: vi.fn(() => registeredNode?.nodeId ?? null),
    sendEventRawForPairingGeneration: vi.fn(async () => {}),
    sendEventForPairingIdentity: vi.fn(async () => {}),
  };
  const requestContext = {
    ...createGatewayWsTestRequestContext(),
    nodeRegistry,
  };
  const pendingSetup = vi.fn(params.isPendingWorkerNodeSetup);
  attachGatewayWsForTest({
    attach: attachGatewayWsConnectionHandler,
    clients,
    socket,
    options: {
      getResolvedAuth: () =>
        params.sharedToken
          ? {
              mode: "token",
              token: params.gatewayToken ?? params.sharedToken,
              allowTailscale: false,
            }
          : { mode: "none", allowTailscale: false },
      isStartupPending: () => true,
      isPendingWorkerNodeSetup: pendingSetup,
      rateLimiter: params.rateLimiter,
      buildRequestContext: () => requestContext as never,
    },
  });
  const challenge = sent.find(
    (frame) =>
      typeof frame === "object" &&
      frame !== null &&
      (frame as { event?: unknown }).event === "connect.challenge",
  ) as { payload?: { nonce?: unknown } } | undefined;
  const nonce = challenge?.payload?.nonce;
  if (typeof nonce !== "string") {
    throw new Error("startup node connect challenge was not sent");
  }
  const identity = loadOrCreateDeviceIdentity({ path: params.identityPath });
  const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
  const signedAt = Date.now();
  const devicePayload = buildDeviceAuthPayload({
    deviceId: identity.deviceId,
    clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
    role: "node",
    scopes: [],
    signedAtMs: signedAt,
    token: params.sharedToken ?? params.bootstrapToken,
    nonce,
  });
  markGatewayRestartDraining();
  socket.emit(
    "message",
    JSON.stringify({
      type: "req",
      id: "startup-node-connect",
      method: "connect",
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: GATEWAY_CLIENT_NAMES.NODE_HOST,
          version: "dev",
          platform: "linux",
          mode: GATEWAY_CLIENT_MODES.NODE,
        },
        role: "node",
        scopes: [],
        caps: [],
        commands: [],
        auth: {
          ...(params.bootstrapToken ? { bootstrapToken: params.bootstrapToken } : {}),
          ...(params.sharedToken ? { token: params.sharedToken } : {}),
        },
        device: {
          id: identity.deviceId,
          publicKey,
          signature: signDevicePayload(identity.privateKeyPem, devicePayload),
          signedAt,
          nonce,
        },
      },
    }),
  );
  const response = async () => {
    await vi.waitFor(() => {
      expect(
        sent.some(
          (frame) =>
            typeof frame === "object" &&
            frame !== null &&
            (frame as StartupConnectResponse).id === "startup-node-connect",
        ),
      ).toBe(true);
    });
    return sent.find(
      (frame) =>
        typeof frame === "object" &&
        frame !== null &&
        (frame as StartupConnectResponse).id === "startup-node-connect",
    ) as StartupConnectResponse;
  };
  return {
    clients,
    identity,
    nodeRegistry,
    pendingSetup,
    response,
    responseReceived: connectResponse.promise,
    sent,
    socket,
  };
}

function seedProvisioningNodeSetup() {
  const store = createWorkerEnvironmentStore();
  const intent = store.createIntent({
    environmentId: "startup-worker-environment",
    providerId: "startup-provider",
    profileId: "startup-profile",
    profileSnapshot: { settings: {} },
    provisionOperationId: "provision:startup-worker-environment",
  });
  store.transition({
    environmentId: intent.environmentId,
    from: intent.state,
    to: "provisioning",
  });
  const setupId = store.ensureNodeEnrollment(intent.environmentId).nodeSetupId;
  if (!setupId) {
    throw new Error("startup worker setup id was not persisted");
  }
  return { store, setupId };
}

describe("attachGatewayWsConnectionHandler startup readiness", () => {
  it("admits only one of two connect frames that race during lazy handler loading", async () => {
    const sent: unknown[] = [];
    const clients = new Set<unknown>();
    const socket = createGatewayWsTestSocket({
      onSend: (data) => {
        sent.push(JSON.parse(data));
      },
    });

    attachGatewayWsForTest({
      attach: attachGatewayWsConnectionHandler,
      clients,
      socket,
      options: {
        getResolvedAuth: () => ({ mode: "token", allowTailscale: false, token: "test-token" }),
        buildRequestContext: () => createGatewayWsTestRequestContext() as never,
      },
    });
    const connectFrame = (id: string) =>
      JSON.stringify({
        type: "req",
        id,
        method: "connect",
        params: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: "gateway-client",
            version: "dev",
            platform: "test",
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          },
          role: "operator",
          scopes: [],
          caps: [],
          auth: { token: "test-token" },
        },
      });

    socket.emit("message", connectFrame("connect-1"));
    socket.emit("message", connectFrame("connect-2"));
    await vi.dynamicImportSettled();

    await vi.waitFor(() => {
      expect(clients.size).toBe(1);
      expect(
        sent.filter(
          (frame) =>
            typeof frame === "object" &&
            frame !== null &&
            (frame as { type?: unknown; ok?: unknown }).type === "res" &&
            (frame as { ok?: unknown }).ok === true,
        ),
      ).toHaveLength(1);
    });

    socket.emit("close", 1000, Buffer.from("done"));
    expect(clients.size).toBe(0);
  });

  it.each([GATEWAY_STARTUP_CLOSE_CODE, 1006])(
    "keeps startup-unavailable close code %i at debug level",
    async (observedCloseCode) => {
      const responseReceived = createDeferred<{
        type?: unknown;
        id?: unknown;
        ok?: unknown;
        error?: {
          code?: unknown;
          retryable?: unknown;
          retryAfterMs?: unknown;
          details?: unknown;
        };
      }>();
      const socket = createGatewayWsTestSocket({
        onSend: (data) => {
          const frame = JSON.parse(data) as unknown;
          if (
            typeof frame === "object" &&
            frame !== null &&
            (frame as { type?: unknown }).type === "res" &&
            (frame as { id?: unknown }).id === "connect-1"
          ) {
            responseReceived.resolve(frame);
          }
        },
      });
      const logWsControl = createGatewayWsTestLogger();

      attachGatewayWsForTest({
        attach: attachGatewayWsConnectionHandler,
        socket,
        options: {
          getResolvedAuth: () => ({ mode: "none", allowTailscale: false }),
          isStartupPending: () => true,
          logWsControl: logWsControl as never,
          buildRequestContext: () => createGatewayWsTestRequestContext() as never,
        },
      });
      socket.emit(
        "message",
        JSON.stringify({
          type: "req",
          id: "connect-1",
          method: "connect",
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: GATEWAY_CLIENT_NAMES.CLI,
              version: "dev",
              platform: "test",
              mode: GATEWAY_CLIENT_MODES.CLI,
            },
            role: "operator",
            scopes: ["operator.read"],
            caps: [],
          },
        }),
      );

      // The handler is lazy-loaded; wait for its actual frame instead of a one-second poll.
      const response = await responseReceived.promise;
      expect(response?.type).toBe("res");
      expect(response?.id).toBe("connect-1");
      expect(response?.ok).toBe(false);
      expect(response?.error?.code).toBe("UNAVAILABLE");
      expect(response?.error?.retryable).toBe(true);
      expect(response?.error?.retryAfterMs).toBe(500);
      expect(response?.error?.details).toEqual({ reason: GATEWAY_STARTUP_UNAVAILABLE_REASON });
      await vi.waitFor(() => {
        expect(socket.close).toHaveBeenCalledWith(
          GATEWAY_STARTUP_CLOSE_CODE,
          GATEWAY_STARTUP_CLOSE_REASON,
        );
      });
      socket.emit("close", observedCloseCode, Buffer.alloc(0));
      expect(logWsControl.debug).toHaveBeenCalledWith(
        expect.stringContaining("closed before connect"),
        expect.objectContaining({
          cause: GATEWAY_STARTUP_PENDING_CLOSE_CAUSE,
          handshake: "failed",
        }),
      );
      expect(logWsControl.debug).toHaveBeenCalledWith(
        expect.stringContaining(`code=${observedCloseCode}`),
        expect.anything(),
      );
      expect(logWsControl.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("closed before connect"),
        expect.anything(),
      );
    },
  );

  it("admits the exact cloud-worker setup node through restart startup", async () => {
    await withOpenClawTestState(
      { label: "gateway-startup-cloud-worker", layout: "state-only" },
      async (state) => {
        const { store, setupId } = seedProvisioningNodeSetup();
        const issued = await ensureDevicePairSetupBootstrapToken({
          setupId,
          profile: CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE,
        });
        if (issued.status !== "pending") {
          throw new Error("expected pending cloud-worker setup token");
        }
        const harness = await attachStartupNodeConnect({
          bootstrapToken: issued.token,
          identityPath: state.path("startup-node.sqlite"),
          isPendingWorkerNodeSetup: (candidateSetupId, deviceId) =>
            store.hasPendingNodeEnrollmentSetup(candidateSetupId, deviceId),
        });

        await expect(harness.response()).resolves.toMatchObject({
          ok: true,
          payload: { type: "hello-ok", auth: { role: "node", scopes: [] } },
        });
        expect(harness.clients.size).toBe(1);
        expect(harness.nodeRegistry.register).toHaveBeenCalledOnce();
        expect(harness.pendingSetup).toHaveBeenCalledWith(setupId, harness.identity.deviceId);
        expect(store.get("startup-worker-environment")).toMatchObject({
          state: "provisioning",
          nodeSetupId: setupId,
          nodeDeviceId: harness.identity.deviceId,
          destroyRequestedAtMs: null,
        });
        expect(store.hasPendingNodeEnrollmentSetup(setupId, harness.identity.deviceId)).toBe(true);
        harness.socket.emit("close", 1000, Buffer.from("done"));
      },
    );
  });

  it.each([
    ["provisioning", false],
    ["bootstrapping", false],
    ["ready", false],
    ["idle", false],
    ["attached", false],
    ["provisioning", true],
  ] as const)(
    "admits same-device uncertain startup setup retry in %s unless destroy was requested (%s)",
    async (environmentState, destroyRequested) => {
      await withOpenClawTestState(
        { label: "gateway-startup-cloud-worker-uncertain-retry", layout: "state-only" },
        async (state) => {
          const { store, setupId } = seedProvisioningNodeSetup();
          const issued = await ensureDevicePairSetupBootstrapToken({
            setupId,
            profile: CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE,
          });
          if (issued.status !== "pending") {
            throw new Error("expected pending cloud-worker setup token");
          }
          const identityPath = state.path("startup-retrying-node.sqlite");
          const identity = loadOrCreateDeviceIdentity({ path: identityPath });
          const verification = {
            token: issued.token,
            deviceId: identity.deviceId,
            publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
            role: "node",
            scopes: [],
          };
          await expect(verifyDeviceBootstrapToken(verification)).resolves.toEqual({ ok: true });
          await expect(
            consumeDeviceBootstrapTokenWithSetupCompletion({
              token: issued.token,
              deviceId: identity.deviceId,
              completedAtMs: Date.now(),
            }),
          ).resolves.toMatchObject({ completion: { deliveryState: "uncertain" } });
          if (environmentState !== "provisioning") {
            openOpenClawStateDatabase()
              .db.prepare(
                "UPDATE worker_environments SET state = ?, lease_id = ? WHERE node_setup_id = ?",
              )
              .run(environmentState, "startup-worker-lease", setupId);
          }
          if (destroyRequested) {
            store.requestDestroy({
              environmentId: "startup-worker-environment",
              state: "provisioning",
            });
          }

          const harness = await attachStartupNodeConnect({
            bootstrapToken: issued.token,
            identityPath,
            isPendingWorkerNodeSetup: (candidateSetupId, deviceId) =>
              store.hasPendingNodeEnrollmentSetup(candidateSetupId, deviceId),
          });

          const response = await harness.response();
          expect(harness.pendingSetup).toHaveBeenCalledWith(setupId, identity.deviceId);
          if (destroyRequested) {
            expect(response).toMatchObject({
              ok: false,
              error: {
                code: "UNAVAILABLE",
                details: { reason: GATEWAY_STARTUP_UNAVAILABLE_REASON },
              },
            });
            expect(harness.nodeRegistry.register).not.toHaveBeenCalled();
            harness.socket.emit("close", GATEWAY_STARTUP_CLOSE_CODE, Buffer.alloc(0));
            return;
          }
          expect(response).toMatchObject({
            ok: true,
            payload: { type: "hello-ok", auth: { role: "node", scopes: [] } },
          });
          await expect(readDevicePairSetupCompletion({ setupId })).resolves.toMatchObject({
            deviceId: identity.deviceId,
            deliveryState: "confirmed",
          });
          await expect(verifyDeviceBootstrapToken(verification)).resolves.toEqual({
            ok: false,
            reason: "bootstrap_token_invalid",
          });
          harness.socket.emit("close", 1000, Buffer.from("done"));
        },
      );
    },
  );

  it.each(["cloud bootstrap", "paired shared-token"] as const)(
    "keeps restart-startup %s authentication tracked until its node mutation and handshake settle",
    async (connectionKind) => {
      await withOpenClawTestState(
        { label: "gateway-startup-cloud-worker-drain-race", layout: "state-only" },
        async (state) => {
          const { store, setupId } = seedProvisioningNodeSetup();
          const issued = await ensureDevicePairSetupBootstrapToken({
            setupId,
            profile: CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE,
          });
          if (issued.status !== "pending") {
            throw new Error("expected pending cloud-worker setup token");
          }
          const identityPath = state.path("startup-drain-race-node.sqlite");
          if (connectionKind === "paired shared-token") {
            const identity = loadOrCreateDeviceIdentity({ path: identityPath });
            const devicePairing = await requestDevicePairing({
              deviceId: identity.deviceId,
              publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
              role: "node",
              roles: ["node"],
              scopes: [],
            });
            await approveDevicePairing(devicePairing.request.requestId, { callerScopes: [] });
            const nodePairing = await requestNodePairing({
              nodeId: identity.deviceId,
              platform: "linux",
              caps: [],
            });
            await approveNodePairing(nodePairing.request.requestId, {
              callerScopes: ["operator.pairing"],
            });
          }
          const authenticationStarted = createDeferred();
          const releaseAuthentication = createDeferred();
          const registeredRootCounts: number[] = [];
          const authorize = gatewayAuth.authorizeWsControlUiGatewayConnect;
          const authentication = vi
            .spyOn(gatewayAuth, "authorizeWsControlUiGatewayConnect")
            .mockImplementationOnce(async (params) => {
              authenticationStarted.resolve();
              await releaseAuthentication.promise;
              expect(getActiveGatewayRootWorkCount()).toBe(1);
              return await authorize(params);
            });
          try {
            const harness = await attachStartupNodeConnect({
              ...(connectionKind === "cloud bootstrap"
                ? { bootstrapToken: issued.token }
                : { sharedToken: "startup-shared-token" }),
              identityPath,
              isPendingWorkerNodeSetup: (candidateSetupId, deviceId) =>
                store.hasPendingNodeEnrollmentSetup(candidateSetupId, deviceId),
              onNodeRegistered: () => registeredRootCounts.push(getActiveGatewayRootWorkCount()),
            });

            await authenticationStarted.promise;
            expect(getActiveGatewayRootWorkCount()).toBe(1);
            expect(createSafeGatewayRestartPreflight()).toMatchObject({
              safe: false,
              counts: { rootRequests: 1 },
            });
            expect(harness.nodeRegistry.register).not.toHaveBeenCalled();

            releaseAuthentication.resolve();
            await expect(harness.responseReceived).resolves.toMatchObject({ ok: true });
            expect(registeredRootCounts).toEqual([1]);
            if (connectionKind === "paired shared-token") {
              expect(harness.pendingSetup).not.toHaveBeenCalled();
            }
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            expect(getActiveGatewayRootWorkCount()).toBe(0);
            expect(createSafeGatewayRestartPreflight()).toMatchObject({
              safe: true,
              counts: { rootRequests: 0 },
            });
            harness.socket.emit("close", 1000, Buffer.from("done"));
          } finally {
            releaseAuthentication.resolve();
            authentication.mockRestore();
          }
        },
      );
    },
  );

  it("keeps non-cloud and wrong cloud setup tokens startup-unavailable", async () => {
    await withOpenClawTestState(
      { label: "gateway-startup-cloud-worker-reject", layout: "state-only" },
      async (state) => {
        const { store, setupId } = seedProvisioningNodeSetup();
        const nonCloud = await ensureDevicePairSetupBootstrapToken({
          setupId,
          profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
        });
        if (nonCloud.status !== "pending") {
          throw new Error("expected pending node setup token");
        }
        const nonCloudHarness = await attachStartupNodeConnect({
          bootstrapToken: nonCloud.token,
          identityPath: state.path("non-cloud-node.sqlite"),
          isPendingWorkerNodeSetup: (candidateSetupId, deviceId) =>
            store.hasPendingNodeEnrollmentSetup(candidateSetupId, deviceId),
        });

        await expect(nonCloudHarness.response()).resolves.toMatchObject({
          ok: false,
          error: {
            code: "UNAVAILABLE",
            retryable: true,
            details: { reason: GATEWAY_STARTUP_UNAVAILABLE_REASON },
          },
        });
        expect(nonCloudHarness.pendingSetup).not.toHaveBeenCalled();
        expect(nonCloudHarness.nodeRegistry.register).not.toHaveBeenCalled();
        nonCloudHarness.socket.emit("close", GATEWAY_STARTUP_CLOSE_CODE, Buffer.alloc(0));

        resetGatewayWorkAdmission();
        const wrongSetup = await issueDevicePairSetupBootstrapToken({
          profile: CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE,
        });
        const wrongSetupHarness = await attachStartupNodeConnect({
          bootstrapToken: wrongSetup.token,
          identityPath: state.path("wrong-setup-node.sqlite"),
          isPendingWorkerNodeSetup: (candidateSetupId, deviceId) =>
            store.hasPendingNodeEnrollmentSetup(candidateSetupId, deviceId),
        });

        await expect(wrongSetupHarness.response()).resolves.toMatchObject({
          ok: false,
          error: {
            code: "UNAVAILABLE",
            retryable: true,
            details: { reason: GATEWAY_STARTUP_UNAVAILABLE_REASON },
          },
        });
        expect(wrongSetupHarness.pendingSetup).toHaveBeenCalledWith(
          wrongSetup.setupId,
          wrongSetupHarness.identity.deviceId,
        );
        expect(wrongSetupHarness.nodeRegistry.register).not.toHaveBeenCalled();
        wrongSetupHarness.socket.emit("close", GATEWAY_STARTUP_CLOSE_CODE, Buffer.alloc(0));
      },
    );
  });

  it.each(["exact bootstrap", "mixed bootstrap and shared token"] as const)(
    "keeps an invalid %s opaque and rate-limited without consulting setup state",
    async (credentialShape) => {
      await withOpenClawTestState(
        { label: "gateway-startup-cloud-worker-invalid", layout: "state-only" },
        async (state) => {
          const { store } = seedProvisioningNodeSetup();
          const rateLimiter = createAuthRateLimiter({
            maxAttempts: 1,
            windowMs: 60_000,
            lockoutMs: 60_000,
            exemptLoopback: false,
          });
          try {
            const harness = await attachStartupNodeConnect({
              bootstrapToken: "invalid-startup-token",
              ...(credentialShape === "mixed bootstrap and shared token"
                ? { sharedToken: "invalid-shared-token", gatewayToken: "expected-shared-token" }
                : {}),
              identityPath: state.path("invalid-token-node.sqlite"),
              isPendingWorkerNodeSetup: (candidateSetupId, deviceId) =>
                store.hasPendingNodeEnrollmentSetup(candidateSetupId, deviceId),
              rateLimiter,
            });

            await expect(harness.response()).resolves.toMatchObject({
              ok: false,
              error: {
                code: "UNAVAILABLE",
                retryable: true,
                details: { reason: GATEWAY_STARTUP_UNAVAILABLE_REASON },
              },
            });
            expect(harness.pendingSetup).not.toHaveBeenCalled();
            expect(harness.nodeRegistry.register).not.toHaveBeenCalled();
            expect(
              rateLimiter.check("127.0.0.1", AUTH_RATE_LIMIT_SCOPE_BOOTSTRAP_TOKEN).allowed,
            ).toBe(false);
            harness.socket.emit("close", GATEWAY_STARTUP_CLOSE_CODE, Buffer.alloc(0));
          } finally {
            rateLimiter.dispose();
          }
        },
      );
    },
  );
});

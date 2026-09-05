import { request as httpRequest, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION, type ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  issueDeviceBootstrapToken,
  issueDevicePairSetupBootstrapToken,
  verifyDeviceBootstrapToken,
} from "../infra/device-bootstrap.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import {
  approveBootstrapDevicePairing,
  approveDevicePairing,
} from "../infra/device-pairing-approval.js";
import { listNodePairing } from "../infra/device-pairing-node.js";
import { withDevicePairingLock } from "../infra/device-pairing-state.js";
import { loadDevicePairSetupCompletionRecord } from "../infra/device-pairing-store.js";
import { revokeDeviceToken, verifyDeviceToken } from "../infra/device-pairing-tokens.js";
import { getPairedDevice, requestDevicePairing } from "../infra/device-pairing.js";
import {
  FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  type DeviceBootstrapProfile,
} from "../shared/device-bootstrap-profile.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { createAuthRateLimiter } from "./auth-rate-limit.js";
import { serializeEventPayload } from "./node-registry.js";
import {
  connectWatchNode,
  makeConnectParams,
  readJson,
  startPartialJsonRequest,
  startWatchNodeHttpRuntime,
  waitForLastConnectedMetadata,
} from "./watch-node-http.test-helpers.js";

const tempDirs = createTrackedTempDirs();
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  await tempDirs.cleanup();
});

async function createWatchNodeFixture(
  prefix: string,
  options?: Parameters<typeof startWatchNodeHttpRuntime>[2] & {
    bootstrapProfile?: DeviceBootstrapProfile;
  },
) {
  const baseDir = await tempDirs.make(prefix);
  const identity = loadOrCreateDeviceIdentity({
    path: path.join(baseDir, "watch-identity.sqlite"),
  });
  const issued = await issueDevicePairSetupBootstrapToken({
    baseDir,
    profile: options?.bootstrapProfile ?? NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  });
  return {
    baseDir,
    identity,
    issued,
    ...(await startWatchNodeHttpRuntime(baseDir, servers, options)),
  };
}

describe("watch node HTTP transport", () => {
  it("uses Gateway time for skew-independent device proof", async () => {
    const now = vi.fn(() => 1_700_000_000_123);
    const { identity, issued, baseUrl, runtime } = await createWatchNodeFixture(
      "openclaw-watch-node-challenge-time-",
      { now },
    );

    const response = await connectWatchNode({
      baseUrl,
      identity,
      bootstrapToken: issued.token,
    });

    expect(response.status).toBe(200);
    expect(now).toHaveBeenCalled();
    runtime.close();
  });

  it("rejects capabilities and identities outside the bounded watch surface", async () => {
    const { identity, issued, baseUrl, runtime } = await createWatchNodeFixture(
      "openclaw-watch-node-surface-",
    );
    const variants: Array<(nonce: string) => ConnectParams> = [
      (nonce) =>
        makeConnectParams({
          identity,
          nonce,
          bootstrapToken: issued.token,
          commands: ["device.info", "device.status", "system.notify", "system.run"],
        }),
      (nonce) =>
        makeConnectParams({ identity, nonce, bootstrapToken: issued.token, caps: ["canvas"] }),
      (nonce) =>
        makeConnectParams({
          identity,
          nonce,
          bootstrapToken: issued.token,
          client: { deviceFamily: "iPhone" },
        }),
      (nonce) =>
        makeConnectParams({
          identity,
          nonce,
          bootstrapToken: issued.token,
          permissions: { notifications: true, canvas: true },
        }),
      (nonce) =>
        makeConnectParams({
          identity,
          nonce,
          bootstrapToken: issued.token,
          minProtocol: PROTOCOL_VERSION + 1,
          maxProtocol: PROTOCOL_VERSION + 1,
        }),
    ];

    for (const variant of variants) {
      const challenge = await readJson(await fetch(`${baseUrl}/challenge`));
      const response = await fetch(`${baseUrl}/connect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(variant(String(challenge.nonce))),
      });
      expect(response.status).toBe(400);
      expect(await readJson(response)).toMatchObject({
        error: { message: "unsupported watch node identity or capability surface" },
      });
    }
    runtime.close();
  });

  it("accepts a supported notification permission set to false", async () => {
    const { identity, issued, baseUrl, runtime } = await createWatchNodeFixture(
      "openclaw-watch-node-permissions-",
    );
    const response = await connectWatchNode({
      baseUrl,
      identity,
      bootstrapToken: issued.token,
      permissions: { notifications: false },
    });

    expect(response.status).toBe(200);
    await readJson(response);
    runtime.close();
  });

  it("does not let attacker challenges evict another client nonce", async () => {
    const { identity, issued, baseUrl, runtime } = await createWatchNodeFixture(
      "openclaw-watch-node-challenge-eviction-",
      {
        config: { gateway: { trustedProxies: ["127.0.0.1"] } },
      },
    );
    const legitimateHeaders = { "x-forwarded-for": "203.0.113.10" };
    const legitimate = await readJson(
      await fetch(`${baseUrl}/challenge`, { headers: legitimateHeaders }),
    );
    for (let index = 0; index < 32; index += 1) {
      const response = await fetch(`${baseUrl}/challenge`, {
        headers: { "x-forwarded-for": "198.51.100.20" },
      });
      expect(response.status).toBe(200);
      await readJson(response);
    }

    const connectResponse = await fetch(`${baseUrl}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json", ...legitimateHeaders },
      body: JSON.stringify(
        makeConnectParams({
          identity,
          nonce: String(legitimate.nonce),
          bootstrapToken: issued.token,
        }),
      ),
    });
    expect(connectResponse.status).toBe(200);
    runtime.close();
  });

  it("requires an authenticated disconnect and emits one lifecycle teardown", async () => {
    const {
      baseDir,
      identity,
      issued,
      nodeRegistry,
      connectedNodes,
      disconnectedNodes,
      runtime,
      baseUrl,
    } = await createWatchNodeFixture("openclaw-watch-node-disconnect-");

    const connectResponse = await connectWatchNode({
      baseUrl,
      identity,
      bootstrapToken: issued.token,
    });
    expect(connectResponse.status).toBe(200);
    const connected = await readJson(connectResponse);
    const sessionToken = String(connected.sessionToken);
    expect(connectedNodes).toEqual([identity.deviceId]);

    const unauthenticated = await fetch(`${baseUrl}/disconnect`, { method: "POST" });
    expect(unauthenticated.status).toBe(401);
    expect(nodeRegistry.get(identity.deviceId)).toBeDefined();
    expect(disconnectedNodes).toEqual([]);

    const wrongMethod = await fetch(`${baseUrl}/disconnect`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(wrongMethod.status).toBe(405);
    expect(nodeRegistry.get(identity.deviceId)).toBeDefined();

    await waitForLastConnectedMetadata(baseDir, identity.deviceId);
    const pairingLockReady = createDeferred();
    const pairingLockPending = createDeferred();
    const pairingLock = withDevicePairingLock(async () => {
      pairingLockReady.resolve();
      await pairingLockPending.promise;
    });
    await pairingLockReady.promise;
    try {
      const disconnectResponse = await fetch(`${baseUrl}/disconnect`, {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      expect(disconnectResponse.status).toBe(200);
      await expect(readJson(disconnectResponse)).resolves.toEqual({ ok: true });
      expect(nodeRegistry.get(identity.deviceId)).toBeUndefined();
      // Presence/subscription retirement must not wait for the unrelated history write.
      expect(disconnectedNodes).toEqual([
        { nodeId: identity.deviceId, reason: "watch disconnected" },
      ]);
    } finally {
      pairingLockPending.resolve();
      await pairingLock;
    }
    await vi.waitFor(async () => {
      const paired = (await listNodePairing(baseDir)).paired.find(
        (entry) => entry.nodeId === identity.deviceId,
      );
      expect(paired?.lastDisconnectedAtMs).toEqual(expect.any(Number));
    });

    const repeatedDisconnect = await fetch(`${baseUrl}/disconnect`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(repeatedDisconnect.status).toBe(401);
    runtime.close();
    expect(disconnectedNodes).toHaveLength(1);
  });

  it.each([
    { destroyTarget: "socket", delivery: "event" },
    { destroyTarget: "socket", delivery: "raw" },
    { destroyTarget: "response", delivery: "event" },
  ] as const)(
    "rejects $delivery delivery when the active watch poll $destroyTarget is destroyed",
    async ({ destroyTarget, delivery }) => {
      let resolvePollReady: (response: ServerResponse) => void = () => undefined;
      const pollReady = new Promise<ServerResponse>((resolve) => {
        resolvePollReady = resolve;
      });
      const { identity, issued, nodeRegistry, disconnectedNodes, runtime, baseUrl } =
        await createWatchNodeFixture("openclaw-watch-node-destroyed-poll-", {
          onPollReady: resolvePollReady,
        });
      const connectResponse = await connectWatchNode({
        baseUrl,
        identity,
        bootstrapToken: issued.token,
      });
      expect(connectResponse.status).toBe(200);
      const { sessionToken } = await readJson(connectResponse);
      const authorization = `Bearer ${String(sessionToken)}`;
      const pollFailure = new Promise<string>((resolve, reject) => {
        const request = httpRequest(
          `${baseUrl}/poll`,
          { method: "POST", headers: { authorization } },
          (response) => {
            response.resume();
            reject(new Error(`unexpected poll response: ${response.statusCode}`));
          },
        );
        request.once("error", (error: NodeJS.ErrnoException) => {
          resolve(error.code ?? error.message);
        });
        request.end();
      });
      try {
        const response = await pollReady;
        const socket = response.socket;
        expect(socket).not.toBeNull();
        if (destroyTarget === "socket") {
          socket!.destroy();
          expect(response.destroyed).toBe(false);
        } else {
          response.destroy();
          expect(response.destroyed).toBe(true);
        }
        expect(socket!.destroyed).toBe(true);
        expect(response.writableEnded).toBe(false);

        const payload = { id: "lost" };
        const delivered =
          delivery === "raw"
            ? nodeRegistry.sendEventRaw(
                identity.deviceId,
                "node.invoke.request",
                serializeEventPayload(payload),
              )
            : nodeRegistry.sendEvent(identity.deviceId, "node.invoke.request", payload);
        expect(delivered).toBe(false);
        expect(nodeRegistry.get(identity.deviceId)).toBeUndefined();
        await vi.waitFor(() =>
          expect(disconnectedNodes).toEqual([
            { nodeId: identity.deviceId, reason: "event delivery failed" },
          ]),
        );
        await expect(pollFailure).resolves.toBe("ECONNRESET");
        expect(nodeRegistry.sendEvent(identity.deviceId, "node.invoke.request", payload)).toBe(
          false,
        );
      } finally {
        runtime.close();
      }
      expect(disconnectedNodes).toHaveLength(1);
    },
  );

  it("rejects an HTTP node session after an external reapproval changes its generation", async () => {
    const { baseDir, identity, issued, nodeRegistry, disconnectedNodes, runtime, baseUrl } =
      await createWatchNodeFixture("openclaw-watch-node-reapproval-");
    const connectResponse = await connectWatchNode({
      baseUrl,
      identity,
      bootstrapToken: issued.token,
    });
    const connected = await readJson(connectResponse);
    const paired = await getPairedDevice(identity.deviceId, baseDir);
    const repair = await requestDevicePairing(
      {
        deviceId: identity.deviceId,
        publicKey: paired?.publicKey ?? "",
        role: "node",
        roles: ["node"],
        scopes: [],
      },
      baseDir,
    );
    await approveDevicePairing(repair.request.requestId, { callerScopes: [] }, baseDir);

    const stalePoll = await fetch(`${baseUrl}/poll`, {
      method: "POST",
      headers: { authorization: `Bearer ${String(connected.sessionToken)}` },
    });
    expect(stalePoll.status).toBe(401);
    expect(nodeRegistry.get(identity.deviceId)).toBeUndefined();
    expect(disconnectedNodes).toContainEqual({
      nodeId: identity.deviceId,
      reason: "node pairing changed",
    });
    runtime.close();
  });

  it("does not deliver queued work after a verified HTTP session is retired", async () => {
    const { baseDir, identity, issued, nodeRegistry, runtime, baseUrl } =
      await createWatchNodeFixture("openclaw-watch-node-poll-retirement-");
    try {
      const connected = await readJson(
        await connectWatchNode({ baseUrl, identity, bootstrapToken: issued.token }),
      );
      expect(
        nodeRegistry.sendEvent(identity.deviceId, "node.invoke.request", {
          id: "retired-invoke",
          command: "device.info",
        }),
      ).toBe(true);

      const checkCurrentPairing = nodeRegistry.isConnectionCurrentPairingState.bind(nodeRegistry);
      // A concurrent revoke can retire the connection after a real pairing
      // verdict resolves but before the awaiting HTTP handler uses it.
      vi.spyOn(nodeRegistry, "isConnectionCurrentPairingState").mockImplementationOnce(
        async (connId) => {
          const wasCurrent = await checkCurrentPairing(connId);
          expect(wasCurrent).toBe(true);
          const revoked = await revokeDeviceToken({
            deviceId: identity.deviceId,
            role: "node",
            baseDir,
          });
          expect(revoked.ok).toBe(true);
          runtime.invalidateSessionsForDevice(identity.deviceId, {
            role: "node",
            reason: "device-token-revoked",
          });
          queueMicrotask(() =>
            runtime.disconnectSessionsForDevice(identity.deviceId, { role: "node" }),
          );
          return wasCurrent;
        },
      );

      const response = await fetch(`${baseUrl}/poll`, {
        method: "POST",
        headers: { authorization: `Bearer ${String(connected.sessionToken)}` },
      });
      const body = await readJson(response);
      expect(response.status, JSON.stringify(body)).toBe(401);
      expect(nodeRegistry.get(identity.deviceId)).toBeUndefined();
    } finally {
      runtime.close();
    }
  });

  it("rejects an invoke result when pairing changes during body upload", async () => {
    const { baseDir, identity, issued, nodeRegistry, disconnectedNodes, runtime, baseUrl } =
      await createWatchNodeFixture("openclaw-watch-node-result-generation-");
    const connectResponse = await connectWatchNode({
      baseUrl,
      identity,
      bootstrapToken: issued.token,
    });
    const connected = await readJson(connectResponse);
    const invoke = nodeRegistry.invoke({
      nodeId: identity.deviceId,
      command: "device.info",
      timeoutMs: 2_000,
    });
    const pollResponse = await fetch(`${baseUrl}/poll`, {
      method: "POST",
      headers: { authorization: `Bearer ${String(connected.sessionToken)}` },
    });
    const polled = await readJson(pollResponse);
    const event = polled.event as { payload: { id: string } };
    const currentCheck = vi.spyOn(nodeRegistry, "isConnectionCurrentPairingState");
    currentCheck.mockClear();
    const partial = startPartialJsonRequest({
      url: `${baseUrl}/result`,
      authorization: `Bearer ${String(connected.sessionToken)}`,
    });
    partial.request.write(`{"id":${JSON.stringify(event.payload.id)},"ok":`);
    await vi.waitFor(() => expect(currentCheck).toHaveBeenCalledTimes(1));

    const paired = await getPairedDevice(identity.deviceId, baseDir);
    const repair = await requestDevicePairing(
      {
        deviceId: identity.deviceId,
        publicKey: paired?.publicKey ?? "",
        role: "node",
        roles: ["node"],
        scopes: [],
      },
      baseDir,
    );
    await approveDevicePairing(repair.request.requestId, { callerScopes: [] }, baseDir);
    partial.request.end(`true,"payloadJSON":"{\\"model\\":\\"stale\\"}"}`);

    const resultResponse = await partial.response;
    expect(resultResponse.statusCode).toBe(401);
    expect(JSON.parse(resultResponse.body)).toMatchObject({
      error: { type: "unauthorized" },
    });
    expect(currentCheck).toHaveBeenCalledTimes(2);
    expect(nodeRegistry.get(identity.deviceId)).toBeUndefined();
    expect(disconnectedNodes).toContainEqual({
      nodeId: identity.deviceId,
      reason: "node pairing changed",
    });
    await expect(invoke).resolves.toEqual({
      ok: false,
      error: {
        code: "DISCONNECTED",
        message: "node disconnected (device.info)",
      },
    });
    runtime.close();
  });

  it("rejects empty shadow credentials without consuming the challenge", async () => {
    const { baseDir, identity, issued, baseUrl, runtime } = await createWatchNodeFixture(
      "openclaw-watch-node-auth-fields-",
    );

    const challenge = await readJson(await fetch(`${baseUrl}/challenge`));
    const connect = makeConnectParams({
      identity,
      nonce: String(challenge.nonce),
      bootstrapToken: issued.token,
    });
    const shadowedResponse = await fetch(`${baseUrl}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...connect,
        auth: { ...connect.auth, token: "" },
      }),
    });
    expect(shadowedResponse.status).toBe(401);

    const connectResponse = await fetch(`${baseUrl}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(connect),
    });
    expect(connectResponse.status).toBe(200);
    await readJson(connectResponse);
    await waitForLastConnectedMetadata(baseDir, identity.deviceId);
    runtime.close();
  });

  it("keeps challenge throttling after abort and resets it after completion", async () => {
    const limiterConfig = {
      maxAttempts: 1,
      windowMs: 60_000,
      lockoutMs: 60_000,
      exemptLoopback: false,
      pruneIntervalMs: 0,
    };

    const abortedBaseDir = await tempDirs.make("openclaw-watch-node-aborted-connect-");
    const abortedIdentity = loadOrCreateDeviceIdentity({
      path: path.join(abortedBaseDir, "watch-identity.sqlite"),
    });
    const abortedBootstrap = await issueDevicePairSetupBootstrapToken({
      baseDir: abortedBaseDir,
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    const abortedLimiter = createAuthRateLimiter(limiterConfig);
    try {
      const abortedRuntime = await startWatchNodeHttpRuntime(abortedBaseDir, servers, {
        rateLimiter: abortedLimiter,
        abortConnectResponse: true,
      });
      const challenge = await readJson(await fetch(`${abortedRuntime.baseUrl}/challenge`));
      await expect(
        fetch(`${abortedRuntime.baseUrl}/connect`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            makeConnectParams({
              identity: abortedIdentity,
              nonce: String(challenge.nonce),
              bootstrapToken: abortedBootstrap.token,
            }),
          ),
        }),
      ).rejects.toThrow();
      await abortedRuntime.connectHandled;
      expect(
        abortedRuntime.broadcasts.find((entry) => entry.event === "device.pair.setup.completed"),
      ).toBeUndefined();
      expect(
        abortedRuntime.broadcasts.find(
          (entry) => entry.event === "device.pair.setup.deliveryUncertain",
        )?.payload,
      ).toMatchObject({ setupId: abortedBootstrap.setupId });
      expect(
        loadDevicePairSetupCompletionRecord(abortedBootstrap.setupId, Date.now(), abortedBaseDir),
      ).toMatchObject({
        setupId: abortedBootstrap.setupId,
        deviceId: abortedIdentity.deviceId,
        access: "node",
        deliveryState: "uncertain",
      });
      await expect(
        verifyDeviceBootstrapToken({
          token: abortedBootstrap.token,
          deviceId: abortedIdentity.deviceId,
          publicKey: publicKeyRawBase64UrlFromPem(abortedIdentity.publicKeyPem),
          role: "node",
          scopes: [],
          baseDir: abortedBaseDir,
        }),
      ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });
      const stillLimited = await fetch(`${abortedRuntime.baseUrl}/challenge`);
      expect(stillLimited.status).toBe(429);
      abortedRuntime.runtime.close();
    } finally {
      abortedLimiter.dispose();
    }

    const completedBaseDir = await tempDirs.make("openclaw-watch-node-completed-connect-");
    const completedIdentity = loadOrCreateDeviceIdentity({
      path: path.join(completedBaseDir, "watch-identity.sqlite"),
    });
    const completedBootstrap = await issueDevicePairSetupBootstrapToken({
      baseDir: completedBaseDir,
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    const completedLimiter = createAuthRateLimiter(limiterConfig);
    try {
      const completedRuntime = await startWatchNodeHttpRuntime(completedBaseDir, servers, {
        rateLimiter: completedLimiter,
      });
      const connectResponse = await connectWatchNode({
        baseUrl: completedRuntime.baseUrl,
        identity: completedIdentity,
        bootstrapToken: completedBootstrap.token,
      });
      expect(connectResponse.status).toBe(200);
      await readJson(connectResponse);
      await completedRuntime.connectHandled;
      await waitForLastConnectedMetadata(completedBaseDir, completedIdentity.deviceId);
      const resetAfterCompletion = await fetch(`${completedRuntime.baseUrl}/challenge`);
      expect(resetAfterCompletion.status).toBe(200);
      completedRuntime.runtime.close();
    } finally {
      completedLimiter.dispose();
    }
  });

  it("restores an uncorrelated bootstrap token when the connect response aborts", async () => {
    const baseDir = await tempDirs.make("openclaw-watch-node-generic-abort-");
    const identity = loadOrCreateDeviceIdentity({
      path: path.join(baseDir, "watch-identity.sqlite"),
    });
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    const runtime = await startWatchNodeHttpRuntime(baseDir, servers, {
      abortConnectResponse: true,
    });

    await expect(
      connectWatchNode({
        baseUrl: runtime.baseUrl,
        identity,
        bootstrapToken: issued.token,
      }),
    ).rejects.toThrow();
    await runtime.connectHandled;

    await expect(
      verifyDeviceBootstrapToken({
        token: issued.token,
        deviceId: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        role: "node",
        scopes: [],
        baseDir,
      }),
    ).resolves.toEqual({ ok: true });
    expect(
      runtime.broadcasts.find((entry) => entry.event.startsWith("device.pair.setup.")),
    ).toBeUndefined();
    runtime.runtime.close();
  });

  it("persists setup status before handing off the successful connect response", async () => {
    let fixtureBaseDir = "";
    let setupId = "";
    let completionAtHandoff: ReturnType<typeof loadDevicePairSetupCompletionRecord> = null;
    const fixture = await createWatchNodeFixture("openclaw-watch-node-setup-order-", {
      onConnectResponseStart: () => {
        completionAtHandoff = loadDevicePairSetupCompletionRecord(
          setupId,
          Date.now(),
          fixtureBaseDir,
        );
      },
    });
    fixtureBaseDir = fixture.baseDir;
    setupId = fixture.issued.setupId;

    const response = await connectWatchNode({
      baseUrl: fixture.baseUrl,
      identity: fixture.identity,
      bootstrapToken: fixture.issued.token,
    });
    expect(response.status).toBe(200);
    await readJson(response);
    await fixture.connectHandled;
    const completionAfterHandoff = loadDevicePairSetupCompletionRecord(
      fixture.issued.setupId,
      Date.now(),
      fixture.baseDir,
    );

    expect(completionAtHandoff).toMatchObject({
      setupId: fixture.issued.setupId,
      deviceId: fixture.identity.deviceId,
      deviceName: "Test Watch",
      access: "node",
      deliveryState: "uncertain",
    });
    expect(completionAfterHandoff).toMatchObject({ deliveryState: "confirmed" });
    expect(
      fixture.broadcasts.find((entry) => entry.event === "device.pair.setup.completed")?.payload,
    ).toEqual({
      setupId: fixture.issued.setupId,
      deviceId: fixture.identity.deviceId,
      deviceName: "Test Watch",
      access: "node",
      ts: expect.any(Number),
    });
    fixture.runtime.close();
  });

  it.each([
    { name: "new Watch", existingProfile: undefined },
    { name: "node-only Watch", existingProfile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE },
    { name: "broader operator", existingProfile: FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE },
  ])("hands off only Talk access for a $name voice setup", async ({ existingProfile }) => {
    const fixture = await createWatchNodeFixture("openclaw-watch-node-voice-", {
      bootstrapProfile: VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    const { baseDir, identity, issued, baseUrl, runtime } = fixture;
    if (existingProfile) {
      const pairing = await requestDevicePairing(
        {
          deviceId: identity.deviceId,
          publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
          platform: "watchOS 11.5.0",
          deviceFamily: "Apple Watch",
          clientId: GATEWAY_CLIENT_IDS.WATCHOS_APP,
          clientMode: GATEWAY_CLIENT_MODES.NODE,
          role: "node",
          roles: existingProfile.roles,
          scopes: existingProfile.scopes,
        },
        baseDir,
      );
      const approved = await approveBootstrapDevicePairing(
        pairing.request.requestId,
        existingProfile,
        baseDir,
      );
      expect(approved?.status).toBe("approved");
    }

    const response = await connectWatchNode({ baseUrl, identity, bootstrapToken: issued.token });
    expect(response.status).toBe(200);
    const connected = await readJson(response);
    await fixture.connectHandled;
    expect(connected.deviceTokens).toEqual([
      {
        deviceToken: expect.any(String),
        role: "operator",
        scopes: ["operator.read", "operator.talk"],
        issuedAtMs: expect.any(Number),
      },
    ]);
    const operatorToken = (connected.deviceTokens as { deviceToken: string }[])[0]!.deviceToken;
    await expect(
      verifyDeviceToken({
        deviceId: identity.deviceId,
        token: operatorToken,
        role: "operator",
        scopes: ["operator.read", "operator.talk"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: true });
    for (const scope of ["operator.admin", "operator.write", "operator.talk.secrets"]) {
      await expect(
        verifyDeviceToken({
          deviceId: identity.deviceId,
          token: operatorToken,
          role: "operator",
          scopes: [scope],
          baseDir,
        }),
      ).resolves.toMatchObject({ ok: false, reason: "scope-mismatch" });
    }
    const paired = await getPairedDevice(identity.deviceId, baseDir);
    expect(paired?.roles).toEqual(["node", "operator"]);
    expect(paired?.approvedScopes).toEqual(["operator.read", "operator.talk"]);
    expect(loadDevicePairSetupCompletionRecord(issued.setupId, Date.now(), baseDir)).toMatchObject({
      access: "limited",
      deliveryState: "confirmed",
    });

    const reconnect = await connectWatchNode({
      baseUrl,
      identity,
      deviceToken: String(connected.deviceToken),
    });
    expect(reconnect.status).toBe(200);
    expect((await readJson(reconnect)).deviceTokens).toBeUndefined();
    const replay = await connectWatchNode({ baseUrl, identity, bootstrapToken: issued.token });
    expect(replay.status).toBe(401);
    runtime.close();
  });

  it.each([
    { name: "limited mobile", profile: PAIRING_SETUP_BOOTSTRAP_PROFILE },
    { name: "full mobile", profile: FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE },
  ])("does not accept a $name grant over Watch HTTP", async ({ profile }) => {
    const { baseDir, identity, issued, baseUrl, runtime } = await createWatchNodeFixture(
      "openclaw-watch-node-profile-boundary-",
      { bootstrapProfile: profile },
    );
    const response = await connectWatchNode({ baseUrl, identity, bootstrapToken: issued.token });
    expect(response.status).toBe(401);
    expect(await getPairedDevice(identity.deviceId, baseDir)).toBeNull();
    runtime.close();
  });

  it("restores only declared approved commands after a denied reconnect and accepts an invoke result", async () => {
    const options: Parameters<typeof startWatchNodeHttpRuntime>[2] = { config: {} };
    const {
      baseDir,
      identity,
      issued,
      nodeRegistry,
      broadcasts,
      connectedNodes,
      disconnectedNodes,
      runtime,
      connectHandled,
      baseUrl,
    } = await createWatchNodeFixture("openclaw-watch-node-http-", options);

    const connectResponse = await connectWatchNode({
      baseUrl,
      identity,
      bootstrapToken: issued.token,
      commands: ["device.info", "device.status"],
    });
    expect(connectResponse.status).toBe(200);
    const connected = await readJson(connectResponse);
    await connectHandled;
    expect(connected.sessionToken).toEqual(expect.any(String));
    expect(connected.deviceToken).toEqual(expect.any(String));
    expect(connected.deviceTokens).toBeUndefined();
    expect(nodeRegistry.get(identity.deviceId)?.commands).toEqual(["device.info", "device.status"]);
    expect(broadcasts.map((entry) => entry.event)).toContain("device.pair.resolved");
    expect(broadcasts.map((entry) => entry.event)).toContain("node.pair.resolved");
    expect(connectedNodes).toEqual([identity.deviceId]);

    options.config = { gateway: { nodes: { commands: { deny: ["device.info"] } } } };
    nodeRegistry.refreshRuntimePolicy(options.config);
    const reconnectResponse = await connectWatchNode({
      baseUrl,
      identity,
      deviceToken: String(connected.deviceToken),
      commands: ["device.info", "system.notify"],
    });
    expect(reconnectResponse.status).toBe(200);
    const reconnected = await readJson(reconnectResponse);
    expect(reconnected.deviceToken).toBe(connected.deviceToken);
    expect(connectedNodes).toEqual([identity.deviceId, identity.deviceId]);
    expect(disconnectedNodes).toEqual([]);
    expect(nodeRegistry.get(identity.deviceId)?.commands).toEqual([]);
    const connId = nodeRegistry.get(identity.deviceId)?.connId;
    options.config = {};
    nodeRegistry.refreshRuntimePolicy(options.config);
    expect(nodeRegistry.get(identity.deviceId)).toMatchObject({
      connId,
      commands: ["device.info"],
    });
    for (const command of ["device.status", "system.notify"]) {
      await expect(
        nodeRegistry.invoke({ nodeId: identity.deviceId, command }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "POLICY_CHANGED" },
      });
    }
    const stalePollResponse = await fetch(`${baseUrl}/poll`, {
      method: "POST",
      headers: { authorization: `Bearer ${String(connected.sessionToken)}` },
    });
    expect(stalePollResponse.status).toBe(401);

    const invoke = nodeRegistry.invoke({
      nodeId: identity.deviceId,
      command: "device.info",
      timeoutMs: 2_000,
    });
    const pollResponse = await fetch(`${baseUrl}/poll`, {
      method: "POST",
      headers: { authorization: `Bearer ${String(reconnected.sessionToken)}` },
    });
    expect(pollResponse.status).toBe(200);
    const polled = await readJson(pollResponse);
    const event = polled.event as { event: string; payload: { id: string } };
    expect(event.event).toBe("node.invoke.request");

    const resultResponse = await fetch(`${baseUrl}/result`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${String(reconnected.sessionToken)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: event.payload.id, ok: true, payloadJSON: '{"model":"Watch"}' }),
    });
    expect(resultResponse.status).toBe(200);
    await expect(invoke).resolves.toMatchObject({
      ok: true,
      payloadJSON: '{"model":"Watch"}',
    });

    const lateResultResponse = await fetch(`${baseUrl}/result`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${String(reconnected.sessionToken)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: event.payload.id, ok: true }),
    });
    expect(lateResultResponse.status).toBe(200);
    await expect(readJson(lateResultResponse)).resolves.toEqual({ ok: true, ignored: true });
    await expect(nodeRegistry.checkConnectivity(identity.deviceId)).resolves.toEqual({ ok: true });

    runtime.invalidateSessionsForDevice(identity.deviceId, {
      role: "node",
      reason: "device-token-revoked",
    });
    await expect(nodeRegistry.checkConnectivity(identity.deviceId)).resolves.toEqual({
      ok: false,
      error: { code: "NOT_CONNECTED", message: "device-token-revoked" },
    });
    runtime.disconnectSessionsForDevice(identity.deviceId, { role: "node" });
    expect(nodeRegistry.get(identity.deviceId)).toBeUndefined();
    await vi.waitFor(() =>
      expect(disconnectedNodes).toContainEqual({
        nodeId: identity.deviceId,
        reason: "device-token-revoked",
      }),
    );
    const invalidatedPollResponse = await fetch(`${baseUrl}/poll`, {
      method: "POST",
      headers: { authorization: `Bearer ${String(reconnected.sessionToken)}` },
    });
    expect(invalidatedPollResponse.status).toBe(401);

    const revoked = await revokeDeviceToken({
      deviceId: identity.deviceId,
      role: "node",
      baseDir,
    });
    expect(revoked.ok).toBe(true);
    const replacementBootstrap = await issueDeviceBootstrapToken({
      baseDir,
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    const replacementResponse = await connectWatchNode({
      baseUrl,
      identity,
      bootstrapToken: replacementBootstrap.token,
    });
    expect(replacementResponse.status).toBe(200);
    const replacement = await readJson(replacementResponse);
    expect(replacement.deviceToken).toEqual(expect.any(String));
    expect(replacement.deviceToken).not.toBe(connected.deviceToken);
    expect(connectedNodes).toEqual([identity.deviceId, identity.deviceId, identity.deviceId]);

    const replayResponse = await connectWatchNode({
      baseUrl,
      identity,
      bootstrapToken: replacementBootstrap.token,
    });
    expect(replayResponse.status).toBe(401);

    const rawPayload = serializeEventPayload({ sequence: 1 });
    expect(rawPayload).not.toBeNull();
    expect(nodeRegistry.sendEventRaw(identity.deviceId, "node.invoke.request", rawPayload)).toBe(
      true,
    );
    const rawPollResponse = await fetch(`${baseUrl}/poll`, {
      method: "POST",
      headers: { authorization: `Bearer ${String(replacement.sessionToken)}` },
    });
    expect(rawPollResponse.status).toBe(200);
    await expect(readJson(rawPollResponse)).resolves.toMatchObject({
      ok: true,
      event: { event: "node.invoke.request", payload: { sequence: 1 } },
    });

    const oversizedPayload = serializeEventPayload({ value: "x".repeat(70 * 1024) });
    expect(oversizedPayload).not.toBeNull();
    expect(
      nodeRegistry.sendEventRaw(identity.deviceId, "node.invoke.request", oversizedPayload),
    ).toBe(false);
    expect(nodeRegistry.get(identity.deviceId)).toBeUndefined();
    await vi.waitFor(() =>
      expect(disconnectedNodes).toContainEqual({
        nodeId: identity.deviceId,
        reason: "event payload too large",
      }),
    );

    runtime.close();
    expect(nodeRegistry.get(identity.deviceId)).toBeUndefined();
  });
});

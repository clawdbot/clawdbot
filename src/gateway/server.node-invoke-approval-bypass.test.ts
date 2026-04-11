import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  deriveDeviceIdFromPublicKey,
  type DeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { sleep } from "../utils.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import { buildDeviceAuthPayload } from "./device-auth.js";
import {
  connectReq,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startServerWithClient,
  trackConnectChallengeNonce,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const NODE_CONNECT_TIMEOUT_MS = 10_000;
const CONNECT_REQ_TIMEOUT_MS = 2_000;

function createDeviceIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKeyRaw = publicKeyRawBase64UrlFromPem(publicKeyPem);
  const deviceId = deriveDeviceIdFromPublicKey(publicKeyRaw);
  if (!deviceId) {
    throw new Error("failed to create test device identity");
  }
  return {
    deviceId,
    publicKeyPem,
    privateKeyPem,
  };
}

async function expectNoForwardedInvoke(hasInvoke: () => boolean): Promise<void> {
  // Yield a couple of macrotasks so any accidental async forwarding would fire.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(hasInvoke()).toBe(false);
}

async function getConnectedNodeId(ws: WebSocket): Promise<string> {
  const nodes = await rpcReq<{ nodes?: Array<{ nodeId: string; connected?: boolean }> }>(
    ws,
    "node.list",
    {},
  );
  expect(nodes.ok).toBe(true);
  const nodeId = nodes.payload?.nodes?.find((n) => n.connected)?.nodeId ?? "";
  expect(nodeId).toBeTruthy();
  return nodeId;
}

async function getConnectedNodeIds(ws: WebSocket): Promise<string[]> {
  const nodes = await rpcReq<{ nodes?: Array<{ nodeId: string; connected?: boolean }> }>(
    ws,
    "node.list",
    {},
  );
  expect(nodes.ok).toBe(true);
  return (nodes.payload?.nodes ?? []).filter((n) => n.connected).map((n) => n.nodeId);
}

async function requestAllowOnceApproval(
  ws: WebSocket,
  command: string,
  nodeId: string,
): Promise<string> {
  const approvalId = crypto.randomUUID();
  const commandArgv = command.split(/\s+/).filter((part) => part.length > 0);
  const requestP = rpcReq(ws, "exec.approval.request", {
    id: approvalId,
    command,
    commandArgv,
    systemRunPlan: {
      argv: commandArgv,
      cwd: null,
      commandText: command,
      agentId: null,
      sessionKey: null,
    },
    nodeId,
    cwd: null,
    host: "node",
    timeoutMs: 30_000,
  });
  await rpcReq(ws, "exec.approval.resolve", { id: approvalId, decision: "allow-once" });
  const requested = await requestP;
  expect(requested.ok).toBe(true);
  return approvalId;
}

describe("node.invoke approval bypass", () => {
  let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
  let port: number;

  beforeAll(async () => {
    const started = await startServerWithClient("secret", { controlUiEnabled: true });
    server = started.server;
    port = started.port;
    started.ws.close();
  });

  afterAll(async () => {
    await server.close();
  });

  const approveAllPendingPairings = async () => {
    const { approveDevicePairing, listDevicePairing } = await import("../infra/device-pairing.js");
    const list = await listDevicePairing();
    for (const pending of list.pending) {
      await approveDevicePairing(pending.requestId, {
        callerScopes: pending.scopes ?? ["operator.admin"],
      });
    }
  };

  const connectOperatorWithRetry = async (
    scopes: string[],
    resolveDevice?: (nonce: string) => NonNullable<Parameters<typeof connectReq>[1]>["device"],
  ) => {
    const connectOnce = async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      trackConnectChallengeNonce(ws);
      const challengePromise = resolveDevice
        ? onceMessage(ws, (o) => o.type === "event" && o.event === "connect.challenge")
        : null;
      await new Promise<void>((resolve) => ws.once("open", resolve));
      const nonce = (() => {
        if (!challengePromise) {
          return Promise.resolve("");
        }
        return challengePromise.then((challenge) => {
          const value = (challenge.payload as { nonce?: unknown } | undefined)?.nonce;
          expect(typeof value).toBe("string");
          return String(value);
        });
      })();
      const res = await connectReq(ws, {
        token: "secret",
        scopes,
        ...(resolveDevice ? { device: resolveDevice(await nonce) } : {}),
        timeoutMs: CONNECT_REQ_TIMEOUT_MS,
      });
      return { ws, res };
    };

    let { ws, res } = await connectOnce();
    const message =
      res && typeof res === "object" && "error" in res
        ? ((res as { error?: { message?: string } }).error?.message ?? "")
        : "";
    if (!res.ok && message.includes("pairing required")) {
      ws.close();
      await approveAllPendingPairings();
      ({ ws, res } = await connectOnce());
    }
    expect(res.ok).toBe(true);
    return ws;
  };

  const connectOperator = async (scopes: string[]) => {
    return await connectOperatorWithRetry(scopes);
  };

  const connectOperatorWithNewDevice = async (scopes: string[]) => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
    const publicKeyRaw = publicKeyRawBase64UrlFromPem(publicKeyPem);
    const deviceId = deriveDeviceIdFromPublicKey(publicKeyRaw);
    expect(deviceId).toBeTruthy();
    return await connectOperatorWithRetry(scopes, (nonce) => {
      const signedAtMs = Date.now();
      const payload = buildDeviceAuthPayload({
        deviceId: deviceId!,
        clientId: GATEWAY_CLIENT_NAMES.TEST,
        clientMode: GATEWAY_CLIENT_MODES.TEST,
        role: "operator",
        scopes,
        signedAtMs,
        token: "secret",
        nonce,
      });
      return {
        id: deviceId!,
        publicKey: publicKeyRaw,
        signature: signDevicePayload(privateKeyPem, payload),
        signedAt: signedAtMs,
        nonce,
      };
    });
  };

  const connectLinuxNode = async (
    onInvoke: (payload: unknown) => void,
    deviceIdentity?: DeviceIdentity,
    commands: string[] = ["system.run"],
  ) => {
    let readyResolve: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });

    const resolvedDeviceIdentity = deviceIdentity ?? createDeviceIdentity();
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      // Keep challenge timeout realistic in tests; 0 maps to a 250ms timeout and can
      // trigger reconnect backoff loops under load.
      connectChallengeTimeoutMs: 2_000,
      token: "secret",
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientVersion: "1.0.0",
      platform: "linux",
      mode: GATEWAY_CLIENT_MODES.NODE,
      scopes: [],
      commands,
      deviceIdentity: resolvedDeviceIdentity,
      onHelloOk: () => readyResolve?.(),
      onEvent: (evt) => {
        if (evt.event !== "node.invoke.request") {
          return;
        }
        onInvoke(evt.payload);
        const payload = evt.payload as {
          id?: string;
          nodeId?: string;
        };
        const id = typeof payload?.id === "string" ? payload.id : "";
        const nodeId = typeof payload?.nodeId === "string" ? payload.nodeId : "";
        if (!id || !nodeId) {
          return;
        }
        void client.request("node.invoke.result", {
          id,
          nodeId,
          ok: true,
          payloadJSON: JSON.stringify({ ok: true }),
        });
      },
    });
    client.start();
    await Promise.race([
      ready,
      sleep(NODE_CONNECT_TIMEOUT_MS).then(() => {
        throw new Error("timeout waiting for node to connect");
      }),
    ]);
    return client;
  };

  test("rejects malformed/forbidden node.invoke payloads before forwarding", async () => {
    let sawInvoke = false;
    const node = await connectLinuxNode(() => {
      sawInvoke = true;
    });
    const ws = await connectOperator(["operator.write"]);
    try {
      const nodeId = await getConnectedNodeId(ws);
      const cases = [
        {
          name: "rawCommand mismatch",
          payload: {
            nodeId,
            command: "system.run",
            params: {
              command: ["uname", "-a"],
              rawCommand: "echo hi",
            },
            idempotencyKey: crypto.randomUUID(),
          },
          expectedError: "rawCommand does not match command",
        },
        {
          name: "approval flags without runId",
          payload: {
            nodeId,
            command: "system.run",
            params: {
              command: ["echo", "hi"],
              rawCommand: "echo hi",
              approved: true,
              approvalDecision: "allow-once",
            },
            idempotencyKey: crypto.randomUUID(),
          },
          expectedError: "params.runId",
        },
        {
          name: "forbidden execApprovals tool",
          payload: {
            nodeId,
            command: "system.execApprovals.set",
            params: { file: { version: 1, agents: {} }, baseHash: "nope" },
            idempotencyKey: crypto.randomUUID(),
          },
          expectedError: "exec.approvals.node",
        },
      ] as const;

      for (const testCase of cases) {
        const res = await rpcReq(ws, "node.invoke", testCase.payload);
        expect(res.ok, testCase.name).toBe(false);
        expect(res.error?.message ?? "", testCase.name).toContain(testCase.expectedError);
        await expectNoForwardedInvoke(() => sawInvoke);
      }
    } finally {
      ws.close();
      node.stop();
    }
  });

  test("rejects browser.proxy persistent profile mutations before forwarding", async () => {
    let sawInvoke = false;
    const node = await connectLinuxNode(
      () => {
        sawInvoke = true;
      },
      undefined,
      ["browser.proxy"],
    );
    const ws = await connectOperator(["operator.write"]);
    try {
      const nodeId = await getConnectedNodeId(ws);
      const res = await rpcReq(ws, "node.invoke", {
        nodeId,
        command: "browser.proxy",
        params: {
          method: "POST",
          path: "/profiles/create",
          body: { name: "poc", cdpUrl: "http://127.0.0.1:9222" },
        },
        idempotencyKey: crypto.randomUUID(),
      });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain(
        "node.invoke cannot mutate persistent browser profiles via browser.proxy",
      );
      await expectNoForwardedInvoke(() => sawInvoke);
    } finally {
      ws.close();
      node.stop();
    }
  });

  test("binds approvals to decision/device and blocks cross-device replay", async () => {
    let invokeCount = 0;
    let lastInvokeParams: Record<string, unknown> | null = null;
    const node = await connectLinuxNode((payload) => {
      invokeCount += 1;
      const obj = payload as { paramsJSON?: unknown };
      const raw = typeof obj?.paramsJSON === "string" ? obj.paramsJSON : "";
      if (!raw) {
        lastInvokeParams = null;
        return;
      }
      lastInvokeParams = JSON.parse(raw) as Record<string, unknown>;
    });

    const wsApprover = await connectOperator(["operator.write", "operator.approvals"]);
    const wsCaller = await connectOperator(["operator.write"]);
    const wsOtherDevice = await connectOperatorWithNewDevice(["operator.write"]);

    try {
      const nodeId = await getConnectedNodeId(wsApprover);

      const approvalId = await requestAllowOnceApproval(wsApprover, "echo hi", nodeId);
      // Separate caller connection simulates per-call clients.
      const invoke = await rpcReq(wsCaller, "node.invoke", {
        nodeId,
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          rawCommand: "echo hi",
          runId: approvalId,
          approved: true,
          approvalDecision: "allow-always",
          injected: "nope",
        },
        idempotencyKey: crypto.randomUUID(),
      });
      expect(invoke.ok).toBe(true);
      for (let i = 0; i < 100; i += 1) {
        if (lastInvokeParams) {
          break;
        }
        await sleep(50);
      }
      expect(lastInvokeParams).toBeTruthy();
      expect(lastInvokeParams?.["approved"]).toBe(true);
      expect(lastInvokeParams?.["approvalDecision"]).toBe("allow-once");
      expect(lastInvokeParams?.["injected"]).toBeUndefined();

      const replayApprovalId = await requestAllowOnceApproval(wsApprover, "echo hi", nodeId);
      const invokeCountBeforeReplay = invokeCount;
      const replay = await rpcReq(wsOtherDevice, "node.invoke", {
        nodeId,
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          rawCommand: "echo hi",
          runId: replayApprovalId,
          approved: true,
          approvalDecision: "allow-once",
        },
        idempotencyKey: crypto.randomUUID(),
      });
      expect(replay.ok).toBe(false);
      expect(replay.error?.message ?? "").toContain("not valid for this device");
      await expectNoForwardedInvoke(() => invokeCount > invokeCountBeforeReplay);
    } finally {
      wsApprover.close();
      wsCaller.close();
      wsOtherDevice.close();
      node.stop();
    }
  });

  test("blocks cross-node replay on same device", async () => {
    const invokeCounts = new Map<string, number>();
    const onInvoke = (payload: unknown) => {
      const obj = payload as { nodeId?: unknown };
      const nodeId = typeof obj?.nodeId === "string" ? obj.nodeId : "";
      if (!nodeId) {
        return;
      }
      invokeCounts.set(nodeId, (invokeCounts.get(nodeId) ?? 0) + 1);
    };
    const nodeA = await connectLinuxNode(onInvoke, createDeviceIdentity());
    const nodeB = await connectLinuxNode(onInvoke, createDeviceIdentity());

    const wsApprover = await connectOperator(["operator.write", "operator.approvals"]);
    const wsCaller = await connectOperator(["operator.write"]);

    try {
      await expect
        .poll(async () => (await getConnectedNodeIds(wsApprover)).length, {
          timeout: 3_000,
          interval: 50,
        })
        .toBeGreaterThanOrEqual(2);
      const connectedNodeIds = await getConnectedNodeIds(wsApprover);
      const approvedNodeId = connectedNodeIds[0] ?? "";
      const replayNodeId = connectedNodeIds.find((id) => id !== approvedNodeId) ?? "";
      expect(approvedNodeId).toBeTruthy();
      expect(replayNodeId).toBeTruthy();

      const approvalId = await requestAllowOnceApproval(wsApprover, "echo hi", approvedNodeId);
      const beforeReplayApprovedNode = invokeCounts.get(approvedNodeId) ?? 0;
      const beforeReplayOtherNode = invokeCounts.get(replayNodeId) ?? 0;
      const replay = await rpcReq(wsCaller, "node.invoke", {
        nodeId: replayNodeId,
        command: "system.run",
        params: {
          command: ["echo", "hi"],
          rawCommand: "echo hi",
          runId: approvalId,
          approved: true,
          approvalDecision: "allow-once",
        },
        idempotencyKey: crypto.randomUUID(),
      });
      expect(replay.ok).toBe(false);
      expect(replay.error?.message ?? "").toContain("not valid for this node");
      await expectNoForwardedInvoke(
        () =>
          (invokeCounts.get(approvedNodeId) ?? 0) > beforeReplayApprovedNode ||
          (invokeCounts.get(replayNodeId) ?? 0) > beforeReplayOtherNode,
      );
    } finally {
      wsApprover.close();
      wsCaller.close();
      nodeA.stop();
      nodeB.stop();
    }
  });
});

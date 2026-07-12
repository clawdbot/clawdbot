// Node invoke approval-bypass tests protect signed node identity checks so
// unpaired or spoofed devices cannot receive forwarded invoke requests.
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { writeConfigFile } from "../config/config.js";
import {
  deriveDeviceIdFromPublicKey,
  type DeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import { buildDeviceAuthPayload } from "./device-auth.js";
import { issueOperatorToken } from "./device-authz.test-helpers.js";
import {
  connectReq,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startServerWithClient,
  trackConnectChallengeNonce,
} from "./test-helpers.js";
import {
  acknowledgeNodeInvokeRequestForTest,
  getConnectedNodeIdForTest,
} from "./test-helpers.node-invoke.js";

installGatewayTestHooks({ scope: "suite" });
const NODE_CONNECT_TIMEOUT_MS = 10_000;
const CONNECT_REQ_TIMEOUT_MS = 2_000;

function createDeviceKeyMaterial(label: string): DeviceIdentity & { publicKeyRaw: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKeyRaw = publicKeyRawBase64UrlFromPem(publicKeyPem);
  const deviceId = requireNonEmptyString(deriveDeviceIdFromPublicKey(publicKeyRaw), label);
  return {
    deviceId,
    publicKeyPem,
    privateKeyPem,
    publicKeyRaw,
  };
}

function createDeviceIdentity(): DeviceIdentity {
  return createDeviceKeyMaterial("test device id");
}

async function expectNoForwardedInvoke(hasInvoke: () => boolean): Promise<void> {
  // Yield a couple of macrotasks so any accidental async forwarding would fire.
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(hasInvoke()).toBe(false);
}

function parseInvokeParamsJSON(payload: unknown): Record<string, unknown> | null {
  const obj = payload as { paramsJSON?: unknown };
  const raw = typeof obj?.paramsJSON === "string" ? obj.paramsJSON : "";
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

function createInvokeParamCapture() {
  let invokeCount = 0;
  let lastInvokeParams: Record<string, unknown> | null = null;
  return {
    count: () => invokeCount,
    onInvoke: (payload: unknown) => {
      invokeCount += 1;
      lastInvokeParams = parseInvokeParamsJSON(payload);
    },
    waitForParams: async () => {
      await vi.waitFor(
        () => {
          if (!lastInvokeParams) {
            throw new Error("expected forwarded invoke params");
          }
        },
        {
          timeout: 5_000,
          interval: 50,
        },
      );
      return requireRecord(lastInvokeParams, "forwarded invoke params");
    },
  };
}

async function expectForwardedApprovedParams(params: {
  invokeCapture: ReturnType<typeof createInvokeParamCapture>;
  absentKey: string;
}): Promise<void> {
  const forwardedParams = await params.invokeCapture.waitForParams();
  expect(forwardedParams["approved"]).toBe(true);
  expect(forwardedParams["approvalDecision"]).toBe("allow-once");
  expect(forwardedParams[params.absentKey]).toBeUndefined();
}

function requireNonEmptyString(value: string | null | undefined, label: string): string {
  if (!value) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

function requireRecord(
  value: Record<string, unknown> | null | undefined,
  label: string,
): Record<string, unknown> {
  if (!value) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

async function getConnectedNodeIds(ws: WebSocket): Promise<string[]> {
  const nodes = await rpcReq<{ nodes?: Array<{ nodeId: string; connected?: boolean }> }>(
    ws,
    "node.list",
    {},
  );
  expect(nodes.ok).toBe(true);
  const nodeIds: string[] = [];
  for (const node of nodes.payload?.nodes ?? []) {
    if (node.connected) {
      nodeIds.push(node.nodeId);
    }
  }
  return nodeIds;
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
    requireDeliveryRoute: false,
    twoPhase: true,
    timeoutMs: 30_000,
  });
  const requested = await requestP;
  expect(requested.ok).toBe(true);
  const resolved = await rpcReq(ws, "exec.approval.resolve", {
    id: approvalId,
    decision: "allow-once",
  });
  expect(resolved.ok).toBe(true);
  return approvalId;
}

function approvedSystemRunParams(
  command: string[],
  rawCommand: string,
  runId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    command,
    rawCommand,
    runId,
    approved: true,
    approvalDecision: "allow-once",
    ...extra,
  };
}

function approvedChatSystemRunParams(
  context: ChatApprovalContext,
  runId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return approvedSystemRunParams(["echo", "chat"], "echo chat", runId, {
    agentId: context.agentId,
    sessionKey: context.sessionKey,
    turnSourceChannel: context.turnSourceChannel,
    turnSourceTo: context.turnSourceTo,
    turnSourceAccountId: context.turnSourceAccountId,
    turnSourceThreadId: context.turnSourceThreadId,
    ...extra,
  });
}

type ChatApprovalContext = {
  agentId: string;
  sessionKey: string;
  turnSourceChannel: string;
  turnSourceTo: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

async function requestChatAllowOnceApproval(params: {
  ws: WebSocket;
  command: string;
  nodeId: string;
  context: ChatApprovalContext;
}): Promise<string> {
  const approvalId = crypto.randomUUID();
  const commandArgv = params.command.split(/\s+/).filter((part) => part.length > 0);
  const requestP = rpcReq(params.ws, "exec.approval.request", {
    id: approvalId,
    command: params.command,
    commandArgv,
    systemRunPlan: {
      argv: commandArgv,
      cwd: null,
      commandText: params.command,
      agentId: params.context.agentId,
      sessionKey: params.context.sessionKey,
    },
    nodeId: params.nodeId,
    cwd: null,
    host: "node",
    agentId: params.context.agentId,
    sessionKey: params.context.sessionKey,
    turnSourceChannel: params.context.turnSourceChannel,
    turnSourceTo: params.context.turnSourceTo,
    turnSourceAccountId: params.context.turnSourceAccountId,
    turnSourceThreadId: params.context.turnSourceThreadId,
    requireDeliveryRoute: false,
    twoPhase: true,
    timeoutMs: 30_000,
  });
  const requested = await requestP;
  expect(requested.ok).toBe(true);
  const resolved = await rpcReq(params.ws, "exec.approval.resolve", {
    id: approvalId,
    decision: "allow-once",
  });
  expect(resolved.ok).toBe(true);
  return approvalId;
}

describe("node.invoke approval bypass", () => {
  let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
  let port: number;

  beforeAll(async () => {
    await writeConfigFile({
      gateway: {
        nodes: {
          pairing: { autoApproveCidrs: ["127.0.0.1/32", "::1/128"] },
          allowCommands: [
            "system.run",
            "system.run.prepare",
            "system.which",
            "browser.proxy",
            "fs.listDir",
          ],
        },
      },
    });
    const started = await startServerWithClient("secret", {
      controlUiEnabled: true,
    });
    server = started.server;
    port = started.port;
    started.ws.close();
  });

  afterAll(async () => {
    await server.close();
  });

  const approveAllPendingPairings = async () => {
    const { approveDevicePairing, listDevicePairing } = await import("../infra/device-pairing.js");
    const { approveNodePairing, listNodePairing } = await import("../infra/node-pairing.js");
    const deviceList = await listDevicePairing();
    for (const pending of deviceList.pending) {
      await approveDevicePairing(pending.requestId, {
        callerScopes: pending.scopes ?? ["operator.admin"],
      });
    }
    const nodeList = await listNodePairing();
    for (const pending of nodeList.pending) {
      await approveNodePairing(pending.requestId, {
        callerScopes: ["operator.admin"],
      });
    }
  };

  const approvePendingNodePairings = async (nodeId: string) => {
    const { approveNodePairing, listNodePairing } = await import("../infra/node-pairing.js");
    const list = await listNodePairing();
    let approved = false;
    for (const pending of list.pending) {
      if (pending.nodeId !== nodeId) {
        continue;
      }
      const result = await approveNodePairing(pending.requestId, {
        callerScopes: ["operator.pairing", "operator.write", "operator.admin"],
      });
      approved ||= Boolean(result && "node" in result);
    }
    return approved;
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
      await new Promise<void>((resolve) => {
        ws.once("open", resolve);
      });
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

  const connectTrustedBackend = async (scopes: string[]) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    trackConnectChallengeNonce(ws);
    await new Promise<void>((resolve) => {
      ws.once("open", resolve);
    });
    const res = await connectReq(ws, {
      token: "secret",
      scopes,
      device: null,
      client: {
        id: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        displayName: "agent",
        version: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
      timeoutMs: CONNECT_REQ_TIMEOUT_MS,
    });
    expect(res.ok).toBe(true);
    return ws;
  };

  const connectOperatorWithNewDevice = async (scopes: string[]) => {
    const { deviceId, publicKeyRaw, privateKeyPem } = createDeviceKeyMaterial("operator device id");
    return await connectOperatorWithRetry(scopes, (nonce) => {
      const signedAtMs = Date.now();
      const payload = buildDeviceAuthPayload({
        deviceId,
        clientId: GATEWAY_CLIENT_NAMES.TEST,
        clientMode: GATEWAY_CLIENT_MODES.TEST,
        role: "operator",
        scopes,
        signedAtMs,
        token: "secret",
        nonce,
      });
      return {
        id: deviceId,
        publicKey: publicKeyRaw,
        signature: signDevicePayload(privateKeyPem, payload),
        signedAt: signedAtMs,
        nonce,
      };
    });
  };

  const connectDeviceTokenOperator = async (scopes: string[]) => {
    const issued = await issueOperatorToken({
      name: `browser-proxy-scope-${crypto.randomUUID()}`,
      approvedScopes: scopes,
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    trackConnectChallengeNonce(ws);
    await new Promise<void>((resolve) => {
      ws.once("open", resolve);
    });
    const res = await connectReq(ws, {
      skipDefaultAuth: true,
      deviceIdentityPath: issued.identityPath,
      deviceToken: issued.token,
      scopes,
      timeoutMs: CONNECT_REQ_TIMEOUT_MS,
    });
    expect(res.ok).toBe(true);
    return ws;
  };

  const connectLinuxNode = async (
    onInvoke: (payload: unknown) => void,
    deviceIdentity?: DeviceIdentity,
    commands: string[] = ["system.run"],
  ) => {
    const resolvedDeviceIdentity = deviceIdentity ?? createDeviceIdentity();

    const startNodeClient = async () => {
      let readyResolve: (() => void) | null = null;
      const ready = new Promise<void>((resolve) => {
        readyResolve = resolve;
      });
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
        caps: ["system"],
        commands,
        deviceIdentity: resolvedDeviceIdentity,
        onHelloOk: () => readyResolve?.(),
        onEvent: (event) => acknowledgeNodeInvokeRequestForTest({ client, event, onInvoke }),
      });
      client.start();
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          ready,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("timeout waiting for node to connect")),
              NODE_CONNECT_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
      return client;
    };

    let client = await startNodeClient();
    if (await approvePendingNodePairings(resolvedDeviceIdentity.deviceId)) {
      client.stop();
      client = await startNodeClient();
    }
    return client;
  };

  test("rejects malformed/forbidden node.invoke payloads before forwarding", async () => {
    let sawInvoke = false;
    const node = await connectLinuxNode(() => {
      sawInvoke = true;
    });
    const ws = await connectOperator(["operator.write"]);
    try {
      const nodeId = await getConnectedNodeIdForTest(ws);
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
      const nodeId = await getConnectedNodeIdForTest(ws);
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

  test("requires admin scope for direct browser.proxy node.invoke", async () => {
    let sawInvoke = false;
    const nodeIdentity = createDeviceIdentity();
    const node = await connectLinuxNode(
      () => {
        sawInvoke = true;
      },
      nodeIdentity,
      ["browser.proxy"],
    );
    const ws = await connectDeviceTokenOperator(["operator.write"]);
    try {
      const browserRequest = await rpcReq(ws, "browser.request", {
        method: "GET",
        path: "/profiles",
      });
      expect(browserRequest.ok).toBe(false);
      expect(browserRequest.error?.message ?? "").toContain("missing scope: operator.admin");

      const directProxy = await rpcReq(ws, "node.invoke", {
        nodeId: nodeIdentity.deviceId,
        command: "browser.proxy",
        params: {
          method: "GET",
          path: "/profiles",
        },
        idempotencyKey: crypto.randomUUID(),
      });
      expect(directProxy.ok).toBe(false);
      expect(directProxy.error?.message ?? "").toContain("missing scope: operator.admin");
      await expectNoForwardedInvoke(() => sawInvoke);
    } finally {
      ws.close();
      node.stop();
    }
  });

  test("allows direct browser.proxy node.invoke for admin-scoped operators", async () => {
    let sawInvoke = false;
    const nodeIdentity = createDeviceIdentity();
    const node = await connectLinuxNode(
      () => {
        sawInvoke = true;
      },
      nodeIdentity,
      ["browser.proxy"],
    );
    const ws = await connectDeviceTokenOperator(["operator.admin"]);
    try {
      const directProxy = await rpcReq(ws, "node.invoke", {
        nodeId: nodeIdentity.deviceId,
        command: "browser.proxy",
        params: {
          method: "GET",
          path: "/profiles",
        },
        idempotencyKey: crypto.randomUUID(),
      });
      expect(directProxy.ok, JSON.stringify(directProxy.error)).toBe(true);
      expect(sawInvoke).toBe(true);
    } finally {
      ws.close();
      node.stop();
    }
  });

  test("requires admin scope for direct fs.listDir node.invoke", async () => {
    let sawInvoke = false;
    const nodeIdentity = createDeviceIdentity();
    const node = await connectLinuxNode(
      () => {
        sawInvoke = true;
      },
      nodeIdentity,
      ["fs.listDir"],
    );
    const ws = await connectDeviceTokenOperator(["operator.write"]);
    try {
      const directList = await rpcReq(ws, "node.invoke", {
        nodeId: nodeIdentity.deviceId,
        command: "fs.listDir",
        params: { path: "/tmp" },
        idempotencyKey: crypto.randomUUID(),
      });
      expect(directList.ok).toBe(false);
      expect(directList.error?.message ?? "").toContain("missing scope: operator.admin");
      await expectNoForwardedInvoke(() => sawInvoke);
    } finally {
      ws.close();
      node.stop();
    }
  });

  test("allows direct fs.listDir node.invoke for admin-scoped operators", async () => {
    let sawInvoke = false;
    const nodeIdentity = createDeviceIdentity();
    const node = await connectLinuxNode(
      () => {
        sawInvoke = true;
      },
      nodeIdentity,
      ["fs.listDir"],
    );
    const ws = await connectDeviceTokenOperator(["operator.admin"]);
    try {
      const directList = await rpcReq(ws, "node.invoke", {
        nodeId: nodeIdentity.deviceId,
        command: "fs.listDir",
        params: { path: "/tmp" },
        idempotencyKey: crypto.randomUUID(),
      });
      expect(directList.ok, JSON.stringify(directList.error)).toBe(true);
      expect(sawInvoke).toBe(true);
    } finally {
      ws.close();
      node.stop();
    }
  });

  test("binds approvals to decision/device and blocks cross-device replay", async () => {
    const invokeCapture = createInvokeParamCapture();
    const node = await connectLinuxNode(invokeCapture.onInvoke);

    const wsApprover = await connectOperator(["operator.write", "operator.approvals"]);
    const wsCaller = await connectOperator(["operator.write"]);
    const wsOtherDevice = await connectOperatorWithNewDevice(["operator.write"]);

    try {
      const nodeId = await getConnectedNodeIdForTest(wsApprover);

      const approvalId = await requestAllowOnceApproval(wsApprover, "echo hi", nodeId);
      // Separate caller connection simulates per-call clients.
      const invoke = await rpcReq(wsCaller, "node.invoke", {
        nodeId,
        command: "system.run",
        params: approvedSystemRunParams(["echo", "hi"], "echo hi", approvalId, {
          approvalDecision: "allow-always",
          injected: "nope",
        }),
        idempotencyKey: crypto.randomUUID(),
      });
      expect(invoke.ok, JSON.stringify(invoke.error)).toBe(true);
      await expectForwardedApprovedParams({ invokeCapture, absentKey: "injected" });

      const replayApprovalId = await requestAllowOnceApproval(wsApprover, "echo hi", nodeId);
      const invokeCountBeforeReplay = invokeCapture.count();
      const replay = await rpcReq(wsOtherDevice, "node.invoke", {
        nodeId,
        command: "system.run",
        params: approvedSystemRunParams(["echo", "hi"], "echo hi", replayApprovalId),
        idempotencyKey: crypto.randomUUID(),
      });
      expect(replay.ok).toBe(false);
      expect(replay.error?.message ?? "").toContain("not valid for this device");
      await expectNoForwardedInvoke(() => invokeCapture.count() > invokeCountBeforeReplay);
    } finally {
      wsApprover.close();
      wsCaller.close();
      wsOtherDevice.close();
      node.stop();
    }
  });

  test("bridges no-device chat approvals across backend reconnects only for the same turn source", async () => {
    const invokeCapture = createInvokeParamCapture();
    const node = await connectLinuxNode(invokeCapture.onInvoke);

    const wsRequest = await connectTrustedBackend(["operator.write", "operator.approvals"]);
    const wsReplay = await connectTrustedBackend(["operator.write", "operator.approvals"]);

    try {
      const nodeId = await getConnectedNodeIdForTest(wsRequest);
      const context: ChatApprovalContext = {
        agentId: "main",
        sessionKey: "agent:main:telegram:direct:12345",
        turnSourceChannel: "telegram",
        turnSourceTo: "telegram:12345",
        turnSourceAccountId: "work",
        turnSourceThreadId: "42",
      };

      const approvalId = await requestChatAllowOnceApproval({
        ws: wsRequest,
        command: "echo chat",
        nodeId,
        context,
      });
      const invoke = await rpcReq(wsReplay, "node.invoke", {
        nodeId,
        command: "system.run",
        params: approvedChatSystemRunParams(context, approvalId),
        idempotencyKey: crypto.randomUUID(),
      });
      expect(invoke.ok).toBe(true);
      await expectForwardedApprovedParams({ invokeCapture, absentKey: "turnSourceTo" });

      const mismatchApprovalId = await requestChatAllowOnceApproval({
        ws: wsRequest,
        command: "echo chat",
        nodeId,
        context,
      });
      const invokeCountBeforeMismatch = invokeCapture.count();
      const mismatch = await rpcReq(wsReplay, "node.invoke", {
        nodeId,
        command: "system.run",
        params: approvedChatSystemRunParams(context, mismatchApprovalId, {
          turnSourceTo: "telegram:67890",
        }),
        idempotencyKey: crypto.randomUUID(),
      });
      expect(mismatch.ok).toBe(false);
      expect(mismatch.error?.message ?? "").toContain("not valid for this client");
      await expectNoForwardedInvoke(() => invokeCapture.count() > invokeCountBeforeMismatch);
    } finally {
      wsRequest.close();
      wsReplay.close();
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
      const approvedNodeId = requireNonEmptyString(connectedNodeIds[0], "approved node id");
      const replayNodeId = requireNonEmptyString(
        connectedNodeIds.find((id) => id !== approvedNodeId),
        "replay node id",
      );

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

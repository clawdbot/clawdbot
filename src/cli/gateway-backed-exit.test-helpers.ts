// Shared process-test harness: mock Gateway servers used by CLI exit-code proofs.
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { isLoopbackIpAddress, isPrivateOrLoopbackIpAddress } from "@openclaw/net-policy/ip";
import { expect } from "vitest";
import { WebSocketServer } from "ws";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../gateway/minimal-gateway.test-helpers.js";
import {
  pickMatchingExternalInterfaceAddress,
  readNetworkInterfaces,
} from "../infra/network-interfaces.js";

const activeServers = new Set<WebSocketServer>();

export const EMPTY_STABILITY_SNAPSHOT = {
  capacity: 100,
  count: 0,
  dropped: 0,
  events: [],
  summary: { byType: {} },
};

export async function startCronListGateway(token: string): Promise<{ url: string }> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  activeServers.add(wss);
  wss.on("connection", (ws) => {
    sendMinimalGatewayConnectChallenge(ws);
    ws.on("message", (data) => {
      const frame = parseMinimalGatewayRequestFrame(data);
      if (frame.type !== "req" || !frame.id) {
        return;
      }
      if (frame.method === "connect") {
        expect(frame.params?.auth?.token).toBe(token);
        sendMinimalGatewayResponse(
          ws,
          frame.id,
          buildMinimalGatewayHelloOkPayload({
            methods: ["cron.list"],
            auth: { role: "operator", scopes: ["operator.admin"] },
          }),
        );
        return;
      }
      if (frame.method === "cron.list") {
        sendMinimalGatewayResponse(ws, frame.id, {
          jobs: [],
          snapshotRevision: "test-revision",
          total: 0,
          offset: 0,
          limit: 50,
          hasMore: false,
          nextOffset: null,
          deliveryPreviews: {},
        });
      }
    });
  });
  await once(wss, "listening");
  const address = wss.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${address.port}` };
}

export async function startRateLimitedGateway(): Promise<{ url: string }> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  activeServers.add(wss);
  wss.on("connection", (ws) => {
    sendMinimalGatewayConnectChallenge(ws);
    ws.on("message", (data) => {
      const frame = parseMinimalGatewayRequestFrame(data);
      if (frame.type !== "req" || !frame.id || frame.method !== "connect") {
        return;
      }
      const message = "unauthorized: too many failed authentication attempts (retry later)";
      ws.send(
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message,
            retryable: true,
            retryAfterMs: 60_000,
            details: {
              code: "AUTH_RATE_LIMITED",
              authReason: "rate_limited",
              recommendedNextStep: "wait_then_retry",
            },
          },
        }),
        () => ws.close(1008, message),
      );
    });
  });
  await once(wss, "listening");
  const address = wss.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${address.port}` };
}

export async function startNodePairingGateway(
  token: string,
  issuedDeviceToken?: string,
): Promise<{
  calls: string[];
  readonly connectionCount: number;
  url: string;
}> {
  const calls: string[] = [];
  let connectionCount = 0;
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  activeServers.add(wss);
  wss.on("connection", (ws) => {
    connectionCount += 1;
    sendMinimalGatewayConnectChallenge(ws);
    ws.on("message", (data) => {
      const frame = parseMinimalGatewayRequestFrame(data);
      if (frame.type !== "req" || !frame.id) {
        return;
      }
      if (frame.method === "connect") {
        expect(frame.params?.auth?.token).toBe(token);
        sendMinimalGatewayResponse(
          ws,
          frame.id,
          buildMinimalGatewayHelloOkPayload({
            methods: ["node.pair.list", "node.pair.approve", "node.list"],
            auth: {
              role: "operator",
              scopes: ["operator.admin"],
              ...(issuedDeviceToken ? { deviceToken: issuedDeviceToken } : {}),
            },
          }),
        );
        return;
      }
      if (typeof frame.method !== "string") {
        return;
      }
      calls.push(frame.method);
      if (frame.method === "node.pair.list") {
        sendMinimalGatewayResponse(ws, frame.id, {
          pending: [{ requestId: "request-1", nodeId: "node-1", commands: [] }],
          paired: [],
        });
        return;
      }
      if (frame.method === "node.list") {
        sendMinimalGatewayResponse(ws, frame.id, { nodes: [] });
        return;
      }
      if (frame.method === "node.pair.approve") {
        sendMinimalGatewayResponse(ws, frame.id, { approved: true });
      }
    });
  });
  await once(wss, "listening");
  const address = wss.address() as AddressInfo;
  return {
    calls,
    get connectionCount() {
      return connectionCount;
    },
    url: `ws://127.0.0.1:${address.port}`,
  };
}

export async function startGatewayStabilityRpcServer(
  token: string,
  issuedDeviceToken: string,
): Promise<{
  authTokens: Array<string | undefined>;
  calls: string[];
  url: string;
}> {
  const authTokens: Array<string | undefined> = [];
  const calls: string[] = [];
  const wss = new WebSocketServer({ host: "0.0.0.0", port: 0 });
  activeServers.add(wss);
  wss.on("connection", (ws) => {
    sendMinimalGatewayConnectChallenge(ws);
    ws.on("message", (data) => {
      const frame = parseMinimalGatewayRequestFrame(data);
      if (frame.type !== "req" || !frame.id) {
        return;
      }
      if (frame.method === "connect") {
        expect(frame.params?.auth?.token).toBe(token);
        authTokens.push(frame.params?.auth?.token);
        sendMinimalGatewayResponse(
          ws,
          frame.id,
          buildMinimalGatewayHelloOkPayload({
            methods: ["diagnostics.stability", "status"],
            auth: {
              role: "operator",
              scopes: ["operator.admin"],
              deviceToken: issuedDeviceToken,
            },
          }),
        );
        return;
      }
      if (typeof frame.method !== "string") {
        return;
      }
      calls.push(frame.method);
      if (frame.method === "diagnostics.stability") {
        sendMinimalGatewayResponse(ws, frame.id, EMPTY_STABILITY_SNAPSHOT);
        return;
      }
      if (frame.method === "status") {
        sendMinimalGatewayResponse(ws, frame.id, {
          runtimeVersion: "2026.8.17-test",
          status: "ok",
        });
      }
    });
  });
  await once(wss, "listening");
  const address = wss.address() as AddressInfo;
  // A private non-loopback target keeps shared-secret auth from bypassing device identity.
  const host = pickMatchingExternalInterfaceAddress(readNetworkInterfaces(), {
    family: "IPv4",
    matches: (candidate) =>
      isPrivateOrLoopbackIpAddress(candidate) && !isLoopbackIpAddress(candidate),
  });
  if (!host) {
    throw new Error("test host has no non-loopback private IPv4 address");
  }
  return { authTokens, calls, url: `ws://${host}:${address.port}` };
}

/** Mock Gateway that answers one agent turn with the requested terminal status. */
export async function startAgentTurnGateway(params: {
  status: "ok" | "error";
  text: string;
}): Promise<{ url: string; token: string }> {
  const token = "agent-turn-token";
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  activeServers.add(wss);
  wss.on("connection", (ws) => {
    sendMinimalGatewayConnectChallenge(ws);
    ws.on("message", (data) => {
      const frame = parseMinimalGatewayRequestFrame(data);
      if (frame.type !== "req" || !frame.id) {
        return;
      }
      if (frame.method === "connect") {
        expect(frame.params?.auth?.token).toBe(token);
        sendMinimalGatewayResponse(
          ws,
          frame.id,
          buildMinimalGatewayHelloOkPayload({
            methods: ["agent"],
            auth: { role: "operator", scopes: ["operator.admin"] },
          }),
        );
        return;
      }
      if (frame.method !== "agent") {
        return;
      }
      const runId = "agent-turn-run";
      sendMinimalGatewayResponse(ws, frame.id, {
        runId,
        status: "accepted",
        sessionKey: "agent:main:main",
      });
      setImmediate(() => {
        sendMinimalGatewayResponse(ws, frame.id!, {
          runId,
          status: params.status,
          summary: params.status === "ok" ? "completed" : "failed",
          result: {
            payloads: [
              {
                text: params.text,
                ...(params.status === "error" ? { isError: true } : {}),
              },
            ],
            meta: {},
          },
        });
      });
    });
  });
  await once(wss, "listening");
  const address = wss.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${address.port}`, token };
}

/** Closes every mock Gateway started by these helpers; call from the suite afterEach. */
export async function closeActiveGatewayServers(): Promise<void> {
  await Promise.all(Array.from(activeServers, closeMinimalGatewayServer));
  activeServers.clear();
}

import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import http2 from "node:http2";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startProxy, stopProxy, type ProxyHandle } from "./net/proxy/proxy-lifecycle.js";
import {
  sendApnsAlert,
  sendApnsBackgroundWake,
  sendApnsExecApprovalAlert,
  sendApnsExecApprovalResolvedWake,
} from "./push-apns.js";

const testAuthPrivateKey = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
}).privateKey.export({ format: "pem", type: "pkcs8" });

const testApnsServerKey = `-----BEGIN PRIVATE KEY-----`; // pragma: allowlist secret
const testApnsServerKeyPem = `${testApnsServerKey}
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC1l/DDGxT//Ma2
1EC7ON4lb+9IOrHHd437rv5DBhMt7ZXpzmfZuXyJWd/RI3ljiCcJeXwTYdzLsyaR
aMRUnbzOoaI5/9LRdwmo007Y/US1ZxSjXW3L+vl3+QtiAUt6GDBZo49jB/LSCgu3
lXYcN96OjpkF2j8rBR8Sn7eTUMIkiCFKn8V68hMRhDuHVJHWSGsMcfq8P7jZZ8S0
31sUvQw8JaAvEhju3GbxbhQH8RnicR4VxI+bZ3v1JTnWNXCSClRmfDAM0AFrWv8k
qJXrhat4RsppeRSRDjENdUFS+VvW2s/oyaU9hXl3/G+9Srx5ANOCdLy+pTQdkq3b
Clg7a917AgMBAAECggEACpyyZolJ7PtiyeMI7pTQSp2XFrOZzKw8bgJk4oBtSE66
AMIqruSx/Fbch3Zl81gzRWosXMRoNYRzkwwHBfwUp612pqJzUzSV9tNBqHJryWWy
PsL74rx44R1604N7qGSkfE1ci+JP7h1fLOw9M3Rb+1AmOigHomYRhRjNwhXcmp5u
spnubpOpJhYANFvQbard7yFmz2n1PcmtKOZussMN9F2w3CJ0pucDDEY+kpHVXiRa
j65STQi9rxoZVKjzCo4UGIrsURZCfrtZFQ5ga8JhzytY4rsgyF6Wl2gOiZ3E+nMs
34QDdL8ZMBU6in9lb/iVEvBuUdRFqRVtH+zoQRf1RQKBgQDnZps2u40/55XpeoYW
6fR5tmgGKN4bpcd7r5zRM+831n5v4MqBfJZEq/TeGSw2ddhQbzeezQg+CRzxuVy/
MGNOKskGSZ5quamwqD3DDw8hIA6KvVpfBIEKfz4O3lbzP/3UsP3CM+c8FS2b7tzm
Mfggt1caVAj2dBd8cKyXS3bZRQKBgQDI5d4N2tAopvaRyzFXT4rhZPL1drOKCO0L
QMN8CRK1seke0W4j+pMqnT6uJd+mTGQH7aAUMFcbHvX1Pn8M5SudyljcleH8taxt
F8gw1tyH3+tnJqXiQOGFlEL6fX2V3ETThVPyVXQ2sIm17Q961tL+gSQPjYXPKTfU
IG37/9FnvwKBgBWzV6cAW7S8gSCOLvkDI7wuUP8S4hFxsI124Jv15N81rFHNoPAX
wPfbsHELp0vMLWcNpwerbrRyolZA7eO4I/f2pzeBu+uCUdmRTYl3ZhHTMcntDAaR
I5DacfVvAHR7cdB6cLG/sFXAHrDa67hiw0Q+LVr4uoZySKmQ336owxKJAoGBAMdZ
kicdYkF0rGevwZ5qB93xVkXNLAtlIBNyiIikWDSD/lfeafS5yR8YOgKFApD6bKiR
W6+s6EK5Tke1ZE1fexBwog0BjeY+QINgff44t0z9HZKV/zWsPB1ZKb12mRAEKyfZ
vZtSwKckNwKX4ix6z5RMgYQNYyJWPFf6dikBiMHxAoGBALEOli/ZehBqx5Bd7bHm
HKgZBuBmEDn0wdqB9bGXDdY84bjfNJ8crhiO+zFGzHRvwa+eO2dp0iffIFqXVG15
/DjMPsMlaX2rmmHE0iYpTo3jbDm4TrGf8uhNFJBW2f7UMAvEK30NXi4aajzIadhD
LxmTaLeSxjQDE6BXgPlf2dr4
-----END PRIVATE KEY-----`;

const testApnsServerCert = `-----BEGIN CERTIFICATE-----
MIIDaDCCAlCgAwIBAgIUafG6emKuR1YWUNOTWjvy32lTx7YwDQYJKoZIhvcNAQEL
BQAwJTEjMCEGA1UEAwwaYXBpLnNhbmRib3gucHVzaC5hcHBsZS5jb20wHhcNMjYw
NTAxMDIzMjM2WhcNMzYwNDI4MDIzMjM2WjAlMSMwIQYDVQQDDBphcGkuc2FuZGJv
eC5wdXNoLmFwcGxlLmNvbTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
ALWX8MMbFP/8xrbUQLs43iVv70g6scd3jfuu/kMGEy3tlenOZ9m5fIlZ39EjeWOI
Jwl5fBNh3MuzJpFoxFSdvM6hojn/0tF3CajTTtj9RLVnFKNdbcv6+Xf5C2IBS3oY
MFmjj2MH8tIKC7eVdhw33o6OmQXaPysFHxKft5NQwiSIIUqfxXryExGEO4dUkdZI
awxx+rw/uNlnxLTfWxS9DDwloC8SGO7cZvFuFAfxGeJxHhXEj5tne/UlOdY1cJIK
VGZ8MAzQAWta/ySoleuFq3hGyml5FJEOMQ11QVL5W9baz+jJpT2FeXf8b71KvHkA
04J0vL6lNB2SrdsKWDtr3XsCAwEAAaOBjzCBjDAdBgNVHQ4EFgQUcS8iUpQu0qs4
MHxfmbd6WjvplH4wHwYDVR0jBBgwFoAUcS8iUpQu0qs4MHxfmbd6WjvplH4wDwYD
VR0TAQH/BAUwAwEB/zA5BgNVHREEMjAwghphcGkuc2FuZGJveC5wdXNoLmFwcGxl
LmNvbYISYXBpLnB1c2guYXBwbGUuY29tMA0GCSqGSIb3DQEBCwUAA4IBAQAVP+Qg
lAjpy9jINCeVkt4x/tdZvenag7tCD03ATQ/jrbndAkoHnJt7if1PXmH4+R/iW59X
yEv7o+2cTJa1g1QQgHMdiEBhGSGzNCQl8VhvZ6eZ6eeZuVLHZUPoZhV9+eax1sB/
346JgSF6z2IIjr7H26jumZKuAqQsZwvQBOS20zZk+gewpHd4Xy3KxhLMz5Qtl7Df
ILty9ZCz2RlAy1H3bzxFEAVQt/SQ4cjmdI1U0svR3iHhpX9qT6DTZYvisjjpUBgN
0nu1jQgAYFHA2hQmgChmPJUYhkxjXtgemTYyiurXsi3VK/dQ9yrOBkk1MOwuOYZs
W8tBzWn/ZhBpWD88
-----END CERTIFICATE-----`;

type CapturedApnsRequest = {
  headers: http2.IncomingHttpHeaders;
  body: string;
};

type DestroyableConnection = {
  destroy: () => void;
};

function createDirectApnsSendFixture(params: {
  nodeId: string;
  environment: "sandbox" | "production";
  sendResult: { status: number; apnsId: string; body: string };
}) {
  return {
    send: vi.fn().mockResolvedValue(params.sendResult),
    registration: {
      nodeId: params.nodeId,
      transport: "direct" as const,
      token: "ABCD1234ABCD1234ABCD1234ABCD1234",
      topic: "ai.openclaw.ios",
      environment: params.environment,
      updatedAtMs: 1,
    },
    auth: {
      teamId: "TEAM123",
      keyId: "KEY123",
      privateKey: testAuthPrivateKey,
    },
  };
}

function createRelayApnsSendFixture(params: {
  nodeId: string;
  relayHandle?: string;
  tokenDebugSuffix?: string;
  sendResult: {
    ok: boolean;
    status: number;
    environment: "production";
    apnsId?: string;
    reason?: string;
    tokenSuffix?: string;
  };
}) {
  return {
    send: vi.fn().mockResolvedValue(params.sendResult),
    registration: {
      nodeId: params.nodeId,
      transport: "relay" as const,
      relayHandle: params.relayHandle ?? "relay-handle-12345678",
      sendGrant: "send-grant-123",
      installationId: "install-123",
      topic: "ai.openclaw.ios",
      environment: "production" as const,
      distribution: "official" as const,
      updatedAtMs: 1,
      tokenDebugSuffix: params.tokenDebugSuffix,
    },
    relayConfig: {
      baseUrl: "https://relay.openclaw.test",
      timeoutMs: 2_500,
    },
    gatewayIdentity: {
      deviceId: "gateway-device-1",
      privateKeyPem: testAuthPrivateKey,
    },
  };
}

function listen(server: HttpServer | http2.Http2SecureServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("server address unavailable"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: HttpServer | http2.Http2SecureServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectNoProperties(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    expect(record).not.toHaveProperty(key);
  }
}

function requireSendRequest(send: ReturnType<typeof vi.fn>, label = "APNs send request") {
  const [call] = send.mock.calls;
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  const [request] = call;
  return requireRecord(request, label);
}

function requirePayload(sendRequest: Record<string, unknown>) {
  return requireRecord(sendRequest.payload, "APNs payload");
}

async function startFakeApnsServer(): Promise<{
  port: number;
  requests: CapturedApnsRequest[];
  stop: () => Promise<void>;
}> {
  const requests: CapturedApnsRequest[] = [];
  const server = http2.createSecureServer({
    key: testApnsServerKeyPem,
    cert: testApnsServerCert,
    allowHTTP1: false,
  });
  server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      body += typeof chunk === "string" ? chunk : String(chunk);
    });
    stream.on("end", () => {
      requests.push({ headers, body });
      stream.respond({ ":status": 200, "apns-id": "proxied-apns-id" });
      stream.end();
    });
  });
  const port = await listen(server);
  return {
    port,
    requests,
    stop: async () => await closeServer(server),
  };
}

async function startConnectProxy(upstreamPort: number): Promise<{
  proxyUrl: string;
  connectTargets: string[];
  stop: () => Promise<void>;
}> {
  const connectTargets: string[] = [];
  const sockets = new Set<DestroyableConnection>();
  const server = createServer((_req, res) => {
    res.writeHead(502);
    res.end("CONNECT required");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (req, clientSocket, head) => {
    connectTargets.push(req.url ?? "");
    const upstreamSocket = net.connect(upstreamPort, "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });
    sockets.add(clientSocket);
    sockets.add(upstreamSocket);
    clientSocket.on("close", () => sockets.delete(clientSocket));
    upstreamSocket.on("close", () => sockets.delete(upstreamSocket));
    clientSocket.on("error", () => upstreamSocket.destroy());
    upstreamSocket.on("error", () => clientSocket.destroy());
  });
  const port = await listen(server);
  return {
    proxyUrl: `http://127.0.0.1:${port}`,
    connectTargets,
    stop: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeServer(server);
    },
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
});

describe("push APNs send semantics", () => {
  it("sends alert pushes with alert headers and payload", async () => {
    const { send, registration, auth } = createDirectApnsSendFixture({
      nodeId: "ios-node-alert",
      environment: "sandbox",
      sendResult: {
        status: 200,
        apnsId: "apns-alert-id",
        body: "",
      },
    });

    const result = await sendApnsAlert({
      registration,
      nodeId: "ios-node-alert",
      title: "Wake",
      body: "Ping",
      auth,
      requestSender: send,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const sent = requireSendRequest(send);
    expect(sent.pushType).toBe("alert");
    expect(sent.priority).toBe("10");
    const payload = requirePayload(sent);
    expect(payload.aps).toEqual({
      alert: { title: "Wake", body: "Ping" },
      sound: "default",
    });
    const openclawPayload = requireRecord(payload.openclaw, "openclaw payload");
    expectRecordFields(openclawPayload, {
      kind: "push.test",
      nodeId: "ios-node-alert",
    });
    expect(typeof openclawPayload.ts).toBe("number");
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.transport).toBe("direct");
  });

  it("routes direct APNs HTTP/2 requests through the active managed proxy", async () => {
    const apnsServer = await startFakeApnsServer();
    const proxy = await startConnectProxy(apnsServer.port);
    let proxyHandle: ProxyHandle | null = null;
    const previousTlsRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

    try {
      proxyHandle = await startProxy({ enabled: true, proxyUrl: proxy.proxyUrl });
      const { registration, auth } = createDirectApnsSendFixture({
        nodeId: "ios-node-proxied-alert",
        environment: "sandbox",
        sendResult: {
          status: 200,
          apnsId: "unused",
          body: "",
        },
      });

      const result = await sendApnsAlert({
        registration,
        nodeId: "ios-node-proxied-alert",
        title: "Wake",
        body: "Ping",
        auth,
        timeoutMs: 2_500,
      });

      expectRecordFields(requireRecord(result, "APNs result"), {
        ok: true,
        status: 200,
        apnsId: "proxied-apns-id",
        transport: "direct",
      });
      expect(proxy.connectTargets).toEqual(["api.sandbox.push.apple.com:443"]);
      expect(apnsServer.requests).toHaveLength(1);
      const request = apnsServer.requests[0];
      expect(request?.headers[":method"]).toBe("POST");
      expect(request?.headers[":path"]).toBe("/3/device/abcd1234abcd1234abcd1234abcd1234");
      expect(request?.headers["apns-topic"]).toBe("ai.openclaw.ios");
      expect(request?.headers["apns-push-type"]).toBe("alert");
      expect(request?.body).toContain('"nodeId":"ios-node-proxied-alert"');
    } finally {
      if (previousTlsRejectUnauthorized === undefined) {
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      } else {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsRejectUnauthorized;
      }
      await stopProxy(proxyHandle);
      await proxy.stop();
      await apnsServer.stop();
    }
  });

  it("sends background wake pushes with silent payload semantics", async () => {
    const { send, registration, auth } = createDirectApnsSendFixture({
      nodeId: "ios-node-wake",
      environment: "production",
      sendResult: {
        status: 200,
        apnsId: "apns-wake-id",
        body: "",
      },
    });

    const result = await sendApnsBackgroundWake({
      registration,
      nodeId: "ios-node-wake",
      wakeReason: "node.invoke",
      auth,
      requestSender: send,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const sent = requireSendRequest(send);
    expect(sent.pushType).toBe("background");
    expect(sent.priority).toBe("5");
    const payload = requirePayload(sent);
    expect(payload.aps).toEqual({
      "content-available": 1,
    });
    const openclawPayload = requireRecord(payload.openclaw, "openclaw payload");
    expectRecordFields(openclawPayload, {
      kind: "node.wake",
      reason: "node.invoke",
      nodeId: "ios-node-wake",
    });
    expect(typeof openclawPayload.ts).toBe("number");
    const aps = requireRecord(payload.aps, "APNs aps payload");
    expect(aps.alert).toBeUndefined();
    expect(aps.sound).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.environment).toBe("production");
    expect(result.transport).toBe("direct");
  });

  it("sends exec approval alert pushes with generic modal-only metadata", async () => {
    const { send, registration, auth } = createDirectApnsSendFixture({
      nodeId: "ios-node-approval-alert",
      environment: "sandbox",
      sendResult: {
        status: 200,
        apnsId: "apns-approval-alert-id",
        body: "",
      },
    });

    const result = await sendApnsExecApprovalAlert({
      registration,
      nodeId: "ios-node-approval-alert",
      approvalId: "approval-123",
      auth,
      requestSender: send,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const sent = requireSendRequest(send);
    expect(sent.pushType).toBe("alert");
    const payload = requirePayload(sent);
    expect(payload.aps).toEqual({
      alert: {
        title: "Exec approval required",
        body: "Open OpenClaw to review this request.",
      },
      sound: "default",
      category: "openclaw.exec-approval",
      "content-available": 1,
    });
    const openclawPayload = requireRecord(payload.openclaw, "openclaw payload");
    expectRecordFields(openclawPayload, {
      kind: "exec.approval.requested",
      approvalId: "approval-123",
    });
    expect(typeof openclawPayload.ts).toBe("number");
    expectNoProperties(openclawPayload, [
      "host",
      "nodeId",
      "agentId",
      "commandText",
      "allowedDecisions",
      "expiresAtMs",
    ]);
    expect(result.ok).toBe(true);
    expect(result.transport).toBe("direct");
  });

  it("sends exec approval cleanup pushes as silent background notifications", async () => {
    const { send, registration, auth } = createDirectApnsSendFixture({
      nodeId: "ios-node-approval-cleanup",
      environment: "sandbox",
      sendResult: {
        status: 200,
        apnsId: "apns-approval-cleanup-id",
        body: "",
      },
    });

    const result = await sendApnsExecApprovalResolvedWake({
      registration,
      nodeId: "ios-node-approval-cleanup",
      approvalId: "approval-123",
      auth,
      requestSender: send,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const sent = requireSendRequest(send);
    expect(sent.pushType).toBe("background");
    const payload = requirePayload(sent);
    expect(payload.aps).toEqual({
      "content-available": 1,
    });
    const openclawPayload = requireRecord(payload.openclaw, "openclaw payload");
    expectRecordFields(openclawPayload, {
      kind: "exec.approval.resolved",
      approvalId: "approval-123",
    });
    expect(typeof openclawPayload.ts).toBe("number");
    expect(result.ok).toBe(true);
    expect(result.transport).toBe("direct");
  });

  it("parses direct send failures and clamps sub-second timeouts", async () => {
    const { send, registration, auth } = createDirectApnsSendFixture({
      nodeId: "ios-node-direct-fail",
      environment: "sandbox",
      sendResult: {
        status: 400,
        apnsId: "apns-direct-fail-id",
        body: '{"reason":" BadDeviceToken "}',
      },
    });

    const result = await sendApnsAlert({
      registration,
      nodeId: "ios-node-direct-fail",
      title: "Wake",
      body: "Ping",
      auth,
      requestSender: send,
      timeoutMs: 50,
    });

    expect(requireSendRequest(send).timeoutMs).toBe(1000);
    expectRecordFields(requireRecord(result, "APNs result"), {
      ok: false,
      status: 400,
      apnsId: "apns-direct-fail-id",
      reason: "BadDeviceToken",
      tokenSuffix: "abcd1234",
      transport: "direct",
    });
  });

  it("fails closed before sending when direct registrations carry invalid topics", async () => {
    const { send, registration, auth } = createDirectApnsSendFixture({
      nodeId: "ios-node-invalid-topic",
      environment: "sandbox",
      sendResult: {
        status: 200,
        apnsId: "unused",
        body: "",
      },
    });

    await expect(
      sendApnsAlert({
        registration: { ...registration, topic: "   " },
        nodeId: "ios-node-invalid-topic",
        title: "Wake",
        body: "Ping",
        auth,
        requestSender: send,
      }),
    ).rejects.toThrow("topic required");

    expect(send).not.toHaveBeenCalled();
  });

  it("defaults background wake reason when not provided", async () => {
    const { send, registration, auth } = createDirectApnsSendFixture({
      nodeId: "ios-node-wake-default-reason",
      environment: "sandbox",
      sendResult: {
        status: 200,
        apnsId: "apns-wake-default-reason-id",
        body: "",
      },
    });

    await sendApnsBackgroundWake({
      registration,
      nodeId: "ios-node-wake-default-reason",
      auth,
      requestSender: send,
    });

    const payload = requirePayload(requireSendRequest(send));
    expectRecordFields(requireRecord(payload.openclaw, "openclaw payload"), {
      kind: "node.wake",
      reason: "node.invoke",
      nodeId: "ios-node-wake-default-reason",
    });
  });

  it("sends relay alert pushes and falls back to the stored token debug suffix", async () => {
    const { send, registration, relayConfig, gatewayIdentity } = createRelayApnsSendFixture({
      nodeId: "ios-node-relay-alert",
      tokenDebugSuffix: "deadbeef",
      sendResult: {
        ok: true,
        status: 202,
        apnsId: "relay-alert-id",
        environment: "production",
      },
    });

    const result = await sendApnsAlert({
      registration,
      nodeId: "ios-node-relay-alert",
      title: "Wake",
      body: "Ping",
      relayConfig,
      relayGatewayIdentity: gatewayIdentity,
      relayRequestSender: send,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const sent = requireSendRequest(send);
    expectRecordFields(sent, {
      relayConfig,
      sendGrant: "send-grant-123",
      relayHandle: "relay-handle-12345678",
      gatewayDeviceId: "gateway-device-1",
      pushType: "alert",
      priority: "10",
    });
    const payload = requirePayload(sent);
    expect(requireRecord(payload.aps, "APNs aps payload")).toEqual({
      alert: { title: "Wake", body: "Ping" },
      sound: "default",
    });
    expect(sent.signature).toBeTypeOf("string");
    expect(sent.signature).not.toBe("");
    expectRecordFields(requireRecord(result, "APNs result"), {
      ok: true,
      status: 202,
      apnsId: "relay-alert-id",
      tokenSuffix: "deadbeef",
      environment: "production",
      transport: "relay",
    });
  });

  it("sends relay background pushes and falls back to the relay handle suffix", async () => {
    const { send, registration, relayConfig, gatewayIdentity } = createRelayApnsSendFixture({
      nodeId: "ios-node-relay-wake",
      tokenDebugSuffix: undefined,
      sendResult: {
        ok: false,
        status: 429,
        reason: "TooManyRequests",
        environment: "production",
      },
    });

    const result = await sendApnsBackgroundWake({
      registration,
      nodeId: "ios-node-relay-wake",
      wakeReason: "queue.retry",
      relayConfig,
      relayGatewayIdentity: gatewayIdentity,
      relayRequestSender: send,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const sent = requireSendRequest(send);
    expectRecordFields(sent, {
      relayConfig,
      sendGrant: "send-grant-123",
      relayHandle: "relay-handle-12345678",
      gatewayDeviceId: "gateway-device-1",
      pushType: "background",
      priority: "5",
    });
    const payload = requirePayload(sent);
    expect(payload.aps).toEqual({ "content-available": 1 });
    const openclawPayload = requireRecord(payload.openclaw, "openclaw payload");
    expectRecordFields(openclawPayload, {
      kind: "node.wake",
      reason: "queue.retry",
      nodeId: "ios-node-relay-wake",
    });
    expect(typeof openclawPayload.ts).toBe("number");
    expectRecordFields(requireRecord(result, "APNs result"), {
      ok: false,
      status: 429,
      reason: "TooManyRequests",
      tokenSuffix: "12345678",
      environment: "production",
      transport: "relay",
    });
  });

  it("sends relay exec approval alerts with generic modal-only metadata", async () => {
    const { send, registration, relayConfig, gatewayIdentity } = createRelayApnsSendFixture({
      nodeId: "ios-node-relay-approval-alert",
      sendResult: {
        ok: true,
        status: 202,
        apnsId: "relay-approval-alert-id",
        environment: "production",
      },
    });

    const result = await sendApnsExecApprovalAlert({
      registration,
      nodeId: "ios-node-relay-approval-alert",
      approvalId: "approval-relay-1",
      relayConfig,
      relayGatewayIdentity: gatewayIdentity,
      relayRequestSender: send,
    });

    const payload = requirePayload(requireSendRequest(send));
    expect(payload.aps).toEqual({
      alert: {
        title: "Exec approval required",
        body: "Open OpenClaw to review this request.",
      },
      sound: "default",
      category: "openclaw.exec-approval",
      "content-available": 1,
    });
    const openclawPayload = requireRecord(payload.openclaw, "openclaw payload");
    expectRecordFields(openclawPayload, {
      kind: "exec.approval.requested",
      approvalId: "approval-relay-1",
    });
    expect(typeof openclawPayload.ts).toBe("number");
    expectNoProperties(openclawPayload, [
      "commandText",
      "host",
      "nodeId",
      "allowedDecisions",
      "expiresAtMs",
    ]);
    expectRecordFields(requireRecord(result, "APNs result"), {
      ok: true,
      status: 202,
      environment: "production",
      transport: "relay",
    });
  });
});

import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sendApnsAlert,
  sendApnsBackgroundWake,
  sendApnsExecApprovalAlert,
  sendApnsExecApprovalResolvedWake,
} from "./push-apns.js";

const testAuthPrivateKey = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
}).privateKey.export({ format: "pem", type: "pkcs8" });

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
    const sent = send.mock.calls[0]?.[0];
    expect(sent?.pushType).toBe("alert");
    expect(sent?.priority).toBe("10");
    expect(sent?.payload).toMatchObject({
      aps: {
        alert: { title: "Wake", body: "Ping" },
        sound: "default",
      },
      openclaw: {
        kind: "push.test",
        nodeId: "ios-node-alert",
      },
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.transport).toBe("direct");
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
    const sent = send.mock.calls[0]?.[0];
    expect(sent?.pushType).toBe("background");
    expect(sent?.priority).toBe("5");
    expect(sent?.payload).toMatchObject({
      aps: {
        "content-available": 1,
      },
      openclaw: {
        kind: "node.wake",
        reason: "node.invoke",
        nodeId: "ios-node-wake",
      },
    });
    const sentPayload = sent?.payload as { aps?: { alert?: unknown; sound?: unknown } } | undefined;
    const aps = sentPayload?.aps;
    expect(aps?.alert).toBeUndefined();
    expect(aps?.sound).toBeUndefined();
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
    const sent = send.mock.calls[0]?.[0];
    expect(sent?.pushType).toBe("alert");
    expect(sent?.payload).toMatchObject({
      aps: {
        alert: {
          title: "Exec approval required",
          body: "Open OpenClaw to review this request.",
        },
        sound: "default",
        category: "openclaw.exec-approval",
        "content-available": 1,
      },
      openclaw: {
        kind: "exec.approval.requested",
        approvalId: "approval-123",
      },
    });
    expect(sent?.payload).not.toMatchObject({
      openclaw: {
        host: expect.anything(),
        nodeId: expect.anything(),
        agentId: expect.anything(),
        commandText: expect.anything(),
        allowedDecisions: expect.anything(),
        expiresAtMs: expect.anything(),
      },
    });
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
    const sent = send.mock.calls[0]?.[0];
    expect(sent?.pushType).toBe("background");
    expect(sent?.payload).toMatchObject({
      aps: {
        "content-available": 1,
      },
      openclaw: {
        kind: "exec.approval.resolved",
        approvalId: "approval-123",
      },
    });
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

    expect(send.mock.calls[0]?.[0]?.timeoutMs).toBe(1000);
    expect(result).toMatchObject({
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

    const sent = send.mock.calls[0]?.[0];
    expect(sent?.payload).toMatchObject({
      openclaw: {
        kind: "node.wake",
        reason: "node.invoke",
        nodeId: "ios-node-wake-default-reason",
      },
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
    const sent = send.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      relayConfig,
      sendGrant: "send-grant-123",
      relayHandle: "relay-handle-12345678",
      gatewayDeviceId: "gateway-device-1",
      pushType: "alert",
      priority: "10",
      payload: {
        aps: {
          alert: { title: "Wake", body: "Ping" },
          sound: "default",
        },
      },
    });
    expect(sent?.signature).toEqual(expect.any(String));
    expect(result).toMatchObject({
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
    const sent = send.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      relayConfig,
      sendGrant: "send-grant-123",
      relayHandle: "relay-handle-12345678",
      gatewayDeviceId: "gateway-device-1",
      pushType: "background",
      priority: "5",
      payload: {
        aps: { "content-available": 1 },
        openclaw: {
          kind: "node.wake",
          reason: "queue.retry",
          nodeId: "ios-node-relay-wake",
        },
      },
    });
    expect(result).toMatchObject({
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

    const sent = send.mock.calls[0]?.[0];
    expect(sent?.payload).toMatchObject({
      aps: {
        alert: {
          title: "Exec approval required",
          body: "Open OpenClaw to review this request.",
        },
        category: "openclaw.exec-approval",
        "content-available": 1,
      },
      openclaw: {
        kind: "exec.approval.requested",
        approvalId: "approval-relay-1",
      },
    });
    expect(sent?.payload).not.toMatchObject({
      openclaw: {
        commandText: expect.anything(),
        host: expect.anything(),
        nodeId: expect.anything(),
        allowedDecisions: expect.anything(),
        expiresAtMs: expect.anything(),
      },
    });
    expect(result).toMatchObject({
      ok: true,
      status: 202,
      environment: "production",
      transport: "relay",
    });
  });
});

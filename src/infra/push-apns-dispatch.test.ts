import { generateKeyPairSync } from "node:crypto";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  sendApnsAlert,
  sendApnsBackgroundWake,
  sendApnsExecApprovalAlert,
  sendApnsExecApprovalResolvedWake,
  sendApnsPluginApprovalAlert,
  sendApnsPluginApprovalResolvedWake,
} from "./push-apns.js";

const apnsPrivateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
  format: "pem",
  type: "pkcs8",
});
const relayPrivateKey = generateKeyPairSync("ed25519").privateKey.export({
  format: "pem",
  type: "pkcs8",
});

const senderOptionKeys = {
  direct: [
    "token",
    "topic",
    "environment",
    "bearerToken",
    "payload",
    "timeoutMs",
    "pushType",
    "priority",
  ],
  relay: [
    "relayConfig",
    "sendGrant",
    "relayHandle",
    "gatewayDeviceId",
    "signature",
    "signedAtMs",
    "bodyJson",
    "pushType",
    "priority",
    "payload",
  ],
};

function createApnsTransportFixture(transport: "direct" | "relay") {
  const registration = {
    nodeId: "ios-dispatch",
    topic: "ai.openclaw.ios",
    environment: "sandbox" as const,
    updatedAtMs: 1,
  };
  if (transport === "direct") {
    const send = vi.fn().mockResolvedValue({ status: 200, apnsId: "dispatch-result", body: "" });
    return {
      send,
      params: {
        registration: {
          ...registration,
          transport: "direct" as const,
          token: "abcd1234abcd1234abcd1234abcd1234",
        },
        auth: { teamId: "TEAM123", keyId: "KEY123", privateKey: apnsPrivateKey },
        requestSender: send,
      },
    };
  }
  const send = vi.fn().mockResolvedValue({ ok: true, status: 202, environment: "sandbox" });
  return {
    send,
    params: {
      registration: {
        ...registration,
        transport: "relay" as const,
        relayHandle: "relay-dispatch",
        sendGrant: "grant-dispatch",
        installationId: "installation-dispatch",
        distribution: "official" as const,
      },
      relayConfig: { baseUrl: "https://relay.example.test", timeoutMs: 2_500 },
      relayGatewayIdentity: { deviceId: "gateway-dispatch", privateKeyPem: relayPrivateKey },
      relayRequestSender: send,
    },
  };
}

const requireRecord = createRequireRecord("object", "label-not-object");

function requireSendRequest(send: ReturnType<typeof vi.fn>) {
  expect(send).toHaveBeenCalledTimes(1);
  return requireRecord(send.mock.calls[0]?.[0], "APNs send request");
}

describe("APNs dispatch", () => {
  it.each([
    ["direct", "alert"],
    ["direct", "background"],
    ["relay", "alert"],
    ["relay", "background"],
  ] as const)(
    "preserves %s %s lifecycle forwarding and option omission",
    async (transport, kind) => {
      const { send, params } = createApnsTransportFixture(transport);
      const controller = new AbortController();
      const isCurrent = vi.fn().mockResolvedValue(true);
      const sendPush = (controls: { signal?: AbortSignal; isCurrent?: () => Promise<boolean> }) => {
        const common = { ...params, nodeId: "ios-dispatch", timeoutMs: 2_700, ...controls };
        return kind === "alert"
          ? sendApnsAlert({ ...common, title: "Wake", body: "Ping" })
          : sendApnsBackgroundWake({ ...common, wakeReason: "node.invoke" });
      };

      await sendPush({ signal: controller.signal, isCurrent });
      const controlled = requireSendRequest(send);
      expect(Object.keys(controlled)).toEqual([
        ...senderOptionKeys[transport],
        "signal",
        "isCurrent",
      ]);
      expect(controlled.signal).toBe(controller.signal);
      expect(controlled.isCurrent).toBe(isCurrent);
      expect(controlled.pushType).toBe(kind);
      expect(controlled.priority).toBe(kind === "alert" ? "10" : "5");
      expect(isCurrent).toHaveBeenCalledTimes(1);

      send.mockClear();
      await sendPush({});
      expect(Object.keys(requireSendRequest(send))).toEqual(senderOptionKeys[transport]);
      expect(isCurrent).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["direct", "relay"] as const)(
    "ignores extraneous lifecycle controls for %s approval notifications",
    async (transport) => {
      const { send, params } = createApnsTransportFixture(transport);
      const readControl = vi.fn(() => {
        throw new Error("approval notifications must not read lifecycle controls");
      });
      const approval = Object.defineProperties(
        {
          ...params,
          nodeId: "ios-dispatch",
          approvalId: "approval-dispatch",
          gatewayDeviceId: "gateway-dispatch",
          title: "Approval",
          description: "Review this request.",
          timeoutMs: 2_700,
        },
        {
          signal: { enumerable: true, get: readControl },
          isCurrent: { enumerable: true, get: readControl },
        },
      );

      for (const sendApproval of [
        sendApnsExecApprovalAlert,
        sendApnsPluginApprovalAlert,
        sendApnsExecApprovalResolvedWake,
        sendApnsPluginApprovalResolvedWake,
      ]) {
        send.mockClear();
        await sendApproval(approval);
        expect(Object.keys(requireSendRequest(send))).toEqual(senderOptionKeys[transport]);
      }
      expect(readControl).not.toHaveBeenCalled();
    },
  );
});

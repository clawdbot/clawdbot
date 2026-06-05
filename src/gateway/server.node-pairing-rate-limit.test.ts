// Node pairing rate-limit tests protect repeated pairing attempts, pending
// request cleanup, and protocol error details for node clients.
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { approveNodePairing, listNodePairing, requestNodePairing } from "../infra/node-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  connectReq,
  installGatewayTestHooks,
  testState,
  trackConnectChallengeNonce,
  withGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const NODE_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.NODE_HOST,
  version: "1.0.0",
  platform: "macos",
  mode: GATEWAY_CLIENT_MODES.NODE,
  deviceFamily: "Mac",
};

async function openWs(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => {
    ws.once("open", resolve);
  });
  return ws;
}

async function attemptNodePairing(port: number, identityPath: string) {
  const ws = await openWs(port);
  try {
    return await connectReq(ws, {
      token: "secret",
      role: "node",
      scopes: [],
      client: NODE_CLIENT,
      commands: ["system.run"],
      deviceIdentityPath: identityPath,
    });
  } finally {
    ws.close();
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
    });
  }
}

async function approveNodeIdentity(params: { identityPath: string; caps: string[] }) {
  const identity = loadOrCreateDeviceIdentity(params.identityPath);
  const request = await requestNodePairing({
    nodeId: identity.deviceId,
    platform: NODE_CLIENT.platform,
    deviceFamily: NODE_CLIENT.deviceFamily,
    caps: params.caps,
  });
  const approved = await approveNodePairing(request.request.requestId, {
    callerScopes: ["operator.pairing"],
  });
  expect(approved && !("status" in approved)).toBe(true);
  return identity;
}

describe("node pairing rate limit", () => {
  test("limits concurrent first-time node pairing requests before the pairing lock", async () => {
    testState.gatewayAuth = {
      mode: "token",
      token: "secret",
      rateLimit: {
        maxAttempts: 3,
        windowMs: 60_000,
        lockoutMs: 60_000,
        exemptLoopback: false,
      },
    };
    await withGatewayServer(async ({ port }) => {
      const identityPrefix = path.join(os.tmpdir(), `openclaw-node-pairing-${randomUUID()}`);

      const responses = await Promise.all(
        Array.from(
          { length: 8 },
          async (_, index) => await attemptNodePairing(port, `${identityPrefix}-${index}.json`),
        ),
      );
      const rateLimited = responses.filter((res) => {
        const details = res.error?.details as { code?: unknown; authReason?: unknown } | undefined;
        return (
          details?.code === ConnectErrorDetailCodes.AUTH_RATE_LIMITED &&
          details.authReason === "rate_limited"
        );
      });
      const connected = responses.filter((res) => res.ok);

      expect(connected).toHaveLength(3);
      expect(rateLimited).toHaveLength(5);
      expect((await listNodePairing()).pending).toHaveLength(3);
    });
  });

  test("keeps paired reconnects on the approved surface when upgrade pairing is limited", async () => {
    testState.gatewayAuth = {
      mode: "token",
      token: "secret",
      rateLimit: {
        maxAttempts: 3,
        windowMs: 60_000,
        lockoutMs: 60_000,
        exemptLoopback: false,
      },
    };
    await withGatewayServer(async ({ port }) => {
      const identityPrefix = path.join(
        os.tmpdir(),
        `openclaw-node-pairing-upgrade-${randomUUID()}`,
      );
      const pairedIdentityPath = `${identityPrefix}-paired.json`;
      await approveNodeIdentity({ identityPath: pairedIdentityPath, caps: ["camera"] });

      const firstTimeResponses = await Promise.all(
        Array.from(
          { length: 3 },
          async (_, index) => await attemptNodePairing(port, `${identityPrefix}-${index}.json`),
        ),
      );
      expect(firstTimeResponses.filter((res) => res.ok)).toHaveLength(3);

      const ws = await openWs(port);
      try {
        const reconnect = await connectReq(ws, {
          token: "secret",
          role: "node",
          scopes: [],
          client: NODE_CLIENT,
          caps: ["camera", "screen"],
          deviceIdentityPath: pairedIdentityPath,
        });
        expect(reconnect.ok).toBe(true);
      } finally {
        ws.close();
        await new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }
          ws.once("close", () => resolve());
        });
      }

      expect((await listNodePairing()).pending).toHaveLength(3);
    });
  });
});

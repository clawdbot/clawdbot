// Preauth bootstrap token rate-limit tests protect forged bootstrap attempts
// before normal gateway auth has completed.
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  connectReq,
  installGatewayTestHooks,
  testState,
  trackConnectChallengeNonce,
  withGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

async function openWs(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => {
    ws.once("open", resolve);
  });
  return ws;
}

async function attemptForgedBootstrap(port: number, identityPath: string) {
  const ws = await openWs(port);
  try {
    const res = await connectReq(ws, {
      skipDefaultAuth: true,
      bootstrapToken: "forged-bootstrap-token",
      deviceIdentityPath: identityPath,
    });
    return res;
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

describe("pre-auth bootstrap-token rate limit", () => {
  test("locks out concurrent forged bootstrap-token attempts after maxAttempts", async () => {
    // exemptLoopback:false ensures the limiter applies to loopback test
    // clients. In production the same gate applies to remote clients via
    // the per-IP bucket.
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
      const identityPrefix = path.join(os.tmpdir(), `openclaw-preauth-bootstrap-${randomUUID()}`);

      const responses = await Promise.all(
        Array.from(
          { length: 8 },
          async (_, index) => await attemptForgedBootstrap(port, `${identityPrefix}-${index}.json`),
        ),
      );
      const reasons = responses.map((res) => {
        expect(res.ok).toBe(false);
        const detail = res.error?.details as { authReason?: string } | undefined;
        return detail?.authReason;
      });
      expect(reasons.filter((reason) => reason === "bootstrap_token_invalid")).toHaveLength(3);
      expect(reasons.filter((reason) => reason === "rate_limited")).toHaveLength(5);
    });
  });

  test("forged bootstrap-token failures consume their own bucket independent of device-token", async () => {
    testState.gatewayAuth = {
      mode: "token",
      token: "secret",
      rateLimit: {
        maxAttempts: 1,
        windowMs: 60_000,
        lockoutMs: 60_000,
        exemptLoopback: false,
      },
    };
    await withGatewayServer(async ({ port }) => {
      const identityPath = path.join(
        os.tmpdir(),
        `openclaw-preauth-bootstrap-shared-${randomUUID()}.json`,
      );

      const first = await attemptForgedBootstrap(port, identityPath);
      expect(first.ok).toBe(false);
      const firstDetail = first.error?.details as { authReason?: string } | undefined;
      expect(firstDetail?.authReason).toBe("bootstrap_token_invalid");

      const second = await attemptForgedBootstrap(port, identityPath);
      expect(second.ok).toBe(false);
      const secondDetail = second.error?.details as { authReason?: string } | undefined;
      expect(secondDetail?.authReason).toBe("rate_limited");
    });
  });
});

import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadGatewayConfig,
  openAuthenticatedGatewayWs,
  waitForGatewayWsClose,
} from "./shared-auth.test-helpers.js";
import {
  getFreePort,
  installGatewayTestHooks,
  rpcReq,
  startGatewayServer,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const ORIGINAL_GATEWAY_AUTH = testState.gatewayAuth;
const OLD_TOKEN = "shared-token-session-old";
const NEW_TOKEN = "shared-token-session-new";

let server: Awaited<ReturnType<typeof startGatewayServer>>;
let port = 0;

beforeAll(async () => {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
  }
  port = await getFreePort();
  testState.gatewayAuth = undefined;
  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        gateway: {
          auth: {
            mode: "token",
            token: OLD_TOKEN,
          },
          reload: {
            mode: "off",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  server = await startGatewayServer(port, { controlUiEnabled: true });
});

afterAll(async () => {
  testState.gatewayAuth = ORIGINAL_GATEWAY_AUTH;
  await server.close();
});

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function buildConfigSetWithRotatedToken(config: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(config);
  const gateway = { ...toRecord(next.gateway) };
  const auth = { ...toRecord(gateway.auth), mode: "token", token: NEW_TOKEN };
  const reload = { ...toRecord(gateway.reload), mode: "off" };
  gateway.auth = auth;
  gateway.reload = reload;
  next.gateway = gateway;
  return next;
}

describe("gateway shared token session rotation", () => {
  it("invalidates shared-token websocket sessions after config.set rotation even with reload mode off", async () => {
    const ws = await openAuthenticatedGatewayWs(port, OLD_TOKEN);
    try {
      const current = await loadGatewayConfig(ws);
      const nextConfig = buildConfigSetWithRotatedToken(current.config);
      const closed = waitForGatewayWsClose(ws, 30_000);
      const setRes = await rpcReq(ws, "config.set", {
        baseHash: current.hash,
        raw: JSON.stringify(nextConfig, null, 2),
      });
      expect(setRes.ok).toBe(true);

      await expect(closed).resolves.toEqual({
        code: 4001,
        reason: "gateway auth changed",
      });
    } finally {
      ws.close();
    }
  });
});

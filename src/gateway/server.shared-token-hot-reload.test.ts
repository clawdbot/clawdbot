import fs from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openAuthenticatedGatewayWs, waitForGatewayWsClose } from "./shared-auth.test-helpers.js";
import {
  getFreePort,
  installGatewayTestHooks,
  rpcReq,
  startGatewayServer,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const ORIGINAL_GATEWAY_AUTH = testState.gatewayAuth;
const SECRET_REF_TOKEN_ID = "OPENCLAW_SHARED_TOKEN_HOT_RELOAD_SECRET_REF";
const OLD_TOKEN = "shared-token-hot-reload-old";
const NEW_TOKEN = "shared-token-hot-reload-new";

let server: Awaited<ReturnType<typeof startGatewayServer>>;
let port = 0;

function buildSharedTokenReloadConfig(): Record<string, unknown> {
  return {
    gateway: {
      auth: {
        mode: "token",
        token: { source: "env", provider: "default", id: SECRET_REF_TOKEN_ID },
      },
      reload: {
        mode: "off",
      },
    },
  };
}

beforeAll(async () => {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
  }
  port = await getFreePort();
  testState.gatewayAuth = undefined;
  process.env[SECRET_REF_TOKEN_ID] = OLD_TOKEN;
  await fs.writeFile(
    configPath,
    `${JSON.stringify(buildSharedTokenReloadConfig(), null, 2)}\n`,
    "utf-8",
  );
  server = await startGatewayServer(port, { controlUiEnabled: true });
});

beforeEach(() => {
  process.env[SECRET_REF_TOKEN_ID] = OLD_TOKEN;
});

afterAll(async () => {
  delete process.env[SECRET_REF_TOKEN_ID];
  testState.gatewayAuth = ORIGINAL_GATEWAY_AUTH;
  await server.close();
});

describe("gateway shared token hot reload rotation", () => {
  it("disconnects existing shared-token websocket sessions after hot reload picks up a rotated SecretRef value", async () => {
    const ws = await openAuthenticatedGatewayWs(port, OLD_TOKEN);
    try {
      const closed = waitForGatewayWsClose(ws);
      process.env[SECRET_REF_TOKEN_ID] = NEW_TOKEN;
      const reload = await rpcReq<{ warningCount?: number }>(ws, "secrets.reload", {}).catch(
        (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
      );

      await expect(closed).resolves.toEqual({
        code: 4001,
        reason: "gateway auth changed",
      });
      if (!(reload instanceof Error)) {
        expect(reload.ok).toBe(true);
      }

      const freshWs = await openAuthenticatedGatewayWs(port, NEW_TOKEN);
      freshWs.close();
    } finally {
      ws.close();
    }
  });
});

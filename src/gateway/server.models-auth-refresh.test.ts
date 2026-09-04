import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { resolveAgentDir } from "../agents/agent-scope.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { installGatewayTestHooks, rpcReq, startConnectedServerWithClient } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startConnectedServerWithClient>>["server"];
let ws: WebSocket;

beforeAll(async () => {
  const started = await startConnectedServerWithClient();
  server = started.server;
  ws = started.ws;
});

afterAll(async () => {
  clearSecretsRuntimeSnapshot();
  ws.close();
  await server.close();
});

describe("models.authStatus refresh RPC", () => {
  test("reports provider auth refresh failures over the connected Gateway", async () => {
    let authStoreReads = 0;
    const prepared = await prepareSecretsRuntimeSnapshot({
      config: {},
      agentDirs: [resolveAgentDir({}, "main")],
      includeConfigRefs: false,
      manifestRegistry: { plugins: [] },
      loadAuthStore: () => {
        authStoreReads += 1;
        if (authStoreReads > 1) {
          throw new Error("simulated provider auth refresh failure");
        }
        return { version: 1, profiles: {} };
      },
    });
    activateSecretsRuntimeSnapshot(prepared);

    const response = await rpcReq(ws, "models.authStatus", { refresh: true });

    expect(authStoreReads).toBe(2);
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: expect.stringContaining("simulated provider auth refresh failure"),
      },
    });
  });
});

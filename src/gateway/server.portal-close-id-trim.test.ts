import { request } from "node:http";
import { describe, expect, test } from "vitest";
import type { PortalOpenResult } from "../../packages/gateway-protocol/src/index.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks, testState, withGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const GATEWAY_TOKEN = "portal-close-trim-e2e-token";

async function httpStatus(host: string, port: number, path: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const req = request({ host, port, path }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode ?? 0));
    });
    req.once("error", reject);
    req.end();
  });
}

describe("portal.close id trim Gateway client E2E", () => {
  test("padded portal.close via real Gateway client shuts down the listener", async () => {
    testState.gatewayAuth = { mode: "token", token: GATEWAY_TOKEN };

    await withGatewayServer(async ({ port }) => {
      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token: GATEWAY_TOKEN,
        scopes: ["operator.write", "operator.read"],
        timeoutMs: 60_000,
      });
      try {
        const opened = await client.request<PortalOpenResult>("portal.open", {
          port: 41301,
          title: "Pad Close E2E",
        });
        expect(opened.id).toBeTruthy();
        expect(opened.listenPort).toBeGreaterThan(0);
        expect(await httpStatus("127.0.0.1", opened.listenPort, "/")).toBe(401);

        const closed = await client.request<{ closed: boolean }>("portal.close", {
          id: ` ${opened.id} `,
        });
        expect(closed).toEqual({ closed: true });

        const listed = await client.request<{ portals: Array<{ id: string }> }>("portal.list", {});
        expect(listed.portals.some((entry) => entry.id === opened.id)).toBe(false);

        await expect(httpStatus("127.0.0.1", opened.listenPort, "/")).rejects.toThrow();
      } finally {
        await disconnectGatewayClient(client);
      }
    });
  });
});

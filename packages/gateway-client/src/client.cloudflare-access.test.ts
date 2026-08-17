import { afterEach, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { GatewayClient } from "./client.js";

let server: WebSocketServer | undefined;

afterEach(async () => {
  if (!server) {
    return;
  }
  const closing = new Promise<void>((resolve, reject) => {
    server?.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  server = undefined;
  await closing;
});

test("sends the closed Cloudflare Access header pair through a rejecting edge", async () => {
  const clientId = ["cf", "gateway", "id"].join("-");
  const clientSecret = ["cf", "gateway", "secret"].join("-");
  server = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    verifyClient: ({ req }, done) => {
      const accepted =
        req.headers["cf-access-client-id"] === clientId &&
        req.headers["cf-access-client-secret"] === clientSecret;
      done(accepted, accepted ? undefined : 403, accepted ? undefined : "Access denied");
    },
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.once("listening", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test edge did not allocate a port");
  }
  const received = new Promise<Record<string, string | string[] | undefined>>((resolve) => {
    server?.once("connection", (_socket, request) => resolve(request.headers));
  });
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${address.port}`,
    connectChallengeTimeoutMs: 0,
    cloudflareAccess: { clientId, clientSecret },
  });
  client.start();

  await expect(received).resolves.toMatchObject({
    "cf-access-client-id": clientId,
    "cf-access-client-secret": clientSecret,
  });
  await client.stopAndWait();
});

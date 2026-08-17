import { X509Certificate } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { afterEach, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../../test/helpers/tls-fixture.js";
import { GatewayClient } from "./client.js";

let server: WebSocketServer | undefined;
let httpsServer: ReturnType<typeof createHttpsServer> | undefined;

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
  if (httpsServer) {
    const closingHttps = new Promise<void>((resolve, reject) => {
      httpsServer?.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    httpsServer = undefined;
    await closingHttps;
  }
});

test("sends the closed Cloudflare Access header pair through a rejecting edge", async () => {
  const clientId = ["cf", "gateway", "id"].join("-");
  const clientSecret = ["cf", "gateway", "secret"].join("-");
  httpsServer = createHttpsServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM });
  server = new WebSocketServer({
    server: httpsServer,
    verifyClient: ({ req }, done) => {
      const accepted =
        req.headers["cf-access-client-id"] === clientId &&
        req.headers["cf-access-client-secret"] === clientSecret;
      done(accepted, accepted ? undefined : 403, accepted ? undefined : "Access denied");
    },
  });
  await new Promise<void>((resolve, reject) => {
    httpsServer?.once("error", reject);
    httpsServer?.listen(0, "127.0.0.1", resolve);
  });
  const address = httpsServer.address();
  if (!address || typeof address === "string") {
    throw new Error("test edge did not allocate a port");
  }
  const received = new Promise<Record<string, string | string[] | undefined>>((resolve) => {
    server?.once("connection", (_socket, request) => resolve(request.headers));
  });
  const client = new GatewayClient({
    url: `wss://127.0.0.1:${address.port}`,
    connectChallengeTimeoutMs: 0,
    cloudflareAccess: { clientId, clientSecret },
    tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
  });
  client.start();

  await expect(received).resolves.toMatchObject({
    "cf-access-client-id": clientId,
    "cf-access-client-secret": clientSecret,
  });
  await client.stopAndWait();
});

test("rejects the Access pair before a plaintext WebSocket dial", async () => {
  let resolveConnectError: (error: Error) => void = () => {};
  const connectError = new Promise<Error>((resolve) => {
    resolveConnectError = resolve;
  });
  const client = new GatewayClient({
    url: "ws://127.0.0.1:18789",
    cloudflareAccess: {
      clientId: "cf-plaintext-id",
      clientSecret: "cf-plaintext-secret",
    },
    onConnectError: resolveConnectError,
  });
  client.start();

  await expect(connectError).resolves.toMatchObject({
    message: "Cloudflare Access credentials require a wss:// Gateway URL",
  });
  client.stop();
});

import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { expect, test } from "vitest";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { waitForGatewayHttpReadiness } from "../cli/daemon-cli/restart-health-probe.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  createConfiguredGatewayLocalProbe,
  requestGatewayLocalHttpProbe,
} from "./local-http-probe.js";

const fingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;

test("probes configured local TLS readiness with its exact certificate pin", async () => {
  await withTestDir({ prefix: "openclaw-local-http-probe-" }, async (directory) => {
    const certPath = path.join(directory, "gateway-cert.pem");
    const keyPath = path.join(directory, "gateway-key.pem");
    await Promise.all([
      writeFile(certPath, TEST_TLS_CERT_PEM),
      writeFile(keyPath, TEST_TLS_KEY_PEM),
    ]);
    const paths: string[] = [];
    const server = createServer(
      { cert: TEST_TLS_CERT_PEM, key: TEST_TLS_KEY_PEM },
      (request, response) => {
        paths.push(request.url ?? "");
        response.statusCode = 200;
        response.end(JSON.stringify({ ready: request.url === "/readyz" }));
      },
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;

    try {
      const probe = createConfiguredGatewayLocalProbe({
        gateway: { tls: { enabled: true, autoGenerate: false, certPath, keyPath } },
      });
      const config = {
        gateway: { tls: { enabled: true, autoGenerate: false, certPath, keyPath } },
      };
      await expect(
        waitForGatewayHttpReadiness({
          attempts: 1,
          config,
          deadlineAt: Date.now() + 1_000,
          delayMs: 0,
          port: address.port,
        }),
      ).resolves.toEqual({ healthz: 200, readyz: 200 });
      expect(paths).toEqual(expect.arrayContaining(["/healthz", "/readyz"]));
      await expect(
        probe.requestHttp({
          host: "127.0.0.1",
          pathname: "/readyz",
          port: address.port,
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({ statusCode: 200, body: JSON.stringify({ ready: true }) });
      await expect(
        requestGatewayLocalHttpProbe({
          host: "127.0.0.1",
          pathname: "/readyz",
          port: address.port,
          timeoutMs: 1_000,
          tlsFingerprint: fingerprint.replace(/[\dA-F]/g, "0"),
        }),
      ).resolves.toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

test("cancels pending readiness requests when the repair budget expires", async () => {
  const server = createHttpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP listener");
  }
  const controller = new AbortController();
  const aborted = new Error("repair-budget");
  try {
    const received = once(server, "request");
    const pending = waitForGatewayHttpReadiness({
      attempts: 3,
      deadlineAt: Date.now() + 60_000,
      delayMs: 500,
      port: address.port,
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toBe(aborted);
    await received;
    controller.abort(aborted);
    await rejected;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

import { X509Certificate } from "node:crypto";
import { createServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { createSuiteTempRootTracker, withTestDir } from "../test-helpers/temp-dir.js";
import { resolveGatewayClientBootstrap } from "./client-bootstrap.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "./minimal-gateway.test-helpers.js";
import { probeGateway } from "./probe.js";

const correctPin = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256
  .replaceAll(":", "")
  .toLowerCase();
const fingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
const wrongPin = "00".repeat(32);
const tempDirs = createSuiteTempRootTracker({ prefix: "openclaw-probe-tls-" });
const edgeAuthValue = "synthetic-probe-edge-auth";

async function startTlsProbeGateway() {
  const server = createServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM });
  const wss = new WebSocketServer({ server });
  const sockets = new Set<Socket>();
  const closedSockets: Promise<void>[] = [];
  const observed = { receivedBytes: 0, edgeAuthHeaders: [] as unknown[], connectFrames: 0 };
  server.on("connection", (socket) => {
    sockets.add(socket);
    closedSockets.push(
      new Promise<void>((resolve) => {
        socket.once("close", () => {
          sockets.delete(socket);
          resolve();
        });
      }),
    );
  });
  server.on("secureConnection", (socket) => {
    socket.on("data", (chunk: Buffer) => {
      observed.receivedBytes += chunk.byteLength;
    });
  });
  wss.on("connection", (ws, request) => {
    observed.edgeAuthHeaders.push(request.headers["x-test-edge-auth"]);
    sendMinimalGatewayConnectChallenge(ws);
    ws.on("message", (raw) => {
      const frame = parseMinimalGatewayRequestFrame(raw);
      if (frame.type !== "req" || frame.method !== "connect" || !frame.id) {
        return;
      }
      observed.connectFrames += 1;
      sendMinimalGatewayResponse(
        ws,
        frame.id,
        buildMinimalGatewayHelloOkPayload({
          auth: { role: "operator", scopes: ["operator.read"] },
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `wss://127.0.0.1:${(server.address() as AddressInfo).port}`,
    observed,
    drain: async () => Promise.all(closedSockets),
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeMinimalGatewayServer(wss);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

afterEach(() => {
  resetSecretRedactionRegistryForTest();
});

describe("probeGateway TLS", () => {
  it.each([
    { name: "saved pin", savedPin: wrongPin, explicitPin: undefined, outcome: "mismatch" },
    { name: "explicit pin", savedPin: correctPin, explicitPin: wrongPin, outcome: "mismatch" },
    { name: "matching pin", savedPin: correctPin, explicitPin: undefined, outcome: "connected" },
    { name: "CA validation", savedPin: undefined, explicitPin: undefined, outcome: "untrusted" },
  ])("validates $name before upgrade", async ({ savedPin, explicitPin, outcome }) => {
    await withTestDir({ prefix: "openclaw-probe-tls-" }, async (stateDir) => {
      const gateway = await startTlsProbeGateway();
      try {
        const env = { OPENCLAW_STATE_DIR: stateDir };
        const config: OpenClawConfig = {
          gateway: {
            mode: "remote",
            remote: {
              url: gateway.url,
              token: "synthetic-probe-token",
              tlsFingerprint: savedPin,
              edgeAuth: { "X-Test-Edge-Auth": edgeAuthValue },
            },
          },
        };
        const bootstrap = await resolveGatewayClientBootstrap({
          config,
          authPolicy: "probe",
          explicitTlsFingerprint: explicitPin,
          env,
        });
        expect(bootstrap.tlsFingerprint).toBe(explicitPin ?? savedPin);
        const result = await probeGateway({
          url: bootstrap.url,
          auth: bootstrap.auth,
          tlsFingerprint: bootstrap.tlsFingerprint,
          config,
          timeoutMs: 2_000,
          includeDetails: false,
          env,
        });
        await gateway.drain();

        if (outcome === "connected") {
          expect(result.ok).toBe(true);
          expect(result.error).toBeNull();
          expect(gateway.observed.receivedBytes).toBeGreaterThan(0);
          expect(gateway.observed.edgeAuthHeaders).toEqual([edgeAuthValue]);
          expect(gateway.observed.connectFrames).toBe(1);
          return;
        }
        expect(result.ok).toBe(false);
        expect(result.connectLatencyMs).toBeNull();
        expect(result.error).toMatch(
          outcome === "mismatch" ? /fingerprint mismatch/i : /certificate|self.signed/i,
        );
        expect.soft(gateway.observed.receivedBytes).toBe(0);
        expect.soft(gateway.observed.edgeAuthHeaders).toEqual([]);
        expect(gateway.observed.connectFrames).toBe(0);
      } finally {
        await gateway.close();
      }
    });
  });
});

describe("Gateway probe TLS trust", () => {
  let gateway: Awaited<ReturnType<typeof startTlsProbeGateway>>;
  let url: string;

  beforeAll(async () => {
    await tempDirs.setup();
    gateway = await startTlsProbeGateway();
    url = `${gateway.url}/gateway`;
  });

  afterAll(async () => {
    await gateway.close();
    await tempDirs.cleanup();
  });

  it.each([
    { name: "saved pin", savedPin: fingerprint, ok: true },
    { name: "saved pin in local mode", savedPin: fingerprint, local: true, ok: true },
    { name: "saved pin with whitespace", savedPin: ` sha256:${fingerprint} `, ok: true },
    {
      name: "wrong saved pin",
      savedPin: wrongPin,
      ok: false,
      error: "fingerprint mismatch",
    },
    { name: "malformed saved pin", savedPin: "invalid", ok: false, error: "SHA-256 fingerprint" },
    {
      name: "changed endpoint",
      savedPin: fingerprint,
      changed: true,
      ok: false,
      error: "certificate",
    },
    { name: "no saved pin", ok: false, error: "certificate" },
    {
      name: "explicit pin override",
      savedPin: wrongPin,
      explicitPin: fingerprint,
      ok: true,
    },
    {
      name: "wrong explicit pin",
      savedPin: fingerprint,
      explicitPin: wrongPin,
      ok: false,
      error: "fingerprint mismatch",
    },
  ])(
    "enforces $name before sending Gateway credentials",
    async ({ savedPin, explicitPin, local, changed, ok, error }) => {
      const before = {
        receivedBytes: gateway.observed.receivedBytes,
        edgeAuthHeaders: gateway.observed.edgeAuthHeaders.length,
        connectFrames: gateway.observed.connectFrames,
      };
      const result = await probeGateway({
        url,
        config: {
          gateway: {
            mode: local ? "local" : "remote",
            remote: {
              url: changed ? `${url}/other` : ` ${url} `,
              tlsFingerprint: savedPin,
              edgeAuth: { "X-Test-Edge-Auth": edgeAuthValue },
            },
          },
        },
        tlsFingerprint: explicitPin,
        auth: { token: "test-probe-token" },
        timeoutMs: 2_000,
        detailLevel: "none",
        env: { OPENCLAW_STATE_DIR: await tempDirs.make("state") },
      });

      await gateway.drain();

      expect(result.ok, result.error ?? undefined).toBe(ok);
      expect(gateway.observed.connectFrames - before.connectFrames).toBe(ok ? 1 : 0);
      if (ok) {
        expect(gateway.observed.receivedBytes).toBeGreaterThan(before.receivedBytes);
        expect(gateway.observed.edgeAuthHeaders.slice(before.edgeAuthHeaders)).toEqual([
          edgeAuthValue,
        ]);
      } else {
        expect.soft(gateway.observed.receivedBytes - before.receivedBytes).toBe(0);
        expect.soft(gateway.observed.edgeAuthHeaders.slice(before.edgeAuthHeaders)).toEqual([]);
      }
      if (error) {
        expect(result.error).toContain(error);
      }
    },
  );
});

import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const adapter = resolve("scripts/e2e/lib/upgrade-survivor/watchos-direct-node.mjs");

function createTlsFixture(root: string) {
  const tlsRoot = join(root, "tls");
  const caKey = join(tlsRoot, "ca-key.pem");
  const caCert = join(tlsRoot, "ca-cert.pem");
  const serverKey = join(tlsRoot, "server-key.pem");
  const serverCsr = join(tlsRoot, "server.csr");
  const serverCert = join(tlsRoot, "server-cert.pem");
  const serverExt = join(tlsRoot, "server.ext");
  mkdirSync(tlsRoot);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "1",
      "-subj",
      "/CN=OpenClaw watchOS survivor test CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-keyout",
      caKey,
      "-out",
      caCert,
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-subj",
      "/CN=localhost",
      "-keyout",
      serverKey,
      "-out",
      serverCsr,
    ],
    { stdio: "ignore" },
  );
  writeFileSync(
    serverExt,
    [
      "basicConstraints=critical,CA:FALSE",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "",
    ].join("\n"),
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      serverCsr,
      "-CA",
      caCert,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-days",
      "1",
      "-sha256",
      "-extfile",
      serverExt,
      "-out",
      serverCert,
    ],
    { stdio: "ignore" },
  );
  return {
    caCert,
    cert: readFileSync(serverCert),
    key: readFileSync(serverKey),
  };
}

function adapterEnv(caCert: string) {
  return { ...process.env, NODE_EXTRA_CA_CERTS: caCert };
}

function signaturePayload(body: Record<string, any>, token: string): string {
  return [
    "v3",
    body.device.id,
    body.client.id,
    body.client.mode,
    body.role,
    body.scopes.join(","),
    String(body.device.signedAt),
    token,
    body.device.nonce,
    body.client.platform.toLowerCase(),
    body.client.deviceFamily.toLowerCase(),
  ].join("|");
}

describe.skipIf(process.platform === "win32")(
  "watchOS direct-node upgrade survivor adapter",
  () => {
    it("bootstraps and reconnects with the exact shipped WatchDirectNode contract", async () => {
      const root = tempDirs.make("watchos-direct-node-");
      const state = join(root, "state.json");
      const setup = join(root, "setup.json");
      const bootstrapArtifact = join(root, "bootstrap.json");
      const reconnectArtifact = join(root, "reconnect.json");
      const tls = createTlsFixture(root);
      const bootstrapToken = "bootstrap-secret";
      const deviceToken = "retained-device-secret";
      const requests: Array<Record<string, any>> = [];
      const pollTokens: string[] = [];
      let challengeCount = 0;
      const server = createServer({ cert: tls.cert, key: tls.key }, (request, response) => {
        if (request.url?.endsWith("/challenge")) {
          challengeCount += 1;
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({ ok: true, nonce: `nonce-${challengeCount}`, ts: Date.now() }),
          );
          return;
        }
        if (request.url?.endsWith("/connect")) {
          let raw = "";
          request.setEncoding("utf8");
          request.on("data", (chunk) => {
            raw += chunk;
          });
          request.on("end", () => {
            const body = JSON.parse(raw);
            requests.push(body);
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify({
                ok: true,
                sessionToken: `session-${requests.length}`,
                deviceToken,
                nodeId: body.device.id,
                protocol: 4,
              }),
            );
          });
          return;
        }
        if (request.url?.endsWith("/poll")) {
          pollTokens.push(request.headers.authorization ?? "");
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ ok: true, event: null }));
          return;
        }
        response.statusCode = 404;
        response.end();
      });
      await new Promise<void>((resolveListen) => {
        server.listen(0, "127.0.0.1", resolveListen);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("failed to bind watch fixture");
      }
      writeFileSync(
        setup,
        JSON.stringify({
          setupCode: `oc-pair://${Buffer.from(
            JSON.stringify({
              url: `wss://localhost:${address.port}`,
              bootstrapToken,
              expiresAtMs: Date.now() + 60_000,
            }),
          ).toString("base64url")}`,
        }),
      );

      try {
        await execFileAsync(
          process.execPath,
          [
            adapter,
            "connect",
            "--mode",
            "bootstrap",
            "--credential",
            setup,
            "--state",
            state,
            "--out",
            bootstrapArtifact,
            "--label",
            "baseline",
          ],
          { env: adapterEnv(tls.caCert) },
        );
        await execFileAsync(
          process.execPath,
          [
            adapter,
            "connect",
            "--mode",
            "device",
            "--state",
            state,
            "--out",
            reconnectArtifact,
            "--label",
            "candidate",
          ],
          { env: adapterEnv(tls.caCert) },
        );
      } finally {
        await new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
        });
      }

      expect(requests).toHaveLength(2);
      expect(pollTokens).toEqual(["Bearer session-1", "Bearer session-2"]);
      const [bootstrap, reconnect] = requests;
      if (!bootstrap || !reconnect) {
        throw new Error("watch fixture omitted bootstrap or reconnect request");
      }
      expect(bootstrap).toMatchObject({
        minProtocol: 4,
        maxProtocol: 4,
        client: {
          id: "openclaw-watchos",
          version: "2026.8.10",
          platform: "watchOS 11.5.0",
          deviceFamily: "Apple Watch",
          mode: "node",
          instanceId: "watchos-upgrade-survivor",
        },
        caps: [],
        commands: ["device.info", "device.status", "system.notify"],
        permissions: { notifications: true },
        role: "node",
        scopes: [],
        auth: { bootstrapToken },
      });
      expect(reconnect).toMatchObject({
        client: { id: "openclaw-watchos", mode: "node", instanceId: "watchos-upgrade-survivor" },
        auth: { deviceToken },
        device: { id: bootstrap.device.id, publicKey: bootstrap.device.publicKey },
      });
      const publicKey = crypto.createPublicKey({
        key: Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"),
          Buffer.from(bootstrap.device.publicKey, "base64url"),
        ]),
        format: "der",
        type: "spki",
      });
      for (const [body, token] of [
        [bootstrap, bootstrapToken],
        [reconnect, deviceToken],
      ] as const) {
        expect(
          crypto.verify(
            null,
            Buffer.from(signaturePayload(body, token)),
            publicKey,
            Buffer.from(body.device.signature, "base64url"),
          ),
        ).toBe(true);
      }
      expect(JSON.parse(readFileSync(state, "utf8"))).toMatchObject({
        deviceId: bootstrap.device.id,
        instanceId: "watchos-upgrade-survivor",
        deviceToken,
        endpoint: {
          host: "localhost",
          port: address.port,
          tls: true,
        },
      });
      for (const [index, artifactPath] of [bootstrapArtifact, reconnectArtifact].entries()) {
        const raw = readFileSync(artifactPath, "utf8");
        expect(raw).not.toContain(bootstrapToken);
        expect(raw).not.toContain(deviceToken);
        expect(raw).not.toContain(`session-${index + 1}`);
        expect(JSON.parse(raw)).toMatchObject({
          ok: true,
          challengeStatus: 200,
          connectStatus: 200,
          pollStatus: 200,
          pollAuthenticated: true,
          transport: "https",
          protocol: 4,
          protocolRange: [4, 4],
          clientId: "openclaw-watchos",
          clientMode: "node",
          instanceId: "watchos-upgrade-survivor",
          endpointSource: index === 0 ? "setupCode" : "persistedState",
        });
      }
    });

    it("asserts online node presence with one paired watch and no pending pairing", async () => {
      const root = tempDirs.make("watchos-direct-node-state-");
      const state = join(root, "state.json");
      const nodes = join(root, "nodes.json");
      const devices = join(root, "devices.json");
      const artifact = join(root, "artifact.json");
      writeFileSync(
        state,
        JSON.stringify({
          deviceId: "watch-device",
          instanceId: "watchos-upgrade-survivor",
        }),
      );
      writeFileSync(
        nodes,
        JSON.stringify({
          nodes: [
            {
              nodeId: "watch-device",
              clientId: "openclaw-watchos",
              clientMode: "node",
            },
          ],
        }),
      );
      writeFileSync(
        devices,
        JSON.stringify({
          pending: [],
          paired: [{ deviceId: "watch-device" }],
        }),
      );

      await execFileAsync(process.execPath, [
        adapter,
        "assert-state",
        "--state",
        state,
        "--nodes",
        nodes,
        "--devices",
        devices,
        "--out",
        artifact,
        "--label",
        "candidate",
      ]);

      expect(JSON.parse(readFileSync(artifact, "utf8"))).toEqual({
        label: "candidate",
        ok: true,
        onlineNode: true,
        pendingTotal: 0,
        pendingForWatch: 0,
        pairedForWatch: 1,
        clientId: "openclaw-watchos",
        clientMode: "node",
        nodeId: "watch-device",
        instanceId: "watchos-upgrade-survivor",
      });
    });

    it("persists a rotated token for the next reconnect without leaking credentials", async () => {
      const root = tempDirs.make("watchos-direct-node-rotation-");
      const state = join(root, "state.json");
      const firstArtifact = join(root, "reconnect-first.json");
      const secondArtifact = join(root, "reconnect-second.json");
      const retainedToken = "retained-device-secret";
      const rotatedToken = "rotated-device-secret";
      const authenticatedTokens: string[] = [];
      const pollTokens: string[] = [];
      const tls = createTlsFixture(root);
      const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
      const publicDer = publicKey.export({ format: "der", type: "spki" });
      const rawPublicKey = Buffer.from(publicDer).subarray(-32);
      const server = createServer({ cert: tls.cert, key: tls.key }, (request, response) => {
        response.setHeader("content-type", "application/json");
        if (request.url?.endsWith("/challenge")) {
          response.end(JSON.stringify({ ok: true, nonce: "rotation-nonce", ts: Date.now() }));
          return;
        }
        if (request.url?.endsWith("/connect")) {
          let raw = "";
          request.setEncoding("utf8");
          request.on("data", (chunk) => {
            raw += chunk;
          });
          request.on("end", () => {
            const body = JSON.parse(raw);
            authenticatedTokens.push(body.auth.deviceToken);
            response.end(
              JSON.stringify({
                ok: true,
                sessionToken: `rotation-session-${authenticatedTokens.length}`,
                deviceToken: rotatedToken,
                nodeId: body.device.id,
                protocol: 4,
              }),
            );
          });
          return;
        }
        if (request.url?.endsWith("/poll")) {
          pollTokens.push(request.headers.authorization ?? "");
          response.end(JSON.stringify({ ok: true, event: null }));
          return;
        }
        response.statusCode = 404;
        response.end();
      });
      await new Promise<void>((resolveListen) => {
        server.listen(0, "127.0.0.1", resolveListen);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("failed to bind watch fixture");
      }
      writeFileSync(
        state,
        JSON.stringify({
          deviceId: crypto.createHash("sha256").update(rawPublicKey).digest("hex"),
          publicKey: rawPublicKey.toString("base64url"),
          privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
          instanceId: "watchos-upgrade-survivor",
          deviceToken: retainedToken,
          endpoint: { host: "localhost", port: address.port, tls: true },
        }),
      );

      try {
        await execFileAsync(
          process.execPath,
          [
            adapter,
            "connect",
            "--mode",
            "device",
            "--state",
            state,
            "--out",
            firstArtifact,
            "--label",
            "candidate",
          ],
          { env: adapterEnv(tls.caCert) },
        );
        await execFileAsync(
          process.execPath,
          [
            adapter,
            "connect",
            "--mode",
            "device",
            "--state",
            state,
            "--out",
            secondArtifact,
            "--label",
            "restart",
          ],
          { env: adapterEnv(tls.caCert) },
        );
      } finally {
        await new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
        });
      }

      expect(authenticatedTokens).toEqual([retainedToken, rotatedToken]);
      expect(pollTokens).toEqual(["Bearer rotation-session-1", "Bearer rotation-session-2"]);
      expect(JSON.parse(readFileSync(state, "utf8"))).toMatchObject({
        deviceToken: rotatedToken,
      });
      for (const [index, artifactPath] of [firstArtifact, secondArtifact].entries()) {
        const raw = readFileSync(artifactPath, "utf8");
        expect(raw).not.toContain(retainedToken);
        expect(raw).not.toContain(rotatedToken);
        expect(raw).not.toContain(`rotation-session-${index + 1}`);
        expect(JSON.parse(raw)).toMatchObject({
          pollStatus: 200,
          pollAuthenticated: true,
          transport: "https",
          endpointSource: "persistedState",
        });
      }
    });
  },
);

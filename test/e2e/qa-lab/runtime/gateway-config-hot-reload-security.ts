// Real listener, signed clients, and config RPCs exercise live security policy publication.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import WebSocket from "ws";
import { createQaGatewayChild, type QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { PROTOCOL_VERSION, type HelloOk } from "../../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { GatewayClient, type GatewayClientOptions } from "../../../../src/gateway/client.js";
import { buildDeviceAuthPayloadV3 } from "../../../../src/gateway/device-auth.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../../../../src/infra/device-identity.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { waitForHotReloadFact } from "./gateway-config-hot-reload-fixtures.js";

const ORIGIN = "https://security.example.test";
const RETAINED_ORIGIN = "https://retained.example.test";
const SCOPES = ["operator.admin", "operator.read", "operator.write", "operator.pairing"];
type Connection = { client: GatewayClient; hello: HelloOk; closes: number };
type ConfigAck = { sentinel: { payload: { stats: { requiresRestart: boolean } } } };
type ConfigSnapshot = { hash: string; config: OpenClawConfig };
type Evidence = { prefix: string; observation: string; bootId: string; pid: number };

export async function proveHotReloadSecurity({
  repoRoot,
  outputDir,
  appendLog,
}: {
  repoRoot: string;
  outputDir: string;
  appendLog: (text: string) => void;
}) {
  const owner = createQaGatewayChild();
  const clients: GatewayClient[] = [];
  const sockets: WebSocket[] = [];
  const evidence: Evidence[] = [];
  const failures: Array<{ prefix: string; message: string }> = [];
  let gateway: QaGatewayChild | undefined;
  let startupOnlyControl:
    | { prefix: string; originalBootId: string; replacementBootId: string }
    | undefined;
  await runQaGatewayFixture(
    async () => {
      gateway = await owner.start({
        repoRoot,
        useRepoCli: true,
        command: {
          executablePath: process.execPath,
          argsPrefix: [path.join(repoRoot, "dist/index.js")],
          argsSuffix: ["--bind", "lan"],
          cwd: repoRoot,
          usePackagedPlugins: true,
        },
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        providerBaseUrl: "http://127.0.0.1:1/v1",
        transportBaseUrl: "http://127.0.0.1:1",
        controlUiEnabled: true,
        runtimeEnvPatch: {
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_GATEWAY_PASSWORD: undefined,
        },
        mutateConfig: (cfg) => ({
          ...cfg,
          gateway: {
            ...cfg.gateway,
            bind: "lan",
            reload: { mode: "hybrid" },
            nodes: { pairing: { autoApproveLocal: true, sshVerify: false } },
            controlUi: { ...cfg.gateway?.controlUi, allowedOrigins: [ORIGIN, RETAINED_ORIGIN] },
          },
        }),
      });
      const active = gateway;
      const pid = active.pid;
      assert(pid);
      const identity = (name: string) =>
        loadOrCreateDeviceIdentity({
          path: path.join(active.tempRoot, "proof-identities.sqlite"),
          identityKey: name,
        });
      const connect = async (options: Partial<GatewayClientOptions> = {}): Promise<Connection> =>
        await new Promise((resolve, reject) => {
          let settled = false;
          let connection: Connection | undefined;
          const finish = (error?: Error) => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timeout);
            if (error) {
              client.stop();
              reject(error);
            } else {
              assert(connection);
              resolve(connection);
            }
          };
          const client = new GatewayClient({
            url: active.wsUrl,
            env: active.runtimeEnv,
            deviceIdentity: null,
            clientName: "gateway-client",
            mode: "backend",
            platform: process.platform,
            clientVersion: "1.0.0",
            role: "operator",
            scopes: SCOPES,
            hostDeps: {
              loadDeviceAuthToken: () => null,
              storeDeviceAuthToken: () => {},
              clearDeviceAuthToken: () => {},
            },
            ...options,
            onHelloOk: (hello) => {
              connection = { client, hello, closes: 0 };
              finish();
            },
            onConnectError: (error) => finish(error),
            onClose: (code, reason) => {
              if (connection) {
                connection.closes += 1;
              }
              client.stop();
              finish(new Error(`Security proof connection closed: ${code} ${reason}`));
            },
          });
          clients.push(client);
          const timeout = setTimeout(
            () => finish(new Error("Security proof connect timed out")),
            20_000,
          );
          timeout.unref();
          client.start();
        });
      const request = async <T>(
        connection: Connection,
        method: string,
        params: unknown = {},
      ): Promise<T> => {
        try {
          return await connection.client.request<T>(method, params, { timeoutMs: 40_000 });
        } catch (error) {
          const failure = error as { retryable?: boolean; retryAfterMs?: number; message?: string };
          if (
            !failure.retryable ||
            typeof failure.retryAfterMs !== "number" ||
            !failure.message?.startsWith(`rate limit exceeded for ${method}`)
          ) {
            throw error;
          }
          await delay(failure.retryAfterMs);
          return await connection.client.request<T>(method, params, { timeoutMs: 40_000 });
        }
      };
      const controllerIdentity = identity("independent-controller");
      const enrolled = await connect({
        token: active.token,
        deviceIdentity: controllerIdentity,
        clientName: "openclaw-tui",
        mode: "ui",
      });
      const controllerToken = enrolled.hello.auth?.deviceToken;
      assert(controllerToken, "Signed native client must receive an independent device token");
      await enrolled.client.stopAndWait();
      const connectController = () =>
        connect({
          deviceToken: controllerToken,
          deviceIdentity: controllerIdentity,
          clientName: "openclaw-tui",
          mode: "ui",
        });
      let controller = await connectController();
      const initialBootId = controller.hello.server.bootId;
      assert(initialBootId);
      let bootId = initialBootId;
      const write = async (
        change: unknown,
        writer = controller,
        method: "config.patch" | "config.apply" = "config.patch",
      ) => {
        const snapshot = await request<ConfigSnapshot>(writer, "config.get");
        return await request<ConfigAck>(writer, method, {
          baseHash: snapshot.hash,
          raw: JSON.stringify(change),
          replacePaths:
            method === "config.patch" ? ["gateway.controlUi.allowedOrigins"] : undefined,
        });
      };
      const patch = async (change: unknown) => {
        const result = await write(change);
        assert.equal(result.sentinel.payload.stats.requiresRestart, false);
      };
      const continuity = async () => {
        assert.equal(active.pid, pid);
        assert.equal(controller.closes, 0, "Independent device token client was disconnected");
        await request(controller, "health");
        const fresh = await connectController();
        assert.equal(
          fresh.hello.server.bootId,
          bootId,
          "Gateway restarted inside its original PID",
        );
        await fresh.client.stopAndWait();
      };
      const record = async (prefix: string, observation: string) => {
        await continuity();
        evidence.push({ prefix, observation, bootId, pid });
        appendLog(`PASS security ${prefix}: ${observation}; PID ${pid}, boot ${bootId}\n`);
      };
      const group = async (prefix: string, run: () => Promise<void>) => {
        try {
          await run();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ prefix, message });
          appendLog(`FAIL security ${prefix}: ${message}\n`);
        }
      };
      const browser = (
        origin: string,
        name: string,
        credential: { token?: string; password?: string; deviceToken?: string },
      ) =>
        connect({
          ...credential,
          origin,
          deviceIdentity: identity(name),
          clientName: "openclaw-control-ui",
          mode: "webchat",
        });
      await group("gateway.controlUi.allowedOrigins", async () => {
        const revoked = await browser(ORIGIN, "revoked-browser", { token: active.token });
        const retained = await browser(RETAINED_ORIGIN, "retained-browser", {
          token: active.token,
        });
        let writerError: unknown;
        try {
          const response = await write(
            { gateway: { controlUi: { allowedOrigins: [RETAINED_ORIGIN] } } },
            revoked,
          );
          assert.equal(response.sentinel.payload.stats.requiresRestart, false);
        } catch (error) {
          writerError = error;
        }
        await waitForHotReloadFact("revoked browser socket closure", () =>
          revoked.closes ? true : undefined,
        );
        await assert.rejects(
          browser(ORIGIN, "denied-browser", { token: active.token }),
          /origin not allowed/,
        );
        assert.equal(retained.closes, 0);
        await request(retained, "health");
        await patch({ gateway: { controlUi: { allowedOrigins: [ORIGIN, RETAINED_ORIGIN] } } });
        await browser(ORIGIN, "revoked-browser", { token: active.token });
        if (writerError) {
          throw new Error("Origin self-revocation failed to acknowledge its writer", {
            cause: writerError,
          });
        }
        await record(
          "gateway.controlUi.allowedOrigins",
          "The writer received success before its origin was evicted; another origin stayed connected, fresh forbidden connects failed, and restoration admitted the same signed identity",
        );
      });
      await group("gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback", async () => {
        const fallbackOrigin = "https://fallback.example.test";
        const fallbackIdentity = identity("fallback-browser");
        const connectFallback = () =>
          new Promise<{ socket: WebSocket; hello: HelloOk; closed: () => boolean }>(
            (resolve, reject) => {
              const socket = new WebSocket(active.wsUrl, {
                origin: fallbackOrigin,
                headers: { Host: "fallback.example.test" },
              });
              sockets.push(socket);
              let closed = false;
              let settled = false;
              const timer = setTimeout(() => {
                socket.terminate();
                reject(new Error("Fallback-origin connect timed out"));
              }, 20_000);
              const fail = (error: Error) => {
                clearTimeout(timer);
                socket.terminate();
                settled = true;
                reject(error);
              };
              socket.on("error", fail);
              socket.on("close", () => {
                closed = true;
                clearTimeout(timer);
                if (!settled) {
                  reject(new Error("Fallback-origin socket closed before hello"));
                }
              });
              socket.on("message", (data) => {
                const frame = JSON.parse(rawDataToString(data)) as {
                  type: string;
                  event?: string;
                  payload?: HelloOk & { nonce?: string };
                  ok?: boolean;
                  error?: { message: string };
                };
                if (frame.event === "connect.challenge") {
                  const signedAt = Date.now();
                  const nonce = frame.payload?.nonce;
                  assert(nonce);
                  const payload = buildDeviceAuthPayloadV3({
                    deviceId: fallbackIdentity.deviceId,
                    clientId: "openclaw-control-ui",
                    clientMode: "webchat",
                    role: "operator",
                    scopes: SCOPES,
                    signedAtMs: signedAt,
                    token: active.token,
                    nonce,
                    platform: process.platform,
                  });
                  socket.send(
                    JSON.stringify({
                      type: "req",
                      id: "connect",
                      method: "connect",
                      params: {
                        minProtocol: PROTOCOL_VERSION,
                        maxProtocol: PROTOCOL_VERSION,
                        client: {
                          id: "openclaw-control-ui",
                          mode: "webchat",
                          version: "1.0.0",
                          platform: process.platform,
                        },
                        role: "operator",
                        scopes: SCOPES,
                        auth: { token: active.token },
                        device: {
                          id: fallbackIdentity.deviceId,
                          publicKey: publicKeyRawBase64UrlFromPem(fallbackIdentity.publicKeyPem),
                          signedAt,
                          nonce,
                          signature: signDevicePayload(fallbackIdentity.privateKeyPem, payload),
                        },
                      },
                    }),
                  );
                } else if (frame.type === "res") {
                  clearTimeout(timer);
                  if (!frame.ok) {
                    fail(new Error(frame.error?.message ?? "Fallback-origin connect rejected"));
                  } else {
                    assert(frame.payload);
                    settled = true;
                    resolve({ socket, hello: frame.payload, closed: () => closed });
                  }
                }
              });
            },
          );
        // Pair this exact identity while its origin is explicitly allowed; Host spoofing is not locality.
        await patch({
          gateway: { controlUi: { allowedOrigins: [ORIGIN, RETAINED_ORIGIN, fallbackOrigin] } },
        });
        await browser(fallbackOrigin, "fallback-browser", { token: active.token });
        await patch({
          gateway: {
            controlUi: {
              allowedOrigins: [ORIGIN, RETAINED_ORIGIN],
              dangerouslyAllowHostHeaderOriginFallback: true,
            },
          },
        });
        const accepted = await connectFallback();
        assert.equal(accepted.hello.server.bootId, bootId);
        await patch({
          gateway: { controlUi: { dangerouslyAllowHostHeaderOriginFallback: false } },
        });
        await waitForHotReloadFact("Host-fallback socket closure", () =>
          accepted.closed() ? true : undefined,
        );
        await assert.rejects(connectFallback(), /origin not allowed/);
        await patch({ gateway: { controlUi: { dangerouslyAllowHostHeaderOriginFallback: true } } });
        (await connectFallback()).socket.close();
        await patch({
          gateway: { controlUi: { dangerouslyAllowHostHeaderOriginFallback: false } },
        });
        await record(
          "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback",
          "An actual WS upgrade with public synthetic Host/Origin was admitted, evicted/rejected after disable, and admitted after re-enable",
        );
      });
      await group("invalid hot security policy", async () => {
        const before = await fs.readFile(active.configPath, "utf8");
        await runQaGatewayFixture(
          async () => {
            for (const change of [
              {
                gateway: {
                  controlUi: {
                    allowedOrigins: [],
                    dangerouslyAllowHostHeaderOriginFallback: false,
                  },
                },
              },
              { gateway: { auth: { token: "" } } },
            ]) {
              await assert.rejects(
                write(change),
                /non-loopback Control UI requires|no token|token.*configured|token.*required/i,
              );
              assert.equal(
                (await fs.readFile(active.configPath, "utf8")) === before,
                true,
                "Invalid hot policy changed persisted bytes",
              );
            }
          },
          async () => {
            if ((await fs.readFile(active.configPath, "utf8")) !== before) {
              appendLog("Restoring security fixture after an invalid policy persisted\n");
              await write(JSON.parse(before), controller, "config.apply");
            }
          },
        );
        await record(
          "invalid hot security policy",
          "Removing all LAN UI origin admission and emptying the active credential were rejected before writing; existing sessions remained usable",
        );
      });
      let credential = active.token;
      const rotate = async (
        mode: "token" | "password",
        method: "config.patch" | "config.apply",
      ) => {
        const oldCredential = credential;
        const auth = { [mode]: oldCredential };
        const writer = await connect(auth);
        const stale = await connect(auth);
        const browserName = `${mode}-${method}-cached`;
        const browserShared = await browser(ORIGIN, browserName, auth);
        const cachedToken = browserShared.hello.auth?.deviceToken;
        assert(cachedToken);
        await browserShared.client.stopAndWait();
        const cached = await browser(ORIGIN, browserName, { deviceToken: cachedToken });
        const nextCredential = randomUUID();
        const authored = JSON.parse(await fs.readFile(active.configPath, "utf8")) as OpenClawConfig;
        assert(authored.gateway?.auth);
        authored.gateway.auth[mode] = nextCredential;
        const change =
          method === "config.apply" ? authored : { gateway: { auth: { [mode]: nextCredential } } };
        let writerError: unknown;
        try {
          const result = await write(change, writer, method);
          assert.equal(result.sentinel.payload.stats.requiresRestart, false);
        } catch (error) {
          writerError = error;
        }
        await waitForHotReloadFact("new shared credential publication", async () => {
          try {
            return await connect({ [mode]: nextCredential });
          } catch (error) {
            if (/unauthorized|gateway starting|closed before hello/i.test(String(error))) {
              return undefined;
            }
            throw error;
          }
        });
        credential = nextCredential;
        await waitForHotReloadFact("stale shared clients evicted", () =>
          stale.closes && cached.closes ? true : undefined,
        );
        await assert.rejects(connect({ [mode]: oldCredential }), /unauthorized|auth changed/i);
        await assert.rejects(
          browser(ORIGIN, browserName, { deviceToken: cachedToken }),
          /unauthorized|token|auth changed/i,
        );
        await continuity();
        if (writerError) {
          appendLog(
            `FAIL security writer outcome ${mode}/${method}: ${writerError instanceof Error ? writerError.message : "unknown RPC failure"}\n`,
          );
          throw new Error(
            `${mode} rotation via ${method} changed policy but failed to acknowledge the shared-credential writer`,
            { cause: writerError },
          );
        }
        await record(
          `gateway.auth.${mode} (${method})`,
          "Shared writer received success; old shared and browser-issued device tokens were rejected/evicted, new credentials worked, and independent device token stayed connected",
        );
      };
      for (const method of ["config.patch", "config.apply"] as const) {
        await group(`gateway.auth.token (${method})`, () => rotate("token", method));
      }
      const originalBootId = bootId;
      credential = randomUUID();
      const modeChange = await write({
        gateway: { auth: { mode: "password", password: credential } },
      });
      assert.equal(modeChange.sentinel.payload.stats.requiresRestart, true);
      await waitForHotReloadFact("auth mode change closes old socket", () =>
        controller.closes ? true : undefined,
      );
      controller = await waitForHotReloadFact(
        "auth mode replacement boot",
        async () => {
          try {
            const candidate = await connectController();
            if (candidate.hello.server.bootId !== originalBootId) {
              return candidate;
            }
            await candidate.client.stopAndWait();
            return undefined;
          } catch (error) {
            if (/starting|closed|ECONNREFUSED/i.test(String(error))) {
              return undefined;
            }
            throw error;
          }
        },
        60_000,
      );
      const replacementBootId = controller.hello.server.bootId;
      assert(replacementBootId && replacementBootId !== originalBootId);
      bootId = replacementBootId;
      startupOnlyControl = {
        prefix: "gateway.auth.mode",
        originalBootId,
        replacementBootId: bootId,
      };
      for (const method of ["config.patch", "config.apply"] as const) {
        await group(`gateway.auth.password (${method})`, () => rotate("password", method));
      }
    },
    () => {
      if (gateway) {
        appendLog(gateway.logs());
      }
    },
    async () => {
      sockets.forEach((socket) => socket.terminate());
      await Promise.all(clients.map((client) => client.stopAndWait({ timeoutMs: 2_000 })));
    },
    () => stopQaGatewayFixture(owner),
  );
  const summary = { passed: failures.length === 0, evidence, failures, startupOnlyControl };
  await fs.writeFile(
    path.join(outputDir, "gateway-config-hot-reload-security.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  return summary;
}

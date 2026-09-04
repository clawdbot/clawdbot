import { once } from "node:events";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { ConnectParams } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayAuthConfig } from "../../config/types.gateway.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../../gateway/minimal-gateway.test-helpers.js";
import {
  evaluateMissingDeviceIdentity,
  shouldClearUnboundScopesForMissingDeviceIdentity,
} from "../../gateway/server/ws-connection/connect-policy.js";
import {
  shouldPreserveLocalCliSharedAuthScopes,
  shouldSkipLocalBackendSelfPairing,
} from "../../gateway/server/ws-connection/handshake-auth-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { waitForGatewayHealthyRestart } from "./restart-health.js";

// Exercise the real client over a socket and apply the Gateway's actual identity
// predicates, so a diagnostic client cannot accidentally stand in for local control.
describe("restart verifier local control identity", () => {
  it.each(["token", "password", "none"] as const)(
    "reads health and served identity with %s auth without creating device state",
    async (mode) => {
      await withOpenClawTestState(
        {
          env: {
            OPENCLAW_GATEWAY_TOKEN: undefined,
            OPENCLAW_GATEWAY_PASSWORD: undefined,
            OPENCLAW_GATEWAY_URL: "wss://remote.example.invalid",
          },
        },
        async (state) => {
          const auth: GatewayAuthConfig =
            mode === "none" ? { mode } : { mode, [mode]: "fixture-restart-secret" };
          const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
          await once(gateway, "listening");
          const port = (gateway.address() as AddressInfo).port;
          const requests: string[] = [];
          const failures: string[] = [];
          const connections: ConnectParams[] = [];
          gateway.on("connection", (socket) => {
            let scopes: string[] = [];
            sendMinimalGatewayConnectChallenge(socket);
            socket.on("message", (data) => {
              const request = parseMinimalGatewayRequestFrame(data);
              if (request.type !== "req" || !request.id || !request.method) {
                return;
              }
              requests.push(request.method);
              const reject = (message: string) => {
                failures.push(message);
                socket.send(
                  JSON.stringify({
                    type: "res",
                    id: request.id,
                    ok: false,
                    error: { code: "FORBIDDEN", message },
                  }),
                );
              };
              if (request.method === "connect") {
                const connect = request.params as ConnectParams;
                connections.push(connect);
                const sharedAuthOk =
                  mode !== "none" && connect.auth?.[mode] === "fixture-restart-secret";
                const policy = {
                  connectParams: connect,
                  locality: "direct_local" as const,
                  hasBrowserOriginHeader: false,
                  sharedAuthOk,
                  authMethod: mode,
                };
                const backend = shouldSkipLocalBackendSelfPairing(policy);
                const decision = evaluateMissingDeviceIdentity({
                  hasDeviceIdentity: Boolean(connect.device),
                  role: "operator",
                  isControlUi: false,
                  localBackendSelfPairingOk: backend,
                  sharedAuthOk,
                  authOk: mode === "none" || sharedAuthOk,
                  hasSharedAuth: mode !== "none",
                  isLocalClient: true,
                });
                if (decision.kind !== "allow") {
                  reject("device identity required");
                  socket.close(1008, "device identity required");
                  return;
                }
                const clearScopes =
                  !backend &&
                  !shouldPreserveLocalCliSharedAuthScopes(policy) &&
                  shouldClearUnboundScopesForMissingDeviceIdentity({ decision, authMethod: mode });
                scopes = clearScopes ? [] : (connect.scopes ?? []);
                const hello = buildMinimalGatewayHelloOkPayload({
                  auth: { role: "operator", scopes },
                });
                sendMinimalGatewayResponse(socket, request.id, {
                  ...hello,
                  server: { ...hello.server, version: "2026.8.1", buildId: "fixture-build" },
                });
                return;
              }
              if (request.method !== "health" && !scopes.includes("operator.read")) {
                reject("missing scope: operator.read");
                return;
              }
              sendMinimalGatewayResponse(socket, request.id, {
                ok: true,
                plugins: {
                  errors: [
                    {
                      id: "fixture-plugin",
                      origin: "bundled",
                      activated: true,
                      error: "fixture load failure",
                    },
                  ],
                },
                channels: { fixture: { probe: { ok: false, error: "fixture channel failure" } } },
              });
            });
          });
          await state.writeConfig({
            gateway: {
              mode: "remote",
              remote: {
                url: "wss://remote.example.invalid",
                token: "fixture-peer-token",
                password: "fixture-peer-password",
              },
              auth,
            },
          });
          const service = createMockGatewayService({
            readRuntime: async () => ({ status: "running", pid: process.pid }),
          });
          const before = await fs.readdir(state.stateDir, { recursive: true });
          try {
            const result = await waitForGatewayHealthyRestart({
              service,
              port,
              env: state.env,
              probeHosts: ["127.0.0.1"],
              expectedVersion: "2026.8.1",
              expectedBuildId: "fixture-build",
              attempts: 0,
              delayMs: 1,
            });
            expect(result).toMatchObject({
              healthy: false,
              waitOutcome: "plugin-errors",
              gatewayVersion: "2026.8.1",
              gatewayBuildId: "fixture-build",
              activatedPluginErrors: [{ id: "fixture-plugin", error: "fixture load failure" }],
              channelProbeErrors: [{ id: "fixture", error: "fixture channel failure" }],
            });
            expect(failures).toEqual([]);
            expect(requests).toEqual(["connect", "health"]);
            expect(connections).toHaveLength(1);
            expect(connections[0]?.device).toBeUndefined();
            expect(connections[0]?.auth).toEqual(
              mode === "none" ? undefined : { [mode]: "fixture-restart-secret" },
            );
            expect(connections[0]?.client).toMatchObject(
              mode === "none"
                ? { id: "gateway-client", mode: "backend" }
                : { id: "cli", mode: "cli" },
            );
            expect(connections[0]?.scopes).toEqual(["operator.read"]);
            expect(await fs.readdir(state.stateDir, { recursive: true })).toEqual(before);
          } finally {
            await closeMinimalGatewayServer(gateway);
          }
        },
      );
    },
  );
});

// Exercise named-role ceilings through real HTTP auth and plugin runtime dispatch.
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { authorizeOperatorScopesForMethod, CLI_DEFAULT_OPERATOR_SCOPES } from "./method-scopes.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";
import { attachGatewayUpgradeHandler } from "./server-http-upgrades.js";
import { createRequest, createTestGatewayServer, sendRequest } from "./server-http.test-harness.js";
import { createGatewayTestRegistry } from "./server/__tests__/test-utils.js";
import {
  createGatewayPluginRequestHandler,
  createGatewayPluginUpgradeHandler,
  shouldEnforceGatewayAuthForPluginPath,
} from "./server/plugins-http.js";
import { createPreauthConnectionBudget } from "./server/preauth-connection-budget.js";
import { withTempConfig } from "./test-temp-config.js";

const routePath = "/role-scoped-plugin";
const proxyAddress = "203.0.113.10";
const proxyAuth = {
  mode: "trusted-proxy",
  allowTailscale: false,
  trustedProxy: { userHeader: "x-forwarded-user" },
} as const;
const roleCases: Array<{
  role: string;
  scopes: GatewayOperatorRoleDefinition["scopes"];
  writeDefault: string[];
  trustedDefault: string[];
  declaredRead: string[];
}> = [
  { role: "empty", scopes: [], writeDefault: [], trustedDefault: [], declaredRead: [] },
  {
    role: "reader",
    scopes: ["operator.read"],
    writeDefault: [],
    trustedDefault: ["operator.read"],
    declaredRead: ["operator.read"],
  },
  {
    role: "writer",
    scopes: ["operator.write"],
    writeDefault: ["operator.write"],
    trustedDefault: ["operator.read", "operator.write"],
    declaredRead: ["operator.read"],
  },
  {
    role: "admin",
    scopes: ["operator.admin"],
    writeDefault: ["operator.write"],
    trustedDefault: [...CLI_DEFAULT_OPERATOR_SCOPES],
    declaredRead: ["operator.read"],
  },
];

function observeRuntimeScope() {
  const client = getPluginRuntimeGatewayRequestScope()?.client;
  const scopes = client?.connect?.scopes;
  return {
    scopes,
    profileId: client?.authenticatedUserProfile?.profileId,
    writeAllowed: authorizeOperatorScopesForMethod("node.invoke", scopes ?? []).allowed,
  };
}

async function dispatchPluginUpgrade(
  server: ReturnType<typeof createTestGatewayServer>,
  req: IncomingMessage,
): Promise<string> {
  const socket = new PassThrough();
  let body = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    body += chunk;
  });
  const closed = once(socket, "close");
  try {
    server.emit("upgrade", req, socket, Buffer.alloc(0));
    await closed;
    return body;
  } finally {
    socket.destroy();
  }
}

describe.each(["write-default", "trusted-operator"] as const)(
  "plugin %s named-role ceiling",
  (surface) => {
    it.each(roleCases)("caps HTTP and upgrade runtime clients for $role", async (roleCase) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const email = "plugin-role@example.test";
        const profile = ensureProfileForEmail(email);
        setUserProfileRole(profile.id, roleCase.role);
        const cfg: OpenClawConfig = {
          gateway: {
            trustedProxies: [proxyAddress],
            auth: proxyAuth,
            roles: {
              default: "denied",
              definitions: {
                denied: { sessions: { others: "none" }, agents: [], scopes: [] },
                [roleCase.role]: {
                  sessions: { others: "view" },
                  agents: "*",
                  scopes: roleCase.scopes,
                },
              },
            },
          },
        };
        const registry = createGatewayTestRegistry({
          httpRoutes: [
            {
              pluginId: "role-scoped-plugin",
              source: "role-scoped-plugin",
              path: routePath,
              auth: "gateway",
              match: "exact",
              gatewayRuntimeScopeSurface: surface,
              handler: async (_req: IncomingMessage, res: ServerResponse) => {
                res.end(JSON.stringify(observeRuntimeScope()));
                return true;
              },
              handleUpgrade: async (_req, socket) => {
                socket.end(JSON.stringify(observeRuntimeScope()));
                return true;
              },
            },
          ],
        });
        const log = createSubsystemLogger("test/plugin-role-scopes");
        const shouldEnforcePluginGatewayAuth = (
          pathContext: Parameters<typeof shouldEnforceGatewayAuthForPluginPath>[1],
        ) => shouldEnforceGatewayAuthForPluginPath(registry, pathContext);
        const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PREAUTH_PAYLOAD_BYTES });
        try {
          await withTempConfig({
            cfg,
            run: async () => {
              const server = createTestGatewayServer({
                resolvedAuth: proxyAuth,
                overrides: {
                  handlePluginRequest: createGatewayPluginRequestHandler({ registry, log }),
                  shouldEnforcePluginGatewayAuth,
                },
              });
              attachGatewayUpgradeHandler({
                httpServer: server,
                wss,
                handlePluginUpgrade: createGatewayPluginUpgradeHandler({ registry, log }),
                shouldEnforcePluginGatewayAuth,
                clients: new Set(),
                preauthConnectionBudget: createPreauthConnectionBudget(),
                resolvedAuth: proxyAuth,
              });
              const defaultScopes =
                surface === "write-default" ? roleCase.writeDefault : roleCase.trustedDefault;
              for (const [header, expectedScopes] of [
                [undefined, defaultScopes],
                ["operator.read", roleCase.declaredRead],
                ["", []],
              ] as const) {
                const request = {
                  path: routePath,
                  remoteAddress: proxyAddress,
                  headers: {
                    "x-forwarded-user": email,
                    "x-forwarded-for": "198.51.100.20",
                    ...(header === undefined ? {} : { "x-openclaw-scopes": header }),
                  },
                };
                const expected = {
                  scopes: expectedScopes,
                  profileId: profile.id,
                  writeAllowed: expectedScopes.some(
                    (scope) => scope === "operator.write" || scope === "operator.admin",
                  ),
                };
                const response = await sendRequest(server, request);
                expect(response.res.statusCode).toBe(200);
                expect
                  .soft(JSON.parse(response.getBody()), `HTTP header=${header}`)
                  .toEqual(expected);
                const upgraded = await dispatchPluginUpgrade(
                  server,
                  createRequest({
                    ...request,
                    headers: { ...request.headers, connection: "upgrade", upgrade: "websocket" },
                  }),
                );
                expect.soft(JSON.parse(upgraded), `upgrade header=${header}`).toEqual(expected);
              }
            },
          });
        } finally {
          wss.close();
          invalidateOperatorRolePolicy(profile.id);
        }
      });
    });
  },
);

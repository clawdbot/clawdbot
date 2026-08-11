// Server HTTP probe tests cover readiness, health, disabled compat routes, and
// auth handling through the in-memory HTTP harness.
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import nodePath from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  prepareGatewaySuspend,
  resumeGatewaySuspend,
} from "../infra/gateway-suspend-coordinator.js";
import { isGatewayDraining } from "../process/command-queue.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import type { ChannelManager } from "./server-channels.js";
import {
  AUTH_TOKEN,
  AUTH_NONE,
  createRequest,
  createResponse,
  dispatchRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";
import { createReadinessChecker, type ReadinessChecker } from "./server/readiness.js";
import { withTempConfig } from "./test-temp-config.js";

type GatewayServerHarness = Parameters<typeof dispatchRequest>[0];
type GatewayRequestOptions = Parameters<typeof createRequest>[0];

async function sendGatewayRequest(server: GatewayServerHarness, options: GatewayRequestOptions) {
  const req = createRequest(options);
  const { res, getBody } = createResponse();
  await dispatchRequest(server, req, res);
  return { res, getBody };
}

async function withMarkedControlUiRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), "openclaw-http-routing-"));
  try {
    await fs.writeFile(nodePath.join(root, "index.html"), "<html>spa fallback</html>\n");
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("gateway OpenAI-compatible disabled HTTP routes", () => {
  it("returns 404 when compat endpoints are disabled", async () => {
    await withGatewayServer({
      prefix: "openai-compat-disabled",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        for (const path of ["/v1/chat/completions", "/v1/responses"]) {
          const { res, getBody } = await sendGatewayRequest(server, {
            path,
            method: "POST",
            headers: { "content-type": "application/json" },
          });

          expect(res.statusCode, path).toBe(404);
          expect(getBody(), path).toBe("Not Found");
        }
      },
    });
  });

  it("returns 404 for disabled GET routes when the Control UI is root-mounted", async () => {
    await withGatewayServer({
      prefix: "openai-compat-disabled-root-control-ui",
      resolvedAuth: AUTH_NONE,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: "",
      },
      run: async (server) => {
        for (const path of [
          "/v1",
          "/v1/",
          "/v1/models",
          "/v1/models/openclaw",
          "/v1/chat/completions",
          "/v1/responses",
          "/v1/embeddings",
        ]) {
          const { res, getBody } = await sendGatewayRequest(server, {
            path,
            method: "GET",
          });

          expect(res.statusCode, path).toBe(404);
          expect(getBody(), path).toBe("Not Found");
        }
      },
    });
  });

  it.each([
    { name: "chat completions", enabled: { openAiChatCompletionsEnabled: true } },
    { name: "responses", enabled: { openResponsesEnabled: true } },
  ])("keeps $name model discovery ahead of a root-mounted Control UI", async ({ enabled }) => {
    await withGatewayServer({
      prefix: "openai-compat-enabled-root-control-ui",
      resolvedAuth: AUTH_NONE,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: "",
        ...enabled,
      },
      run: async (server) => {
        const { res, getBody } = await sendGatewayRequest(server, {
          path: "/v1/models",
          method: "GET",
          headers: { "x-openclaw-scopes": "operator.read" },
        });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(getBody())).toMatchObject({
          object: "list",
          data: expect.arrayContaining([expect.objectContaining({ id: "openclaw/default" })]),
        });
      },
    });
  });
});

describe("startup plugin HTTP routing", () => {
  it("keeps unclaimed webhook POSTs outside the root Control UI SPA", async () => {
    await withMarkedControlUiRoot(async (controlUiRoot) => {
      let sidecarsReady = false;
      const handlePluginRequest = vi.fn(async () => false);
      await withGatewayServer({
        prefix: "startup-plugin-post-root-control-ui",
        resolvedAuth: AUTH_NONE,
        overrides: {
          controlUiEnabled: true,
          controlUiBasePath: "",
          controlUiRoot: { kind: "resolved", path: controlUiRoot },
          handlePluginRequest,
          shouldEnforcePluginGatewayAuth: () => false,
          isStartupPluginRuntimeReady: () => sidecarsReady,
        },
        run: async (server) => {
          const request = {
            path: "/slack/events",
            method: "POST",
            headers: { accept: "text/html" },
          };
          const starting = createResponse();
          await dispatchRequest(server, createRequest(request), starting.res);

          expect(starting.res.statusCode).toBe(503);
          expect(starting.setHeader).toHaveBeenCalledWith("Retry-After", "1");
          expect(starting.getBody()).toBe("Plugin runtime is starting");

          sidecarsReady = true;
          const ready = createResponse();
          await dispatchRequest(server, createRequest(request), ready.res);

          expect(ready.res.statusCode).toBe(404);
          expect(ready.setHeader).toHaveBeenCalledWith("Content-Type", "text/plain; charset=utf-8");
          expect(ready.getBody()).toBe("Not Found");
          expect(handlePluginRequest).toHaveBeenCalledTimes(2);
        },
      });
    });
  });

  it("uses Accept to route only the unclaimed Control UI SPA fallback", async () => {
    await withMarkedControlUiRoot(async (controlUiRoot) => {
      let sidecarsReady = false;
      await withGatewayServer({
        prefix: "startup-plugin-get-accept-root-control-ui",
        resolvedAuth: AUTH_NONE,
        overrides: {
          controlUiEnabled: true,
          controlUiBasePath: "",
          controlUiRoot: { kind: "resolved", path: controlUiRoot },
          handlePluginRequest: async () => false,
          shouldEnforcePluginGatewayAuth: () => false,
          isStartupPluginRuntimeReady: () => sidecarsReady,
        },
        run: async (server) => {
          const htmlCases = [
            {
              name: "browser",
              accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
            { name: "bare curl", accept: "*/*" },
            { name: "missing header", accept: undefined },
            { name: "empty header", accept: "" },
            { name: "rejected HTML with wildcard", accept: "text/html;q=0, */*" },
            { name: "nonzero HTML quality", accept: "text/html;q=0.5" },
            { name: "text wildcard", accept: "text/*" },
          ];
          const nonHtmlCases = [
            { name: "JSON", accept: "application/json" },
            { name: "event stream", accept: "text/event-stream" },
            { name: "zero-quality HTML", accept: "text/html;q=0" },
            { name: "zero-quality wildcard", accept: "*/*;q=0" },
            { name: "mixed-case zero quality", accept: "text/html;Q=0" },
            { name: "zero-quality text wildcard", accept: "text/*;q=0" },
          ];
          for (const ready of [false, true]) {
            sidecarsReady = ready;
            for (const testCase of htmlCases) {
              const { res, getBody } = await sendGatewayRequest(server, {
                path: "/unclaimed-spa-route",
                method: "GET",
                headers: testCase.accept === undefined ? undefined : { accept: testCase.accept },
              });

              expect(res.statusCode, `${testCase.name} ready=${ready}`).toBe(200);
              expect(getBody(), `${testCase.name} ready=${ready}`).toContain("spa fallback");
            }

            for (const testCase of nonHtmlCases) {
              const response = createResponse();
              await dispatchRequest(
                server,
                createRequest({
                  path: "/unclaimed-spa-route",
                  method: "GET",
                  headers: { accept: testCase.accept },
                }),
                response.res,
              );

              expect(response.res.statusCode, `${testCase.name} ready=${ready}`).toBe(
                ready ? 404 : 503,
              );
              expect(response.setHeader).toHaveBeenCalledWith(
                "Content-Type",
                "text/plain; charset=utf-8",
              );
              expect(response.getBody()).toBe(ready ? "Not Found" : "Plugin runtime is starting");
              if (ready) {
                expect(response.setHeader).not.toHaveBeenCalledWith("Retry-After", "1");
              } else {
                expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "1");
              }
            }
          }
        },
      });
    });
  });
});

describe("standalone MCP App HTTP routing", () => {
  it.each([
    {
      name: "disabled shell",
      enabled: false,
      requestPath: "/__openclaw__/mcp-app",
    },
    {
      name: "disabled view",
      enabled: false,
      requestPath: "/__openclaw__/mcp-app/view",
    },
    {
      name: "enabled malformed child",
      enabled: true,
      requestPath: "/__openclaw__/mcp-app/other",
    },
  ])(
    "returns 404 for the $name instead of Control UI HTML",
    async ({ name, enabled, requestPath }) => {
      await withMarkedControlUiRoot(async (controlUiRoot) => {
        await withGatewayServer({
          prefix: `mcp-app-routing-${name}`,
          resolvedAuth: AUTH_NONE,
          overrides: {
            controlUiEnabled: true,
            controlUiBasePath: "",
            controlUiRoot: { kind: "resolved", path: controlUiRoot },
            getRuntimeConfig: () => ({
              gateway: { trustedProxies: [] },
              mcp: { apps: { enabled } },
            }),
          },
          run: async (server) => {
            const { res, getBody } = await sendGatewayRequest(server, {
              path: requestPath,
              method: "GET",
            });

            expect(res.statusCode).toBe(404);
            expect(getBody()).toBe("Not Found");
          },
        });
      });
    },
  );

  it.each([
    { name: "disabled endpoint", enabled: false, requestPath: "/__openclaw__/mcp-app" },
    { name: "malformed child", enabled: true, requestPath: "/__openclaw__/mcp-app/other" },
  ])("preserves plugin precedence for a $name", async ({ enabled, requestPath }) => {
    const handlePluginRequest = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 204;
      res.end();
      return true;
    });
    await withGatewayServer({
      prefix: "mcp-app-routing-plugin-precedence",
      resolvedAuth: AUTH_NONE,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: "",
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: () => false,
        getRuntimeConfig: () => ({
          gateway: { trustedProxies: [] },
          mcp: { apps: { enabled } },
        }),
      },
      run: async (server) => {
        const { res } = await sendGatewayRequest(server, {
          path: requestPath,
          method: "GET",
        });

        expect(res.statusCode).toBe(204);
        expect(handlePluginRequest).toHaveBeenCalledOnce();
      },
    });
  });
});

describe("gateway probe endpoints", () => {
  it("returns 404 for probe namespace variants instead of false-green Control UI HTML", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["gateway-draining"],
      uptimeMs: 1_000,
    });
    await withMarkedControlUiRoot(async (controlUiRoot) => {
      await withGatewayServer({
        prefix: "probe-namespace-root-control-ui",
        resolvedAuth: AUTH_NONE,
        overrides: {
          controlUiEnabled: true,
          controlUiBasePath: "",
          controlUiRoot: { kind: "resolved", path: controlUiRoot },
          getReadiness,
        },
        run: async (server) => {
          const exact = await sendGatewayRequest(server, { path: "/readyz" });
          expect(exact.res.statusCode).toBe(503);
          expect(JSON.parse(exact.getBody())).toMatchObject({ ready: false });

          for (const routePath of ["/health/", "/healthz/details", "/ready/", "/readyz/details"]) {
            const { res, getBody } = await sendGatewayRequest(server, { path: routePath });
            expect(res.statusCode, routePath).toBe(404);
            expect(getBody(), routePath).toBe("Not Found");
          }
        },
      });
    });
  });

  it("preserves plugin precedence for an unclaimed probe descendant", async () => {
    const handlePluginRequest = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 204;
      res.end();
      return true;
    });
    await withGatewayServer({
      prefix: "probe-namespace-plugin-precedence",
      resolvedAuth: AUTH_NONE,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: "",
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: () => false,
      },
      run: async (server) => {
        const { res } = await sendGatewayRequest(server, { path: "/readyz/details" });
        expect(res.statusCode).toBe(204);
        expect(handlePluginRequest).toHaveBeenCalledOnce();
      },
    });
  });

  it("keeps liveness green while a prepared suspension lease makes readiness red", async () => {
    resetGatewayWorkAdmission();
    const channelManager = {
      getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
      getAutostartSuppression: () => null,
    } as unknown as ChannelManager;
    const getReadiness = createReadinessChecker({
      channelManager,
      startedAt: Date.now(),
      getGatewayDraining: isGatewayDraining,
      cacheTtlMs: 0,
    });

    try {
      await withGatewayServer({
        prefix: "probe-suspension-lease",
        resolvedAuth: AUTH_NONE,
        overrides: { getReadiness, openAiChatCompletionsEnabled: true },
        run: async (server) => {
          const prepared = prepareGatewaySuspend({
            requestId: "request-readiness-probe",
            pauseScheduling: vi.fn(),
            resumeScheduling: vi.fn(),
            createSuspensionId: () => "suspension-readiness-probe",
            inspect: {
              getQueueSize: () => 0,
              getPendingReplies: () => 0,
              getEmbeddedRuns: () => 0,
              getCronRuns: () => 0,
              getActiveTasks: () => 0,
              getTaskBlockers: () => [],
              getRootRequests: () => 0,
              getSessionAdmissions: () => 0,
              getSessionMutations: () => 0,
              getChatRuns: () => 0,
              getQueuedTurns: () => 0,
              getTerminalPersistence: () => 0,
              getTerminalSessions: () => 0,
            },
          });
          if (prepared.status !== "ready") {
            throw new Error(`expected prepared suspension, received ${prepared.status}`);
          }

          const health = await sendGatewayRequest(server, { path: "/healthz" });
          expect(health.res.statusCode).toBe(200);
          expect(JSON.parse(health.getBody())).toEqual({ ok: true, status: "live" });

          const suspendedReadiness = await sendGatewayRequest(server, { path: "/readyz" });
          expect(suspendedReadiness.res.statusCode).toBe(503);
          expect(JSON.parse(suspendedReadiness.getBody())).toMatchObject({
            ready: false,
            failing: ["gateway-draining"],
          });

          const blockedChat = await sendGatewayRequest(server, {
            path: "/v1/chat/completions",
            method: "POST",
          });
          expect(blockedChat.res.statusCode).toBe(503);
          expect(JSON.parse(blockedChat.getBody())).toMatchObject({
            error: { code: "gateway_unavailable" },
          });

          const blockedBoard = await sendGatewayRequest(server, {
            path: "/__openclaw__/board/agent%3Amain%3Amain/status/index.html?bt=garbage",
          });
          expect(blockedBoard.res.statusCode).toBe(503);
          expect(JSON.parse(blockedBoard.getBody())).toMatchObject({
            error: { code: "gateway_unavailable" },
          });

          expect(resumeGatewaySuspend(prepared.suspensionId)).toEqual({
            ok: true,
            status: "running",
            resumed: true,
          });

          const resumedReadiness = await sendGatewayRequest(server, { path: "/readyz" });
          expect(resumedReadiness.res.statusCode).toBe(200);
          expect(JSON.parse(resumedReadiness.getBody())).toMatchObject({
            ready: true,
            failing: [],
          });
        },
      });
    } finally {
      resetGatewayWorkAdmission();
    }
  });

  it("keeps in-flight core HTTP work visible to suspension preparation", async () => {
    resetGatewayWorkAdmission();
    let releaseWatch = () => {};
    let markWatchStarted = () => {};
    const watchStarted = new Promise<void>((resolve) => {
      markWatchStarted = resolve;
    });
    const heldWatch = new Promise<void>((resolve) => {
      releaseWatch = resolve;
    });
    const handleWatchNodeRequest = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      markWatchStarted();
      await heldWatch;
      res.statusCode = 200;
      res.end("ok");
      return true;
    });

    try {
      await withGatewayServer({
        prefix: "probe-http-work-admission",
        resolvedAuth: AUTH_NONE,
        overrides: { handleWatchNodeRequest },
        run: async (server) => {
          const request = createRequest({ path: "/api/nodes/watch/node-1" });
          const response = createResponse();
          const pendingRequest = dispatchRequest(server, request, response.res);
          await watchStarted;
          expect(getActiveGatewayRootWorkCount()).toBe(1);

          const prepared = prepareGatewaySuspend({
            requestId: "request-http-work",
            pauseScheduling: vi.fn(),
            resumeScheduling: vi.fn(),
            inspect: {
              getQueueSize: () => 0,
              getPendingReplies: () => 0,
              getEmbeddedRuns: () => 0,
              getCronRuns: () => 0,
              getActiveTasks: () => 0,
              getTaskBlockers: () => [],
              getSessionAdmissions: () => 0,
              getSessionMutations: () => 0,
              getChatRuns: () => 0,
              getQueuedTurns: () => 0,
              getTerminalPersistence: () => 0,
              getTerminalSessions: () => 0,
            },
          });
          expect(prepared).toMatchObject({
            status: "busy",
            reason: "active-work",
            activeCount: 1,
          });

          releaseWatch();
          await pendingRequest;
          expect(response.res.statusCode).toBe(200);
          await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        },
      });
    } finally {
      releaseWatch();
      resetGatewayWorkAdmission();
    }
  });

  it("returns detailed readiness payload for local /ready requests", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: true,
      failing: [],
      uptimeMs: 45_000,
    });

    await withGatewayServer({
      prefix: "probe-ready",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const { res, getBody } = await sendGatewayRequest(server, { path: "/ready" });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(getBody())).toEqual({ ready: true, failing: [], uptimeMs: 45_000 });
      },
    });
  });

  it("returns only readiness state for unauthenticated remote /ready requests", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord", "telegram"],
      uptimeMs: 8_000,
    });

    await withGatewayServer({
      prefix: "probe-not-ready",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const { res, getBody } = await sendGatewayRequest(server, {
          path: "/ready",
          remoteAddress: "10.0.0.8",
          host: "gateway.test",
        });

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({ ready: false });
      },
    });
  });

  it("returns detailed readiness payload for authenticated remote /ready requests", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord", "telegram"],
      uptimeMs: 8_000,
    });

    await withGatewayServer({
      prefix: "probe-remote-authenticated",
      resolvedAuth: AUTH_TOKEN,
      overrides: { getReadiness },
      run: async (server) => {
        const { res, getBody } = await sendGatewayRequest(server, {
          path: "/ready",
          remoteAddress: "10.0.0.8",
          host: "gateway.test",
          authorization: "Bearer test-token",
        });

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({
          ready: false,
          failing: ["discord", "telegram"],
          uptimeMs: 8_000,
        });
      },
    });
  });

  it("re-resolves auth for remote /ready requests after shared auth rotation", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord", "telegram"],
      uptimeMs: 8_000,
    });
    let currentAuth = AUTH_TOKEN;

    await withGatewayServer({
      prefix: "probe-remote-rotated-auth",
      // `resolvedAuth` remains the static fallback; `getResolvedAuth` drives the rotated value.
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        getReadiness,
        getResolvedAuth: () => currentAuth,
      },
      run: async (server) => {
        const sendReady = async (authorization: string) => {
          const { res, getBody } = await sendGatewayRequest(server, {
            path: "/ready",
            remoteAddress: "10.0.0.8",
            host: "gateway.test",
            authorization,
          });
          return { statusCode: res.statusCode, body: JSON.parse(getBody()) };
        };

        await expect(sendReady("Bearer test-token")).resolves.toEqual({
          statusCode: 503,
          body: {
            ready: false,
            failing: ["discord", "telegram"],
            uptimeMs: 8_000,
          },
        });

        currentAuth = {
          ...AUTH_TOKEN,
          token: "rotated-token",
        };

        await expect(sendReady("Bearer test-token")).resolves.toEqual({
          statusCode: 503,
          body: { ready: false },
        });
        await expect(sendReady("Bearer rotated-token")).resolves.toEqual({
          statusCode: 503,
          body: {
            ready: false,
            failing: ["discord", "telegram"],
            uptimeMs: 8_000,
          },
        });
      },
    });
  });

  it("hides readiness details when trusted-proxy auth violates browser origin policy", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord", "telegram"],
      uptimeMs: 8_000,
    });

    await withTempConfig({
      prefix: "probe-remote-origin-rejected",
      cfg: {
        gateway: {
          trustedProxies: ["10.0.0.1"],
          controlUi: {
            allowedOrigins: ["https://control.example"],
          },
        },
      },
      run: async () => {
        await withGatewayServer({
          prefix: "probe-remote-origin-rejected-server",
          resolvedAuth: {
            mode: "trusted-proxy",
            allowTailscale: false,
            trustedProxy: { userHeader: "x-forwarded-user" },
          },
          overrides: {
            getReadiness,
          },
          run: async (server) => {
            const { res, getBody } = await sendGatewayRequest(server, {
              path: "/ready",
              remoteAddress: "10.0.0.1",
              host: "gateway.test",
              headers: {
                origin: "https://evil.example",
                forwarded: "for=203.0.113.10;proto=https;host=gateway.test",
                "x-forwarded-user": "user@example.com",
                "x-forwarded-proto": "https",
              },
            });

            expect(res.statusCode).toBe(503);
            expect(JSON.parse(getBody())).toEqual({ ready: false });
          },
        });
      },
    });
  });

  it("returns typed internal error payload when readiness evaluation throws", async () => {
    const getReadiness: ReadinessChecker = () => {
      throw new Error("boom");
    };

    await withGatewayServer({
      prefix: "probe-throws",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const { res, getBody } = await sendGatewayRequest(server, { path: "/ready" });

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({ ready: false, failing: ["internal"], uptimeMs: 0 });
      },
    });
  });

  it("keeps /healthz shallow even when readiness checker reports failing channels", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord"],
      uptimeMs: 999,
    });

    await withGatewayServer({
      prefix: "probe-healthz-unaffected",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const { res, getBody } = await sendGatewayRequest(server, { path: "/healthz" });

        expect(res.statusCode).toBe(200);
        expect(getBody()).toBe(JSON.stringify({ ok: true, status: "live" }));
      },
    });
  });

  it("serves /healthz before loading gateway config", async () => {
    const getRuntimeConfig = vi.fn(() => {
      throw new Error("config load blocked");
    });

    await withGatewayServer({
      prefix: "probe-healthz-before-config",
      resolvedAuth: AUTH_NONE,
      overrides: { getRuntimeConfig },
      run: async (server) => {
        const { res, getBody } = await sendGatewayRequest(server, { path: "/healthz" });

        expect(res.statusCode).toBe(200);
        expect(getBody()).toBe(JSON.stringify({ ok: true, status: "live" }));
        expect(getRuntimeConfig).not.toHaveBeenCalled();
      },
    });
  });

  it("serves probes before stalled request stages", async () => {
    const handleHooksRequest = vi.fn((): Promise<boolean> => new Promise(() => {}));
    const getReadiness = vi.fn(() => ({
      ready: true,
      failing: [],
      uptimeMs: 123,
    }));

    await withGatewayServer({
      prefix: "probe-before-stalled-stages",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness, handleHooksRequest },
      run: async (server) => {
        const healthReq = createRequest({ path: "/healthz" });
        const healthResponse = createResponse();
        await dispatchRequest(server, healthReq, healthResponse.res);

        expect(healthResponse.res.statusCode).toBe(200);
        expect(healthResponse.getBody()).toBe(JSON.stringify({ ok: true, status: "live" }));

        const readyReq = createRequest({ path: "/readyz" });
        const readyResponse = createResponse();
        await dispatchRequest(server, readyReq, readyResponse.res);

        expect(readyResponse.res.statusCode).toBe(200);
        expect(JSON.parse(readyResponse.getBody())).toEqual({
          ready: true,
          failing: [],
          uptimeMs: 123,
        });
        expect(handleHooksRequest).not.toHaveBeenCalled();
      },
    });
  });

  it("reflects readiness status on HEAD /readyz without a response body", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord"],
      uptimeMs: 5_000,
    });

    await withGatewayServer({
      prefix: "probe-readyz-head",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const { res, getBody } = await sendGatewayRequest(server, {
          path: "/readyz",
          method: "HEAD",
        });

        expect(res.statusCode).toBe(503);
        expect(getBody()).toBe("");
      },
    });
  });

  it("sends Content-Length on HEAD probe responses matching the GET body", async () => {
    await withGatewayServer({
      prefix: "probe-head-content-length",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const get = createResponse();
        await dispatchRequest(server, createRequest({ path: "/healthz" }), get.res);
        const head = createResponse();
        await dispatchRequest(
          server,
          createRequest({ path: "/healthz", method: "HEAD" }),
          head.res,
        );

        const expectedLength = String(Buffer.byteLength(get.getBody()));
        expect(get.res.statusCode).toBe(200);
        expect(head.res.statusCode).toBe(200);
        expect(head.getBody()).toBe("");
        expect(head.setHeader).toHaveBeenCalledWith("Content-Length", expectedLength);
      },
    });
  });

  it("sends Content-Length on HEAD responses for unclaimed paths", async () => {
    await withGatewayServer({
      prefix: "catch-all-head-content-length",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const head = createResponse();
        await dispatchRequest(
          server,
          createRequest({ path: "/no-such-route", method: "HEAD" }),
          head.res,
        );

        expect(head.res.statusCode).toBe(404);
        expect(head.setHeader).toHaveBeenCalledWith("Content-Length", "9");
      },
    });
  });

  it("sends Content-Length on HEAD responses while the plugin runtime starts", async () => {
    await withGatewayServer({
      prefix: "plugin-starting-head-content-length",
      resolvedAuth: AUTH_NONE,
      overrides: { isStartupPluginRuntimeReady: () => false },
      run: async (server) => {
        const head = createResponse();
        await dispatchRequest(
          server,
          createRequest({ path: "/no-such-route", method: "HEAD" }),
          head.res,
        );

        expect(head.res.statusCode).toBe(503);
        expect(head.setHeader).toHaveBeenCalledWith(
          "Content-Length",
          String(Buffer.byteLength("Plugin runtime is starting")),
        );
      },
    });
  });
});

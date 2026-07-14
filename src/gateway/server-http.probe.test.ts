// Server HTTP probe tests cover readiness, health, disabled compat routes, and
// auth handling through the in-memory HTTP harness.
import type { IncomingMessage, ServerResponse } from "node:http";
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
});

describe("gateway probe endpoints", () => {
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
});

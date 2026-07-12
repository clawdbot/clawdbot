// Proves plugin HTTP and upgrade handlers participate in Gateway suspension admission.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayActiveWorkInspectors } from "../../infra/gateway-active-work.js";
import {
  prepareGatewaySuspend,
  resetGatewaySuspendCoordinatorForTest,
} from "../../infra/gateway-suspend-coordinator.js";
import { dispatchGatewayMethod } from "../../plugin-sdk/gateway-method-runtime.js";
import type { PluginHttpRouteRegistration } from "../../plugins/registry.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { testing as controlPlaneRateLimitTesting } from "../control-plane-rate-limit.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { makeMockHttpResponse } from "../test-http-response.js";
import { createTestRegistry } from "./__tests__/test-utils.js";
import {
  createGatewayPluginRequestHandler,
  createGatewayPluginUpgradeHandler,
} from "./plugins-http.js";

const ROUTE_PATH = "/plugin/suspension-proof";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createRoute(
  params: Partial<PluginHttpRouteRegistration> & Pick<PluginHttpRouteRegistration, "handler">,
): PluginHttpRouteRegistration {
  return {
    pluginId: "suspension-proof",
    path: ROUTE_PATH,
    auth: "plugin",
    match: "exact",
    source: "suspension-proof",
    ...params,
  };
}

function createLog() {
  return { warn: vi.fn() } as unknown as Parameters<
    typeof createGatewayPluginRequestHandler
  >[0]["log"];
}

function createRootOnlyInspectors(): GatewayActiveWorkInspectors {
  return {
    getQueueSize: () => 0,
    getPendingReplies: () => 0,
    getEmbeddedRuns: () => 0,
    getBackgroundExecSessions: () => 0,
    getCronRuns: () => 0,
    getActiveTasks: () => 0,
    getTaskBlockers: () => [],
    getRootRequests: () => getActiveGatewayRootWorkCount({ excludeCurrent: true }),
    getSessionAdmissions: () => 0,
    getSessionMutations: () => 0,
    getChatRuns: () => 0,
    getQueuedTurns: () => 0,
    getTerminalPersistence: () => 0,
    getTerminalSessions: () => 0,
  };
}

function prepareWithRootOnly(requestId: string) {
  return prepareGatewaySuspend({
    requestId,
    pauseScheduling: vi.fn(),
    resumeScheduling: vi.fn(),
    inspect: createRootOnlyInspectors(),
  });
}

function createMockUpgradeSocket() {
  const socket = {
    chunks: [] as string[],
    destroyed: false,
    write(chunk: string) {
      socket.chunks.push(chunk);
    },
    destroy() {
      socket.destroyed = true;
    },
  } as unknown as Duplex & { chunks: string[]; destroyed: boolean };
  return socket;
}

function createRequestHandler(
  routes: PluginHttpRouteRegistration[],
  getGatewayRequestContext?: () => GatewayRequestContext,
) {
  return createGatewayPluginRequestHandler({
    registry: createTestRegistry({ httpRoutes: routes }),
    log: createLog(),
    ...(getGatewayRequestContext ? { getGatewayRequestContext } : {}),
  });
}

function createUpgradeHandler(routes: PluginHttpRouteRegistration[]) {
  return createGatewayPluginUpgradeHandler({
    registry: createTestRegistry({ httpRoutes: routes }),
    log: createLog(),
  });
}

beforeEach(() => {
  controlPlaneRateLimitTesting.resetControlPlaneRateLimitState();
  resetGatewaySuspendCoordinatorForTest();
  resetGatewayWorkAdmission();
});

afterEach(() => {
  controlPlaneRateLimitTesting.resetControlPlaneRateLimitState();
  resetGatewaySuspendCoordinatorForTest();
  resetGatewayWorkAdmission();
});

describe("plugin HTTP suspension admission", () => {
  it("keeps an in-flight ordinary route visible to suspension preparation", async () => {
    const started = deferred();
    const finish = deferred();
    const handler = createRequestHandler([
      createRoute({
        handler: async () => {
          started.resolve();
          await finish.promise;
          return true;
        },
      }),
    ]);
    const response = makeMockHttpResponse();
    const pending = handler({ url: ROUTE_PATH } as IncomingMessage, response.res);
    await started.promise;

    expect(getActiveGatewayRootWorkCount()).toBe(1);
    expect(prepareWithRootOnly("plugin-http-active")).toMatchObject({
      status: "busy",
      reason: "active-work",
      activeCount: 1,
      blockers: [expect.objectContaining({ kind: "root-request", count: 1 })],
    });

    finish.resolve();
    await expect(pending).resolves.toBe(true);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("rejects an ordinary route with the canonical HTTP response after admission closes", async () => {
    const routeHandler = vi.fn(() => true);
    const handler = createRequestHandler([createRoute({ handler: routeHandler })]);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    const response = makeMockHttpResponse();

    await expect(handler({ url: ROUTE_PATH } as IncomingMessage, response.res)).resolves.toBe(true);

    expect(routeHandler).not.toHaveBeenCalled();
    expect(response.res.statusCode).toBe(503);
    expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "1");
    expect(JSON.parse(String(response.end.mock.calls[0]?.[0]))).toMatchObject({
      error: { code: "gateway_unavailable" },
    });
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(suspension?.release()).toBe(true);
  });

  it("releases ordinary route admission after fallthrough and failure", async () => {
    const fallthrough = vi.fn(() => false);
    const handled = vi.fn(() => true);
    const fallthroughHandler = createRequestHandler([
      createRoute({ handler: fallthrough }),
      createRoute({ path: "/plugin", match: "prefix", handler: handled }),
    ]);
    const fallthroughResponse = makeMockHttpResponse();

    await expect(
      fallthroughHandler({ url: ROUTE_PATH } as IncomingMessage, fallthroughResponse.res),
    ).resolves.toBe(true);
    expect(fallthrough).toHaveBeenCalledOnce();
    expect(handled).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    const failingHandler = createRequestHandler([
      createRoute({
        handler: () => {
          throw new Error("route failed");
        },
      }),
    ]);
    const failureResponse = makeMockHttpResponse();
    await expect(
      failingHandler({ url: ROUTE_PATH } as IncomingMessage, failureResponse.res),
    ).resolves.toBe(true);
    expect(failureResponse.res.statusCode).toBe(500);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("keeps an ordinary sibling from an entitled plugin behind admission", async () => {
    const ordinaryHandler = vi.fn(() => true);
    const handler = createRequestHandler([
      createRoute({
        auth: "gateway",
        gatewayMethodDispatchAllowed: true,
        handler: ordinaryHandler,
      }),
      createRoute({
        path: `${ROUTE_PATH}/control`,
        auth: "gateway",
        gatewayRuntimeScopeSurface: "trusted-operator",
        gatewayMethodDispatchAllowed: true,
        handler: () => true,
      }),
    ]);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    const response = makeMockHttpResponse();

    await expect(
      handler({ url: ROUTE_PATH, headers: {} } as IncomingMessage, response.res, undefined, {
        gatewayAuthSatisfied: true,
        gatewayRequestAuth: { authMethod: "token", trustDeclaredOperatorScopes: false },
        gatewayRequestOperatorScopes: ["operator.write"],
      }),
    ).resolves.toBe(true);

    expect(ordinaryHandler).not.toHaveBeenCalled();
    expect(response.res.statusCode).toBe(503);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(suspension?.release()).toBe(true);
  });

  it("keeps entitled Gateway suspension dispatch outside the plugin route root", async () => {
    const cron = {
      pauseScheduling: vi.fn(),
      resumeScheduling: vi.fn(),
      getSuspensionBlockerCount: vi.fn(() => 0),
    };
    const context = {
      cron,
      logGateway: { warn: vi.fn() },
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
      terminalSessions: new Map(),
    } as unknown as GatewayRequestContext;
    let requestedMethod = "gateway.suspend.prepare";
    let requestedParams: Record<string, unknown> = { requestId: "admin-http-suspension" };
    let dispatchResponse: Awaited<ReturnType<typeof dispatchGatewayMethod>> | undefined;
    const handler = createRequestHandler(
      [
        createRoute({
          auth: "gateway",
          gatewayRuntimeScopeSurface: "trusted-operator",
          gatewayMethodDispatchAllowed: true,
          handler: async () => {
            expect(getActiveGatewayRootWorkCount()).toBe(0);
            dispatchResponse = await dispatchGatewayMethod(requestedMethod, requestedParams);
            return true;
          },
        }),
      ],
      () => context,
    );
    const invoke = async (method: string, params: Record<string, unknown>) => {
      requestedMethod = method;
      requestedParams = params;
      dispatchResponse = undefined;
      const response = makeMockHttpResponse();
      const handled = await handler(
        { url: ROUTE_PATH, headers: {} } as IncomingMessage,
        response.res,
        undefined,
        {
          gatewayAuthSatisfied: true,
          gatewayRequestAuth: { authMethod: "token", trustDeclaredOperatorScopes: false },
          gatewayRequestOperatorScopes: ["operator.admin"],
        },
      );
      expect(handled).toBe(true);
      expect(dispatchResponse).toBeDefined();
      return dispatchResponse!;
    };

    const prepared = await invoke("gateway.suspend.prepare", {
      requestId: "admin-http-suspension",
    });
    expect(prepared).toMatchObject({
      ok: true,
      payload: { status: "ready", activeCount: 0, blockers: [] },
    });
    const suspensionId = (prepared.payload as { suspensionId: string }).suspensionId;

    await expect(invoke("gateway.suspend.status", { suspensionId })).resolves.toMatchObject({
      ok: true,
      payload: { status: "ready" },
    });
    await expect(invoke("gateway.suspend.resume", { suspensionId })).resolves.toMatchObject({
      ok: true,
      payload: { status: "running", resumed: true },
    });
    expect(cron.pauseScheduling).toHaveBeenCalledOnce();
    expect(cron.resumeScheduling).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });
});

describe("plugin upgrade suspension admission", () => {
  it("keeps an in-flight upgrade visible to suspension preparation", async () => {
    const started = deferred();
    const finish = deferred();
    const handler = createUpgradeHandler([
      createRoute({
        handler: () => false,
        handleUpgrade: async () => {
          started.resolve();
          await finish.promise;
          return true;
        },
      }),
    ]);
    const socket = createMockUpgradeSocket();
    const pending = handler({ url: ROUTE_PATH } as IncomingMessage, socket, Buffer.alloc(0));
    await started.promise;

    expect(getActiveGatewayRootWorkCount()).toBe(1);
    expect(prepareWithRootOnly("plugin-upgrade-active")).toMatchObject({
      status: "busy",
      reason: "active-work",
      activeCount: 1,
      blockers: [expect.objectContaining({ kind: "root-request", count: 1 })],
    });

    finish.resolve();
    await expect(pending).resolves.toBe(true);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("rejects a new upgrade with HTTP 503 after admission closes", async () => {
    const upgrade = vi.fn(() => true);
    const handler = createUpgradeHandler([
      createRoute({ handler: () => false, handleUpgrade: upgrade }),
    ]);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    const socket = createMockUpgradeSocket();

    await expect(
      handler({ url: ROUTE_PATH } as IncomingMessage, socket, Buffer.alloc(0)),
    ).resolves.toBe(true);

    expect(upgrade).not.toHaveBeenCalled();
    expect(socket.destroyed).toBe(true);
    expect(socket.chunks.join("")).toContain("HTTP/1.1 503 Service Unavailable");
    expect(socket.chunks.join("")).toContain("Gateway websocket admission closed");
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(suspension?.release()).toBe(true);
  });

  it("releases upgrade admission after fallthrough and failure", async () => {
    const fallthrough = vi.fn(() => false);
    const handled = vi.fn(() => true);
    const fallthroughHandler = createUpgradeHandler([
      createRoute({ handler: () => false, handleUpgrade: fallthrough }),
      createRoute({
        path: "/plugin",
        match: "prefix",
        handler: () => false,
        handleUpgrade: handled,
      }),
    ]);
    const fallthroughSocket = createMockUpgradeSocket();

    await expect(
      fallthroughHandler(
        { url: ROUTE_PATH } as IncomingMessage,
        fallthroughSocket,
        Buffer.alloc(0),
      ),
    ).resolves.toBe(true);
    expect(fallthrough).toHaveBeenCalledOnce();
    expect(handled).toHaveBeenCalledOnce();
    expect(fallthroughSocket.destroyed).toBe(false);
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    const failingHandler = createUpgradeHandler([
      createRoute({
        handler: () => false,
        handleUpgrade: () => {
          throw new Error("upgrade failed");
        },
      }),
    ]);
    const failureSocket = createMockUpgradeSocket();
    await expect(
      failingHandler({ url: ROUTE_PATH } as IncomingMessage, failureSocket, Buffer.alloc(0)),
    ).resolves.toBe(true);
    expect(failureSocket.destroyed).toBe(true);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });
});

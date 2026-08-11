// Proves dispatcher root-work accounting and fail-closed suspension behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resumeGatewaySuspend } from "../infra/gateway-suspend-coordinator.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  retainGatewayRootWorkAdmissionContinuation,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  createGatewayMethodRegistry,
  createPluginGatewayMethodDescriptor,
} from "./methods/registry.js";
import { handleGatewayRequest, runWithGatewayRequestEnvelope } from "./server-methods.js";
import { suspendHandlers } from "./server-methods/suspend.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function dispatch(params: {
  method: string;
  scope: "operator.read" | "operator.write" | "operator.admin";
  handler: GatewayRequestHandler;
  requestParams?: Record<string, unknown>;
  context?: Parameters<typeof handleGatewayRequest>[0]["context"];
}) {
  const respond = vi.fn();
  const methodRegistry = createGatewayMethodRegistry([
    createPluginGatewayMethodDescriptor({
      pluginId: "suspend-proof",
      name: params.method,
      handler: params.handler,
      scope: params.scope,
    }),
  ]);
  const request = handleGatewayRequest({
    req: {
      type: "req",
      id: `request-${params.method}`,
      method: params.method,
      params: params.requestParams ?? {},
    },
    respond,
    client: {
      connId: "conn-suspend-proof",
      connect: {
        role: "operator",
        scopes: [params.scope],
        client: { id: "cli", version: "test", platform: "linux", mode: "cli" },
        minProtocol: 1,
        maxProtocol: 1,
      },
    },
    isWebchatConnect: () => false,
    context:
      params.context ??
      ({ logGateway: { warn: vi.fn() } } as unknown as Parameters<
        typeof handleGatewayRequest
      >[0]["context"]),
    methodRegistry,
  });
  return { request, respond };
}

beforeEach(() => {
  resetGatewayWorkAdmission();
});

afterEach(() => {
  resetGatewayWorkAdmission();
});

describe("gateway request suspension admission", () => {
  it("keeps a facade continuation on the same admitted root", async () => {
    const methodRegistry = createGatewayMethodRegistry([
      createPluginGatewayMethodDescriptor({
        pluginId: "suspend-proof",
        name: "agent",
        handler: vi.fn(),
        scope: "operator.write",
      }),
    ]);
    const context = {
      logGateway: { warn: vi.fn() },
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"];
    let releaseContinuation: (() => void) | null = null;

    await runWithGatewayRequestEnvelope(
      "agent",
      null,
      async () => {
        releaseContinuation = retainGatewayRootWorkAdmissionContinuation();
      },
      {
        context,
        isWebchatConnect: () => false,
        methodRegistry,
        reject: (error) => {
          throw new Error(error.message);
        },
      },
    );

    expect(releaseContinuation).toBeTypeOf("function");
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    suspension?.rollback();
    const release = releaseContinuation as (() => void) | null;
    release?.();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("keeps preparation busy while a previously admitted handler is active", async () => {
    const started = deferred();
    const finish = deferred();
    const handler = vi.fn<GatewayRequestHandler>(async ({ respond }) => {
      started.resolve();
      await finish.promise;
      respond(true, { ok: true });
    });
    const active = dispatch({
      method: "suspend-proof.run",
      scope: "operator.write",
      handler,
    });
    await started.promise;
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    expect(suspension?.rollback()).toBe(true);

    finish.resolve();
    await active.request;
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("reports a concurrent root as busy then excludes its own prepare request", async () => {
    const started = deferred();
    const finish = deferred();
    const active = dispatch({
      method: "suspend-proof.concurrent",
      scope: "operator.write",
      handler: async ({ respond }) => {
        started.resolve();
        await finish.promise;
        respond(true, { ok: true });
      },
    });
    await started.promise;

    const prepareHandler = suspendHandlers["gateway.suspend.prepare"];
    expect(prepareHandler).toBeTypeOf("function");
    if (!prepareHandler) {
      throw new Error("expected gateway suspension prepare handler");
    }
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
      terminalSessions: { size: 2 },
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"];
    const busy = dispatch({
      method: "gateway.suspend.prepare",
      scope: "operator.admin",
      handler: prepareHandler,
      requestParams: { requestId: "request-concurrent-root", terminalPolicy: "terminate" },
      context,
    });
    await busy.request;

    expect(busy.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        status: "busy",
        reason: "active-work",
        activeCount: 1,
        blockers: expect.arrayContaining([
          expect.objectContaining({ kind: "root-request", count: 1 }),
        ]),
      }),
    );

    finish.resolve();
    await active.request;
    const ready = dispatch({
      method: "gateway.suspend.prepare",
      scope: "operator.admin",
      handler: prepareHandler,
      requestParams: { requestId: "request-own-root-excluded", terminalPolicy: "terminate" },
      context,
    });
    await ready.request;

    expect(ready.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        status: "ready",
        activeCount: 0,
        blockers: [],
      }),
    );
    const readyPayload = ready.respond.mock.calls[0]?.[1] as { suspensionId?: string } | undefined;
    expect(readyPayload?.suspensionId).toBeTypeOf("string");
    expect(resumeGatewaySuspend(readyPayload?.suspensionId ?? "missing")).toMatchObject({
      ok: true,
      resumed: true,
    });
  });

  it("applies terminal policy at the suspension RPC boundary", async () => {
    const prepareHandler = suspendHandlers["gateway.suspend.prepare"];
    expect(prepareHandler).toBeTypeOf("function");
    if (!prepareHandler) {
      throw new Error("expected gateway suspension prepare handler");
    }
    const context = {
      cron: {
        pauseScheduling: vi.fn(),
        resumeScheduling: vi.fn(),
        getSuspensionBlockerCount: vi.fn(() => 0),
      },
      logGateway: { warn: vi.fn() },
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
      terminalSessions: { size: 2 },
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"];

    for (const [suffix, requestParams] of [
      ["default", { requestId: "request-terminal-default" }],
      ["preserve", { requestId: "request-terminal-preserve", terminalPolicy: "preserve" }],
    ] as const) {
      const blocked = dispatch({
        method: "gateway.suspend.prepare",
        scope: "operator.admin",
        handler: prepareHandler,
        requestParams,
        context,
      });
      await blocked.request;
      expect(blocked.respond, suffix).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          status: "busy",
          activeCount: 2,
          blockers: [expect.objectContaining({ kind: "terminal-session", count: 2 })],
        }),
      );
    }

    const ready = dispatch({
      method: "gateway.suspend.prepare",
      scope: "operator.admin",
      handler: prepareHandler,
      requestParams: { requestId: "request-terminal-terminate", terminalPolicy: "terminate" },
      context,
    });
    await ready.request;
    expect(ready.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "ready", activeCount: 0, blockers: [] }),
    );
    const readyPayload = ready.respond.mock.calls[0]?.[1] as { suspensionId?: string } | undefined;
    expect(resumeGatewaySuspend(readyPayload?.suspensionId ?? "missing")).toMatchObject({
      ok: true,
      resumed: true,
    });

    context.chatAbortControllers.set("persisting", {
      controller: new AbortController(),
      sessionId: "session-persisting",
      sessionKey: "agent:main:session-persisting",
      startedAtMs: 1,
      expiresAtMs: 2,
      registrationCleanupRequested: true,
      controlUiVisible: true,
      projectSessionTerminalPending: true,
    });
    const persisting = dispatch({
      method: "gateway.suspend.prepare",
      scope: "operator.admin",
      handler: prepareHandler,
      requestParams: {
        requestId: "request-terminal-persistence",
        terminalPolicy: "terminate",
      },
      context,
    });
    await persisting.request;
    expect(persisting.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        status: "busy",
        activeCount: 1,
        blockers: [expect.objectContaining({ kind: "terminal-persistence", count: 1 })],
      }),
    );
  });

  it("rejects new read and write handlers outside the suspension allowlist", async () => {
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);

    const writeHandler = vi.fn<GatewayRequestHandler>();
    const blocked = dispatch({
      method: "suspend-proof.write",
      scope: "operator.write",
      handler: writeHandler,
    });
    await blocked.request;
    expect(writeHandler).not.toHaveBeenCalled();
    expect(blocked.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        retryable: true,
        details: expect.objectContaining({ reason: "gateway-suspending" }),
      }),
    );

    const readHandler = vi.fn<GatewayRequestHandler>(({ respond }) => {
      respond(true, { state: "visible" });
    });
    const allowed = dispatch({
      method: "suspend-proof.read",
      scope: "operator.read",
      handler: readHandler,
    });
    await allowed.request;
    expect(readHandler).not.toHaveBeenCalled();
    expect(allowed.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
    );
    suspension?.release();
  });

  it("keeps suspension status reachable while prepared", async () => {
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => {
      respond(true, { ok: true });
    });

    const status = dispatch({
      method: "gateway.suspend.status",
      scope: "operator.read",
      handler,
    });
    await status.request;

    expect(handler).toHaveBeenCalledOnce();
    expect(status.respond).toHaveBeenCalledWith(true, { ok: true });
    suspension?.release();
  });

  it("rejects suspension preparation nested inside another root request", async () => {
    const root = tryBeginGatewayRootWorkAdmission();
    expect(root?.ownsRoot).toBe(true);
    const handler = vi.fn<GatewayRequestHandler>();

    await root?.run(async () => {
      const nested = dispatch({
        method: "gateway.suspend.prepare",
        scope: "operator.admin",
        handler,
      });
      await nested.request;
      expect(nested.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          retryable: true,
          details: expect.objectContaining({ reason: "nested-gateway-request" }),
        }),
      );
    });

    root?.release();
    expect(handler).not.toHaveBeenCalled();
  });
});

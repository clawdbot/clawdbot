import { EventEmitter } from "node:events";
import { createServer, request as requestHttp } from "node:http";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import {
  getSessionMcpRequestSignal,
  runWithSessionMcpRequestSignal,
} from "../agents/agent-bundle-mcp-request-context.js";
import {
  executeMcpAppOperation,
  handleMcpAppStandaloneHttpRequest,
  issueTicket,
  mocks,
  nowMs,
  request,
  resetStandaloneMcpAppTestState,
  resolveMcpAppActiveView,
  runtime,
  secret,
  view,
} from "./mcp-app-standalone.http.test-support.js";

describe("MCP App standalone request cancellation", () => {
  beforeEach(resetStandaloneMcpAppTestState);

  it.each([false, true])("owns the HTTP request lifetime (disconnect=%s)", async (disconnect) => {
    const started = createDeferred();
    const finish = createDeferred();
    const handled = createDeferred();
    let signal: AbortSignal | undefined;
    runtime.callTool.mockImplementationOnce(async () => {
      signal = getSessionMcpRequestSignal();
      started.resolve();
      await finish.promise;
      return { content: [{ type: "text", text: "completed once" }] };
    });
    const ticket = issueTicket({ sessionKey: "agent:main:main", view, nowMs, secret }).ticket;
    const server = createServer((req, res) => {
      void handleMcpAppStandaloneHttpRequest(req, res, {
        gatewayPort: 18_789,
        sandboxPort: 18_790,
        nowMs,
        ticketSecret: secret,
      }).finally(() => handled.resolve());
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const controller = new AbortController();
    const response = fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/__openclaw__/mcp-app/view`,
      {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: `MCP-App ${ticket}`, "Content-Type": "application/json" },
        body: JSON.stringify({ method: "tools/call", params: { name: "app-only" } }),
      },
    ).then(
      async (value) => ({ body: await value.json() }),
      (error: unknown) => ({ error }),
    );
    try {
      await withTestTimeout(started.promise, 2_000, "standalone HTTP tool did not start");
      expect(signal?.aborted ?? false).toBe(false);
      expect(view.activeRequests).toBe(1);
      if (disconnect) {
        controller.abort();
        await vi.waitFor(() => expect(signal?.aborted).toBe(true));
        expect(view.activeRequests).toBe(1);
      }
      finish.resolve();
      const result = await response;
      if (!disconnect) {
        expect(result).toMatchObject({
          body: { ok: true, result: { content: [{ text: "completed once" }] } },
        });
      }
      await withTestTimeout(handled.promise, 2_000, "standalone HTTP handler did not finish");
      expect(view.activeRequests).toBe(0);
      expect(runtime.callTool).toHaveBeenCalledTimes(1);
    } finally {
      finish.resolve();
      controller.abort();
      server.closeAllConnections();
      await Promise.all([
        response,
        withTestTimeout(handled.promise, 2_000, "standalone HTTP cleanup did not finish"),
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
      ]);
    }
  });

  it.each([false, true])(
    "settles a partial HTTP upload without leaking listeners (disconnect=%s)",
    async (disconnect) => {
      const entered = createDeferred();
      const handled = createDeferred();
      const clientDone = createDeferred<number | string>();
      let leakedCloseListeners = 0;
      let handlerError: unknown;
      const ticket = issueTicket({ sessionKey: "agent:main:main", view, nowMs, secret }).ticket;
      const server = createServer((req, res) => {
        const originalListeners = new Set(req.socket.listeners("close"));
        entered.resolve();
        void handleMcpAppStandaloneHttpRequest(req, res, {
          gatewayPort: 18_789,
          sandboxPort: 18_790,
          nowMs,
          ticketSecret: secret,
        })
          .catch((error: unknown) => {
            handlerError = error;
            res.destroy();
          })
          .finally(() => {
            leakedCloseListeners = req.socket
              .listeners("close")
              .filter((listener) => !originalListeners.has(listener)).length;
            handled.resolve();
          });
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const client = requestHttp(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/__openclaw__/mcp-app/view`,
        {
          method: "POST",
          headers: { Authorization: `MCP-App ${ticket}`, "Content-Type": "application/json" },
        },
        (res) => {
          res.resume();
          res.on("end", () => clientDone.resolve(res.statusCode ?? 0));
        },
      );
      client.on("error", (error) => clientDone.resolve(error.message));
      try {
        client.write('{"method":"tools/call","params":');
        await withTestTimeout(entered.promise, 2_000, "HTTP upload did not reach handler");
        if (disconnect) {
          client.destroy(new Error("fixture upload cancelled"));
        } else {
          client.end('{"name":"app-only"}}');
        }
        const outcome = await withTestTimeout(
          clientDone.promise,
          2_000,
          "HTTP upload did not settle",
        );
        await withTestTimeout(handled.promise, 2_000, "HTTP upload handler did not settle");
        expect(outcome).toBe(disconnect ? "fixture upload cancelled" : 200);
        expect(handlerError).toBeUndefined();
        expect(runtime.callTool).toHaveBeenCalledTimes(disconnect ? 0 : 1);
        expect(view.activeRequests).toBe(0);
        expect(leakedCloseListeners).toBe(0);
      } finally {
        client.destroy();
        server.closeAllConnections();
        await Promise.all([
          withTestTimeout(handled.promise, 2_000, "HTTP upload cleanup did not finish"),
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
        ]);
      }
    },
  );

  it.each(["tools/call", "tools/list"] as const)(
    "cancels the %s catalog waiter without cancelling shared catalog work",
    async (method) => {
      const catalog = await runtime.getCatalog();
      const release = createDeferred<typeof catalog>();
      const getCatalog = runtime.getCatalog.getMockImplementation()!;
      runtime.getCatalog.mockImplementation(() => release.promise);
      const controller = new AbortController();
      const operation =
        method === "tools/call" ? { method, params: { name: "app-only" } } : { method };
      const active = await resolveMcpAppActiveView({
        sessionKey: "agent:main:main",
        viewId: view.viewId,
      });
      let cancelled = false;
      let otherSettled = false;
      const first = runWithSessionMcpRequestSignal(controller.signal, () =>
        executeMcpAppOperation(active, operation),
      ).then(
        () => "unexpected success",
        () => {
          cancelled = true;
          return "cancelled";
        },
      );
      const second = executeMcpAppOperation(active, operation).finally(() => {
        otherSettled = true;
      });
      try {
        await vi.waitFor(() => expect(view.activeRequests).toBe(2));
        if (method === "tools/list") {
          await vi.waitFor(() => expect(runtime.listTools).toHaveBeenCalledTimes(2));
        }
        controller.abort(new Error("App caller cancelled"));
        await vi.waitFor(() => expect(cancelled).toBe(true));
        expect(otherSettled).toBe(false);
        expect(view.activeRequests).toBe(1);
        release.resolve(catalog);
        await expect(first).resolves.toBe("cancelled");
        await expect(second).resolves.toBeDefined();
        expect(view.activeRequests).toBe(0);
        if (method === "tools/call") {
          expect(runtime.callTool).toHaveBeenCalledTimes(1);
        }
      } finally {
        release.resolve(catalog);
        await Promise.allSettled([first, second]);
        runtime.getCatalog.mockImplementation(getCatalog);
      }
    },
  );

  it("observes tools/list rejection when HTTP disconnects during async authorization", async () => {
    const entered = createDeferred();
    const authorize = createDeferred<boolean>();
    const socket = new EventEmitter();
    let signal: AbortSignal | undefined;
    const authorizeAppInteraction = async () => {
      signal = getSessionMcpRequestSignal();
      entered.resolve();
      return await authorize.promise;
    };
    let listCalls = 0;
    const requestRuntime = {
      ...runtime,
      // vi.fn observes returned promises for settledResults, masking orphaned rejections.
      async listTools() {
        listCalls += 1;
        getSessionMcpRequestSignal()?.throwIfAborted();
        return { tools: [] };
      },
    };
    const requestView = { ...view, runtime: requestRuntime, authorizeAppInteraction };
    mocks.peekSessionMcpRuntime.mockReturnValue(requestRuntime);
    mocks.getMcpAppViewLease.mockReturnValue(requestView);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      if (reason === signal?.reason) {
        unhandled.push(reason);
      }
    };
    process.on("unhandledRejection", onUnhandled);
    const ticket = issueTicket({
      sessionKey: "agent:main:main",
      view: requestView,
      nowMs,
      secret,
    }).ticket;
    const pending = request({
      url: "/__openclaw__/mcp-app/view",
      method: "POST",
      authorization: `MCP-App ${ticket}`,
      body: { method: "tools/list", params: {} },
      socket,
    });
    try {
      await entered.promise;
      expect(signal?.aborted).toBe(false);
      socket.emit("close");
      expect(signal?.aborted).toBe(true);
      expect(signal?.reason.name).toBe("ClientDisconnectError");
      authorize.resolve(true);
      await pending;
      // Let Node report orphaned rejections; keep Vitest's own listener installed.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandled).toEqual([]);
      expect(listCalls).toBe(1);
      expect(runtime.getCatalog).not.toHaveBeenCalled();
      expect(requestView.activeRequests).toBe(0);
    } finally {
      authorize.resolve(true);
      try {
        await pending;
      } finally {
        process.off("unhandledRejection", onUnhandled);
        mocks.peekSessionMcpRuntime.mockReturnValue(runtime);
        mocks.getMcpAppViewLease.mockReturnValue(view);
      }
    }
  });
});

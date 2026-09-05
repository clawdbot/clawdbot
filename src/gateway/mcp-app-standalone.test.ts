import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createMcpAppStandaloneTicket,
  createSerializedHost,
  handleMcpAppStandaloneHttpRequest,
  issueTicket,
  mocks,
  mcpAppStandaloneTesting,
  nowMs,
  releaseRuntimeLease,
  request,
  resetStandaloneMcpAppTestState,
  runtime,
  secret,
  view,
  verifyMcpAppStandaloneTicket,
} from "./mcp-app-standalone.http.test-support.js";

describe("MCP App standalone host", () => {
  beforeEach(resetStandaloneMcpAppTestState);

  it("mints an opaque ticket bound to the session, runtime, view, and lease", () => {
    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs, secret });
    expect(issued.ticket).toMatch(/^v1\.[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]+$/u);
    expect(issued.ticket).not.toContain("agent:main:main");
    expect(issued.expiresAtMs).toBe(nowMs + 2 * 60_000);
    expect(issueTicket({ sessionKey: "agent:main:main", view, nowMs: nowMs + 1, secret })).toEqual(
      issued,
    );
    expect(
      verifyMcpAppStandaloneTicket(issued.ticket, {
        sessionKey: "agent:main:main",
        sessionId: runtime.sessionId,
        viewId: view.viewId,
        nowMs,
        secret,
      }),
    ).toBeDefined();
    for (const expected of [
      { sessionKey: "agent:other:main" },
      { sessionId: "other-runtime" },
      { viewId: "mcp-app-other" },
    ]) {
      expect(
        verifyMcpAppStandaloneTicket(issued.ticket, { ...expected, nowMs, secret }),
      ).toBeUndefined();
    }
    expect(
      verifyMcpAppStandaloneTicket(`${issued.ticket.slice(0, -1)}x`, { nowMs, secret }),
    ).toBeUndefined();
    expect(
      verifyMcpAppStandaloneTicket(issued.ticket, { nowMs: issued.expiresAtMs + 1, secret }),
    ).toBeUndefined();
  });

  it("bounds ticket lifetime and omits issuance at capacity", () => {
    const shortView = { ...view, expiresAtMs: nowMs + 1_000 };
    expect(issueTicket({ sessionKey: "short", view: shortView, nowMs, secret }).expiresAtMs).toBe(
      nowMs + 1_000,
    );
    mcpAppStandaloneTesting.clearTickets();
    for (let index = 0; index < 256; index += 1) {
      expect(
        createMcpAppStandaloneTicket({
          sessionKey: `agent:${index}`,
          view: { ...view, viewId: `mcp-app-${index}` },
          nowMs,
          secret,
        }),
      ).toBeDefined();
    }
    expect(
      createMcpAppStandaloneTicket({
        sessionKey: "agent:overflow",
        view: { ...view, viewId: "mcp-app-overflow" },
        nowMs,
        secret,
      }),
    ).toBeUndefined();
  });

  it("serves a hash-protected static shell without per-view data", async () => {
    const result = await request({ url: "/__openclaw__/mcp-app" });
    expect(result.handled).toBe(true);
    expect(result.res.statusCode).toBe(200);
    const body = String(result.end.mock.calls[0]?.[0]);
    expect(body).toContain("location.hash");
    expect(body).toContain("event.origin");
    expect(body).toContain("if (!initializeAccepted)");
    expect(body).not.toContain("MCP_APP_STANDALONE_INITIAL_LOAD_TIMEOUT_MS");
    expect(body).not.toContain('postMessage(message, "*")');
    expect(body).not.toContain(view.html);
    expect(body).not.toContain("agent:main:main");
    expect(result.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(result.setHeader).toHaveBeenCalledWith(
      "Content-Security-Policy",
      expect.stringMatching(/script-src 'sha256-[^']+';.*connect-src 'self'/u),
    );
  });

  it.each([
    { label: "public shell", path: "/__openclaw__/mcp-app", expectedStatus: 200 },
    {
      label: "authenticated multibyte view",
      path: "/__openclaw__/mcp-app/view",
      expectedStatus: 200,
      authorized: true,
    },
    {
      label: "unauthorized view",
      path: "/__openclaw__/mcp-app/view",
      expectedStatus: 401,
    },
    {
      label: "saturated view",
      path: "/__openclaw__/mcp-app/view",
      expectedStatus: 429,
      authorized: true,
      saturated: true,
    },
  ])(
    "keeps GET and HEAD metadata aligned over HTTP for $label",
    async ({ path, expectedStatus, authorized, saturated }) => {
      const originalHtml = view.html;
      view.html = "<!doctype html><p>caf\u00e9 \ud83e\udd9e</p>";
      const ticket = authorized
        ? issueTicket({ sessionKey: "agent:main:main", view, nowMs, secret }).ticket
        : undefined;
      view.activeRequests = saturated ? 4 : 0;
      const server = createServer((req, res) => {
        void handleMcpAppStandaloneHttpRequest(req, res, {
          sandboxPort: 18_790,
          nowMs,
          ticketSecret: secret,
        }).catch((error: unknown) => {
          res.statusCode = 500;
          res.end(String(error));
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });

      try {
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const headers = ticket ? { Authorization: `MCP-App ${ticket}` } : undefined;
        const get = await fetch(`${origin}${path}`, { headers });
        const body = Buffer.from(await get.arrayBuffer());
        const head = await fetch(`${origin}${path}`, { method: "HEAD", headers });

        expect(get.status).toBe(expectedStatus);
        expect(head.status).toBe(expectedStatus);
        expect(get.headers.get("content-length")).toBe(String(body.byteLength));
        expect(head.headers.get("content-length")).toBe(String(body.byteLength));
        expect((await head.arrayBuffer()).byteLength).toBe(0);
        expect(head.headers.get("cache-control")).toBe("no-store");

        if (path.endsWith("/view")) {
          expect(head.headers.get("vary")).toBe("Authorization");
        }
        if (expectedStatus === 401) {
          expect(head.headers.get("www-authenticate")).toBe("MCP-App");
        }
        if (authorized && !saturated) {
          expect(body.toString()).toContain("caf\u00e9 \ud83e\udd9e");
        }
      } finally {
        view.html = originalHtml;
        view.activeRequests = 0;
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it.each(["headers", "body"])(
    "bounds initial serialized fetch %s with a visible outcome",
    async (phase) => {
      const shell = await request({ url: "/__openclaw__/mcp-app" });
      const html = String(shell.end.mock.calls[0]?.[0]);
      const source = /<script>([\s\S]+)<\/script>/u.exec(html)?.[1];
      expect(source).toBeDefined();

      let renderedError = "";
      const timeoutError = Object.assign(new Error("timed out"), { name: "TimeoutError" });
      const initialSignal = AbortSignal.abort(timeoutError);
      const initialTimeout = vi.fn(() => initialSignal);
      const initialFetch = vi.fn(() =>
        phase === "headers"
          ? Promise.reject(timeoutError)
          : Promise.resolve({ ok: true, json: () => Promise.reject(timeoutError) }),
      );

      runInNewContext(source!, {
        AbortSignal: { timeout: initialTimeout },
        URL,
        addEventListener: vi.fn(),
        document: {
          createElement: () => ({ className: "", textContent: "" }),
          getElementById: () => ({
            replaceChildren: (child: { textContent?: string }) => {
              renderedError = child.textContent ?? "";
            },
          }),
        },
        fetch: initialFetch,
        innerWidth: 800,
        location: { hash: "#ticket", origin: "http://127.0.0.1:18789" },
        matchMedia: () => ({ matches: false }),
        navigator: { language: "en" },
        setTimeout,
      });
      await vi.waitFor(() =>
        expect(renderedError).toBe("MCP App view timed out; reload to try again"),
      );
      expect(initialTimeout).toHaveBeenCalledWith(30_000);
      expect(initialFetch).toHaveBeenCalledWith(
        "/__openclaw__/mcp-app/view",
        expect.objectContaining({ signal: initialSignal }),
      );
    },
  );

  it("returns capabilities only for handlers installed on the live view", async () => {
    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs, secret });
    const route = "/__openclaw__/mcp-app/view";
    expect((await request({ url: route })).res.statusCode).toBe(401);
    expect((await request({ url: `${route}?ticket=${issued.ticket}` })).res.statusCode).toBe(401);
    const accepted = await request({ url: route, authorization: `MCP-App ${issued.ticket}` });
    expect(accepted.res.statusCode).toBe(200);
    expect(JSON.parse(String(accepted.end.mock.calls[0]?.[0]))).toMatchObject({
      html: view.html,
      sandboxPort: 18_790,
      serverTools: true,
      serverResources: true,
    });
    expect(
      (await request({ url: route, authorization: `MCP-App ${issued.ticket}` })).res.statusCode,
    ).toBe(200);
    mocks.getMcpAppViewLease.mockReturnValue({ ...view, viewId: "mcp-app-replaced" });
    expect(
      (await request({ url: route, authorization: `MCP-App ${issued.ticket}` })).res.statusCode,
    ).toBe(401);
  });

  it.each([0, 7, "7"])("cancels only the active serialized request %j", async (id) => {
    const host = await createSerializedHost();
    host.emit({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "app-only" } });
    const operation = host.operations[0]!;
    const cancel = { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } };
    host.emit(cancel, { source: {} });
    host.emit(cancel, { origin: "https://untrusted.example" });
    host.emit({ ...cancel, params: { requestId: "unknown" } });
    host.emit({ ...cancel, id: "not-a-notification" });
    expect(operation.signal?.aborted).toBe(false);
    host.emit(cancel);
    expect(operation.signal?.aborted).toBe(true);
    operation.result.resolve("late response");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(host.postMessage.mock.calls.filter(([message]) => message.id === id)).toEqual([]);
    expect(host.timeout).toHaveBeenCalledTimes(1);

    host.emit({ jsonrpc: "2.0", id: "next", method: "tools/call", params: { name: "app-only" } });
    host.emit(cancel);
    expect(host.operations[1]?.signal?.aborted).toBe(false);
    host.operations[1]!.result.resolve("next result");
    await vi.waitFor(() =>
      expect(host.postMessage).toHaveBeenCalledWith(
        { jsonrpc: "2.0", id: "next", result: "next result" },
        "http://127.0.0.1:18790",
      ),
    );
  });

  it.each(["tools/call", "ping", "ui/initialize", "unsupported"])(
    "keeps the original reply when an active ID collides with %s",
    async (method) => {
      const host = await createSerializedHost();
      host.emit({ jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: "app-only" } });
      host.emit({ jsonrpc: "2.0", id: 0, method, params: {} });
      if (method === "ui/initialize") {
        host.emit({ ...host.initialize, id: 0 });
      }
      expect(host.operations).toHaveLength(1);
      expect(host.postMessage).not.toHaveBeenCalled();
      host.operations[0]!.result.resolve("original result");
      await vi.waitFor(() => expect(host.postMessage).toHaveBeenCalledTimes(1));
      expect(host.postMessage).toHaveBeenCalledWith(
        { jsonrpc: "2.0", id: 0, result: "original result" },
        "http://127.0.0.1:18790",
      );
    },
  );

  it.each(["tools/list", "resources/list", "resources/templates/list", "resources/read"])(
    "retires %s when the page closes",
    async (method) => {
      const host = await createSerializedHost();
      host.emit({ jsonrpc: "2.0", id: 1, method, params: {} });
      host.pagehide();
      expect(host.operations[0]?.signal?.aborted).toBe(true);
      host.pageshow(true);
      expect(host.reload).not.toHaveBeenCalled();
      host.emit({ jsonrpc: "2.0", id: 2, method, params: {} });
      expect(host.operations).toHaveLength(1);
      host.operations[0]!.result.resolve("late result");
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(host.postMessage.mock.calls.filter(([message]) => "result" in message)).toEqual([]);
    },
  );

  it("requests one fresh document on a persisted live-host return without replaying work", async () => {
    const host = await createSerializedHost();
    host.emit({ jsonrpc: "2.0", id: "old", method: "tools/call", params: { name: "app-only" } });
    expect(host.operations).toHaveLength(1);
    host.pagehide(true);
    expect(host.operations[0]!.signal?.aborted).toBe(true);
    host.operations[0]!.result.resolve("late result");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(host.postMessage.mock.calls.filter(([message]) => "result" in message)).toEqual([]);
    // Observe the real serialized owner's Location API, not simulated browser cache eligibility.
    host.pageshow(true);
    expect(host.reload).toHaveBeenCalledOnce();
    host.pageshow(true);
    expect(host.reload).toHaveBeenCalledOnce();
    host.emit({ jsonrpc: "2.0", id: "next", method: "tools/call", params: { name: "app-only" } });
    expect(host.operations).toHaveLength(1);
    expect(host.postMessage.mock.calls.filter(([message]) => "result" in message)).toEqual([]);
  });

  it.each([false, true])(
    "keeps an ordinary pageshow callable without reload (persisted=%s)",
    async (persisted) => {
      const host = await createSerializedHost();
      host.pageshow(persisted);
      expect(host.reload).not.toHaveBeenCalled();
      host.emit({ jsonrpc: "2.0", id: "live", method: "tools/call", params: { name: "app-only" } });
      expect(host.operations).toHaveLength(1);
      host.operations[0]!.result.resolve("live result");
      await vi.waitFor(() =>
        expect(host.postMessage).toHaveBeenCalledWith(
          { jsonrpc: "2.0", id: "live", result: "live result" },
          "http://127.0.0.1:18790",
        ),
      );
    },
  );

  it.each(["teardown-pending", "teardown-complete", "failed"])(
    "does not resurrect a terminal %s host after persisted history events",
    async (terminal) => {
      const host = await createSerializedHost({
        operationStatus: terminal === "failed" ? 401 : 200,
      });
      host.emit({ jsonrpc: "2.0", id: "old", method: "tools/call", params: { name: "app-only" } });
      if (terminal === "failed") {
        host.operations[0]!.result.resolve("rejected");
        await vi.waitFor(() => expect(host.frame.remove).toHaveBeenCalledOnce());
      } else {
        host.emit({ jsonrpc: "2.0", method: "ui/notifications/request-teardown" });
        if (terminal === "teardown-complete") {
          const teardown = host.postMessage.mock.calls.find(
            ([message]) => message.method === "ui/resource-teardown",
          )?.[0];
          if (!teardown) {
            throw new Error("Missing host teardown request");
          }
          host.emit({ jsonrpc: "2.0", id: teardown.id, result: {} });
          expect(host.frame.remove).toHaveBeenCalledOnce();
        }
      }
      host.pagehide(true);
      expect(host.operations[0]!.signal?.aborted).toBe(true);
      host.pageshow(true);
      expect(host.reload).not.toHaveBeenCalled();
      host.emit({ jsonrpc: "2.0", id: "next", method: "tools/call", params: { name: "app-only" } });
      expect(host.operations).toHaveLength(1);
      host.operations[0]!.result.resolve("late result");
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(host.postMessage.mock.calls.filter(([message]) => "result" in message)).toEqual([]);
    },
  );

  it.each([
    { persisted: true, outcome: "resolve" },
    { persisted: true, outcome: "reject" },
    { persisted: false, outcome: "resolve" },
    { persisted: false, outcome: "reject" },
  ])(
    "does not publish a retired bootstrap $outcome after pagehide (persisted=$persisted)",
    async ({ persisted, outcome }) => {
      const initialBody = createDeferred<unknown>();
      const host = await createSerializedHost({ initialBody });
      try {
        expect(host.replaceChildren).not.toHaveBeenCalled();
        host.pagehide(persisted);
        if (outcome === "resolve") {
          initialBody.resolve(host.payload);
        } else {
          initialBody.reject(new Error("retired initial body failed"));
        }
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(host.replaceChildren).not.toHaveBeenCalled();
        host.pageshow(true);
        expect(host.reload).toHaveBeenCalledTimes(persisted ? 1 : 0);
        expect(host.operations).toHaveLength(0);
      } finally {
        initialBody.resolve(host.payload);
      }
    },
  );

  it("does not fail the live frame when a retired 401 response body aborts", async () => {
    const host = await createSerializedHost({ abortable401Body: true });
    const cancel = {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "cancelled" },
    };
    host.emit({
      jsonrpc: "2.0",
      id: "cancelled",
      method: "tools/call",
      params: { name: "app-only" },
    });
    try {
      const operation = host.operations[0]!;
      await vi.waitFor(() => expect(operation.response?.bodyUsed).toBe(true));
      host.emit(cancel);
      expect(operation.signal?.aborted).toBe(true);
      expect(operation.signal?.reason.name).toBe("AbortError");
      // Native Response consumption rejects from the stream's actual AbortError; drain promise jobs.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(host.frame.remove).not.toHaveBeenCalled();
      expect(host.replaceChildren).toHaveBeenCalledTimes(1);
      expect(host.postMessage).not.toHaveBeenCalled();
    } finally {
      host.emit(cancel);
    }
  });

  it("accepts a teardown response in the opposite request-ID namespace", async () => {
    const host = await createSerializedHost();
    host.emit({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "app-only" } });
    host.emit({ jsonrpc: "2.0", method: "ui/notifications/request-teardown" });
    expect(host.postMessage).toHaveBeenCalledWith(
      { jsonrpc: "2.0", id: 1, method: "ui/resource-teardown", params: {} },
      "http://127.0.0.1:18790",
    );
    host.emit({ jsonrpc: "2.0", id: 1, result: {} });
    expect(host.frame.remove).toHaveBeenCalledOnce();
    expect(host.operations[0]?.signal?.aborted).toBe(true);
    host.operations[0]!.result.resolve("late result");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(host.postMessage.mock.calls.filter(([message]) => "result" in message)).toEqual([]);
  });

  it.each([false, true])(
    "finishes an async teardown save before unmount (await existing call=%s)",
    async (awaitExisting) => {
      const host = await createSerializedHost();
      const existingReply = createDeferred();
      const savedReply = createDeferred();
      let cleanup: Promise<void> | undefined;
      host.postMessage.mockImplementation((message) => {
        if (message.method === "ui/resource-teardown") {
          cleanup = Promise.resolve().then(async () => {
            if (awaitExisting) {
              await existingReply.promise;
            }
            host.emit({
              jsonrpc: "2.0",
              id: "save",
              method: "tools/call",
              params: { name: "app-only" },
            });
            await savedReply.promise;
            host.emit({ jsonrpc: "2.0", id: message.id, result: {} });
          });
        } else if (message.id === "existing" && "result" in message) {
          existingReply.resolve();
        } else if (message.id === "save" && "result" in message) {
          savedReply.resolve();
        }
      });
      try {
        if (awaitExisting) {
          host.emit({
            jsonrpc: "2.0",
            id: "existing",
            method: "tools/call",
            params: { name: "app-only" },
          });
        }
        host.emit({ jsonrpc: "2.0", method: "ui/notifications/request-teardown" });
        expect(cleanup).toBeDefined();
        expect(host.frame.remove).not.toHaveBeenCalled();
        if (awaitExisting) {
          expect(host.operations[0]!.signal?.aborted).toBe(false);
          host.operations[0]!.result.resolve("existing saved");
        }
        await vi.waitFor(() => expect(host.operations).toHaveLength(awaitExisting ? 2 : 1));
        const save = host.operations.at(-1)!;
        expect(save.signal?.aborted).toBe(false);
        expect(host.frame.remove).not.toHaveBeenCalled();
        save.result.resolve("cleanup saved");
        await cleanup;
        expect(host.postMessage).toHaveBeenCalledWith(
          { jsonrpc: "2.0", id: "save", result: "cleanup saved" },
          "http://127.0.0.1:18790",
        );
        expect(host.frame.remove).toHaveBeenCalledOnce();
        host.timers[0]!.run();
        expect(host.frame.remove).toHaveBeenCalledOnce();
      } finally {
        existingReply.resolve();
        savedReply.resolve();
        await cleanup;
        for (const operation of host.operations) {
          operation.result.resolve("cleanup");
        }
      }
    },
  );

  it.each(["deadline", "pagehide", "persisted-pagehide"])(
    "retires graceful cleanup at %s without replay or late replies",
    async (terminal) => {
      const host = await createSerializedHost();
      const teardown = { jsonrpc: "2.0", method: "ui/notifications/request-teardown" };
      host.emit(teardown);
      host.emit({ jsonrpc: "2.0", id: "save", method: "tools/call", params: { name: "app-only" } });
      expect(host.operations).toHaveLength(1);
      expect(host.operations[0]!.signal?.aborted).toBe(false);
      host.emit(teardown);
      expect(host.timers).toHaveLength(1);
      expect(host.timers[0]!.delayMs).toBe(1_000);
      if (terminal === "deadline") {
        host.timers[0]!.run();
        expect(host.frame.remove).toHaveBeenCalledOnce();
      } else {
        host.pagehide(terminal === "persisted-pagehide");
      }
      expect(host.operations[0]!.signal?.aborted).toBe(true);
      host.pageshow(true);
      expect(host.reload).not.toHaveBeenCalled();
      host.emit({ jsonrpc: "2.0", id: "late", method: "tools/call", params: { name: "app-only" } });
      host.operations[0]!.result.resolve("late save result");
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(host.operations).toHaveLength(1);
      expect(host.postMessage.mock.calls.filter(([message]) => "result" in message)).toEqual([]);
    },
  );

  it("keeps simultaneous numeric and string request IDs independent", async () => {
    const host = await createSerializedHost();
    for (const id of [7, "7"]) {
      host.emit({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "app-only" } });
    }
    expect(host.operations).toHaveLength(2);
    host.emit({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } });
    expect(host.operations[0]?.signal?.aborted).toBe(true);
    expect(host.operations[1]?.signal?.aborted).toBe(false);
    host.operations[0]!.result.resolve("cancelled number");
    host.operations[1]!.result.resolve("live string");
    await vi.waitFor(() => expect(host.postMessage).toHaveBeenCalledTimes(1));
    expect(host.postMessage).toHaveBeenCalledWith(
      { jsonrpc: "2.0", id: "7", result: "live string" },
      "http://127.0.0.1:18790",
    );
  });

  it("does not let a retired completion affect a reused request ID", async () => {
    const host = await createSerializedHost();
    const call = { jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: "app-only" } };
    host.emit(call);
    host.emit({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 0 } });
    // MCP forbids session ID reuse; old completion cleanup must still be harmless.
    host.emit(call);
    host.operations[0]!.result.resolve("retired result");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(host.postMessage).not.toHaveBeenCalled();
    host.operations[1]!.result.resolve("current result");
    await vi.waitFor(() => expect(host.postMessage).toHaveBeenCalledTimes(1));
    expect(host.postMessage).toHaveBeenCalledWith(
      { jsonrpc: "2.0", id: 0, result: "current result" },
      "http://127.0.0.1:18790",
    );
  });

  it("executes only owning-server app-visible allowed tools and resources", async () => {
    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs, secret });
    const invoke = (body: unknown) =>
      request({
        url: "/__openclaw__/mcp-app/view",
        method: "POST",
        authorization: `MCP-App ${issued.ticket}`,
        body,
      });

    const tool = await invoke({
      method: "tools/call",
      params: { name: "app-only", arguments: {} },
    });
    expect(tool.res.statusCode).toBe(200);
    expect(runtime.callTool).toHaveBeenCalledWith("demo", "app-only", {});
    const resource = await invoke({ method: "resources/read", params: { uri: "ui://demo/state" } });
    expect(resource.res.statusCode).toBe(200);
    expect(runtime.readResource).toHaveBeenCalledWith("demo", "ui://demo/state");

    for (const name of ["model-only", "not-allowed", "cross-only"]) {
      expect(
        (await invoke({ method: "tools/call", params: { name, arguments: {} } })).res.statusCode,
      ).toBe(403);
    }
    expect(runtime.callTool).toHaveBeenCalledTimes(1);
    expect(releaseRuntimeLease).toHaveBeenCalled();
    expect(mocks.completeRetirement).toHaveBeenCalledWith(runtime);
  });

  it("inherits post-catalog grant revalidation from the shared operation boundary", async () => {
    const catalogStarted = createDeferred();
    const releaseCatalog = createDeferred<Awaited<ReturnType<typeof runtime.getCatalog>>>();
    runtime.getCatalog.mockImplementationOnce(async () => {
      catalogStarted.resolve();
      return await releaseCatalog.promise;
    });
    let grantActive = true;
    view.authorizeAppInteraction = vi.fn(async () => grantActive);
    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs, secret });

    const pending = request({
      url: "/__openclaw__/mcp-app/view",
      method: "POST",
      authorization: `MCP-App ${issued.ticket}`,
      body: { method: "tools/call", params: { name: "app-only", arguments: {} } },
    });
    await catalogStarted.promise;
    expect(view.authorizeAppInteraction).toHaveBeenCalledOnce();
    grantActive = false;
    releaseCatalog.resolve({
      tools: [{ serverName: "demo", toolName: "app-only", uiVisibility: ["app"] }],
    });

    const denied = await pending;
    expect(denied.res.statusCode).toBe(403);
    expect(view.authorizeAppInteraction).toHaveBeenCalledTimes(2);
    expect(runtime.callTool).not.toHaveBeenCalled();
  });

  it("denies resource reads from reconstructed read-only views", async () => {
    Object.assign(view, { readOnly: true });
    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs, secret });
    const payload = await request({
      url: "/__openclaw__/mcp-app/view",
      authorization: `MCP-App ${issued.ticket}`,
    });
    expect(JSON.parse(String(payload.end.mock.calls[0]?.[0]))).toMatchObject({
      serverResources: false,
    });
    const invoke = (body: unknown) =>
      request({
        url: "/__openclaw__/mcp-app/view",
        method: "POST",
        authorization: `MCP-App ${issued.ticket}`,
        body,
      });
    expect(
      (await invoke({ method: "tools/call", params: { name: "app-only", arguments: {} } })).res
        .statusCode,
    ).toBe(403);
    expect(
      (await invoke({ method: "resources/read", params: { uri: "ui://demo/state" } })).res
        .statusCode,
    ).toBe(403);
    expect(runtime.readResource).not.toHaveBeenCalled();
  });

  it("does not accept standalone server operations without explicit run authority", async () => {
    Object.assign(view, { allowedAppToolNames: undefined });
    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs, secret });
    const invoke = (body: unknown) =>
      request({
        url: "/__openclaw__/mcp-app/view",
        method: "POST",
        authorization: `MCP-App ${issued.ticket}`,
        body,
      });

    expect((await invoke({ method: "tools/list", params: {} })).res.statusCode).toBe(403);
    expect(
      (await invoke({ method: "tools/call", params: { name: "app-only", arguments: {} } })).res
        .statusCode,
    ).toBe(403);
    expect(
      (await invoke({ method: "resources/read", params: { uri: "ui://demo/state" } })).res
        .statusCode,
    ).toBe(403);
    expect(runtime.callTool).not.toHaveBeenCalled();
  });

  it("revalidates expiry and enforces request concurrency through the ticket boundary", async () => {
    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs, secret });
    const invoke = (now: number) =>
      request({
        url: "/__openclaw__/mcp-app/view",
        method: "POST",
        authorization: `MCP-App ${issued.ticket}`,
        now,
        body: { method: "resources/list", params: {} },
      });
    view.activeRequests = 4;
    expect(
      (
        await request({
          url: "/__openclaw__/mcp-app/view",
          authorization: `MCP-App ${issued.ticket}`,
          now: nowMs,
        })
      ).res.statusCode,
    ).toBe(429);
    expect((await invoke(nowMs)).res.statusCode).toBe(403);
    view.activeRequests = 0;
    expect((await invoke(issued.expiresAtMs + 1)).res.statusCode).toBe(401);

    const clock = vi
      .fn<() => number>()
      .mockReturnValueOnce(nowMs)
      .mockReturnValueOnce(issued.expiresAtMs + 1);
    expect(
      (
        await request({
          url: "/__openclaw__/mcp-app/view",
          method: "POST",
          authorization: `MCP-App ${issued.ticket}`,
          clock,
          body: { method: "resources/list", params: {} },
        })
      ).res.statusCode,
    ).toBe(401);
    expect(clock).toHaveBeenCalledTimes(2);
  });

  it("is path-scoped and rejects malformed operations", async () => {
    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs, secret });
    expect((await request({ url: "/__openclaw__/mcp-app", method: "POST" })).res.statusCode).toBe(
      404,
    );
    expect((await request({ url: "/__openclaw__/mcp-app/other" })).handled).toBe(false);
    expect(
      (
        await request({
          url: "/__openclaw__/mcp-app/view",
          method: "POST",
          authorization: `MCP-App ${issued.ticket}`,
          body: { method: "gateway.call", params: {} },
        })
      ).res.statusCode,
    ).toBe(400);
  });
});

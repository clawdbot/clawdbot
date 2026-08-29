// HTTP request trace tests ensure gateway request scope reaches logs and
// diagnostic events for per-request debugging.
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../infra/diagnostic-events.js";
import {
  getActiveDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { getLogger, resetLogger, setLoggerOverride } from "../logging.js";
import { flushLogger } from "../logging/logger.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { createGatewayHttpServer } from "./server-http.js";
import { createGatewayTestRegistry } from "./server/__tests__/test-utils.js";
import { createGatewayPluginRequestHandler } from "./server/plugins-http.js";
import { withTempConfig } from "./test-temp-config.js";

const resolvedAuth: ResolvedGatewayAuth = { mode: "none", allowTailscale: false };

async function listen(server: ReturnType<typeof createGatewayHttpServer>): Promise<number> {
  return await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

async function closeServer(server: ReturnType<typeof createGatewayHttpServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

afterEach(() => {
  resetDiagnosticEventsForTest();
  setLoggerOverride(null);
  resetLogger();
});

describe("gateway HTTP request trace scope", () => {
  it("threads active request trace through logs and diagnostics", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-request-trace-"));
    const logPath = path.join(dir, "gateway.log");
    const events: Array<{ trace?: DiagnosticTraceContext; type: string }> = [];
    const stop = onDiagnosticEvent((event) => {
      events.push({ trace: event.trace, type: event.type });
    });
    let activeTraceInHandler: DiagnosticTraceContext | undefined;

    await withTempConfig({
      cfg: { gateway: { auth: { mode: "none" } } },
      run: async () => {
        setLoggerOverride({ level: "info", file: logPath });
        const httpServer = createGatewayHttpServer({
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/__control__",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async (_req, res) => {
            activeTraceInHandler = getActiveDiagnosticTraceContext();
            getLogger().info({ route: "/hook" }, "handled request trace");
            emitDiagnosticEvent({ type: "message.queued", source: "gateway-test" });
            res.statusCode = 204;
            res.end();
            return true;
          },
          resolvedAuth,
        });
        const port = await listen(httpServer);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/hook`);
          expect(response.status).toBe(204);
        } finally {
          await closeServer(httpServer);
        }
      },
    });

    stop();
    try {
      expect(activeTraceInHandler?.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(activeTraceInHandler?.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(events).toEqual([{ trace: activeTraceInHandler, type: "message.queued" }]);

      // The file transport appends asynchronously; drain it before reading.
      await flushLogger();
      const traceRecord = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((record) => record.message === "handled request trace");
      expect(traceRecord?.traceId).toBe(activeTraceInHandler?.traceId);
      expect(traceRecord?.spanId).toBe(activeTraceInHandler?.spanId);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gateway HTTP request error cleanup", () => {
  it.each([
    { label: "completed", destroy: false },
    { label: "destroyed", destroy: true },
  ])("does not invoke later routes after an earlier response is $label", async ({ destroy }) => {
    const handleWatchNodeRequest = vi.fn(async () => true);
    const server = createGatewayHttpServer({
      clients: new Set(),
      controlUiEnabled: false,
      controlUiBasePath: "",
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      handleHooksRequest: async (_req, res) => {
        if (destroy) {
          res.destroy();
        } else {
          res.end("already finished");
        }
        return false;
      },
      handleWatchNodeRequest,
      resolvedAuth,
      getRuntimeConfig: () => ({}),
    });
    const port = await listen(server);

    try {
      const request = fetch(`http://127.0.0.1:${port}/api/nodes/watch/example`);
      if (destroy) {
        await expect(request).rejects.toMatchObject({ name: "TypeError" });
      } else {
        const response = await request;
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("already finished");
      }
      expect(handleWatchNodeRequest).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await closeServer(server);
    }
  });

  it("preserves a response the route already completed before throwing", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = createGatewayHttpServer({
      clients: new Set(),
      controlUiEnabled: false,
      controlUiBasePath: "",
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      handleHooksRequest: async (_req, res) => {
        res.end("complete");
        throw new Error("route failed after completing a response");
      },
      resolvedAuth,
      getRuntimeConfig: () => ({}),
    });
    const port = await listen(server);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/hooks/test`, {
        signal: AbortSignal.timeout(1_000),
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("complete");
      expect(errorLog).toHaveBeenCalledWith(
        "[gateway-http] unhandled error in request handler:",
        expect.any(Error),
      );
    } finally {
      server.closeAllConnections();
      await closeServer(server);
      errorLog.mockRestore();
    }
  });

  it("aborts an incomplete unframed response after its route throws", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = createGatewayHttpServer({
      clients: new Set(),
      controlUiEnabled: false,
      controlUiBasePath: "",
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      handleHooksRequest: async (_req, res) => {
        res.write("partial");
        throw new Error("route failed after writing a partial response");
      },
      resolvedAuth,
      getRuntimeConfig: () => ({}),
    });
    const port = await listen(server);

    try {
      await expect(
        fetch(`http://127.0.0.1:${port}/hooks/test`, {
          signal: AbortSignal.timeout(1_000),
        }).then(async (response) => await response.text()),
      ).rejects.toMatchObject({ name: "TypeError" });
      expect(errorLog).toHaveBeenCalledWith(
        "[gateway-http] unhandled error in request handler:",
        expect.any(Error),
      );
    } finally {
      server.closeAllConnections();
      await closeServer(server);
      errorLog.mockRestore();
    }
  });

  it.each([
    {
      label: "setHeader",
      setContentLength: (res: ServerResponse) => res.setHeader("Content-Length", "10"),
    },
    {
      label: "writeHead",
      setContentLength: (res: ServerResponse) => res.writeHead(200, { "Content-Length": "10" }),
    },
  ])("closes an incomplete $label fixed-length response", async ({ setContentLength }) => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = createGatewayHttpServer({
      clients: new Set(),
      controlUiEnabled: false,
      controlUiBasePath: "",
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      handleHooksRequest: async (_req, res) => {
        setContentLength(res);
        res.write("partial");
        throw new Error("route failed before completing its fixed-length response");
      },
      resolvedAuth,
      getRuntimeConfig: () => ({}),
    });
    const port = await listen(server);

    try {
      await expect(
        fetch(`http://127.0.0.1:${port}/hooks/test`, {
          signal: AbortSignal.timeout(1_000),
        }).then(async (response) => await response.text()),
      ).rejects.toMatchObject({ name: "TypeError" });
    } finally {
      server.closeAllConnections();
      await closeServer(server);
      errorLog.mockRestore();
    }
  });

  describe.each(["hook", "plugin"] as const)("uncommitted %s response failures", (owner) => {
    it.each([
      { label: "no staged headers", headers: {}, method: "GET" },
      { label: "short length", headers: { "Content-Length": "1" }, method: "GET" },
      { label: "long length", headers: { "Content-Length": "1000" }, method: "GET" },
      { label: "gzip", headers: { "Content-Encoding": "gzip" }, method: "GET" },
      {
        label: "chunked trailers",
        headers: { "Transfer-Encoding": "chunked", Trailer: "Digest" },
        method: "GET",
      },
      { label: "HEAD length", headers: { "Content-Length": "1000" }, method: "HEAD" },
      {
        label: "cached download",
        headers: {
          "Cache-Control": "public, max-age=31536000",
          "Content-Disposition": "attachment; filename=report.txt",
          "Content-Range": "bytes 0-99/1000",
          "Content-Language": "fr",
          "Content-Location": "/report.txt",
          ETag: '"report-version"',
          "Last-Modified": "Wed, 26 Aug 2026 12:00:00 GMT",
        },
        method: "GET",
      },
    ])("returns a complete plain 500 after $label", async ({ headers, method }) => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      const route = async (_req: IncomingMessage, res: ServerResponse) => {
        for (const [name, value] of Object.entries(headers)) {
          res.setHeader(name, value);
        }
        res.statusMessage = "Download Ready";
        res.setHeader("Access-Control-Allow-Origin", "https://example.test");
        throw new Error("route failed before writing a response");
      };
      const handlePluginRequest = createGatewayPluginRequestHandler({
        registry: createGatewayTestRegistry({
          httpRoutes: [
            {
              pluginId: "route",
              source: "route",
              path: "/failure",
              auth: "plugin",
              match: "exact",
              handler: route,
            },
          ],
        }),
        log: { warn: vi.fn() } as unknown as Parameters<
          typeof createGatewayPluginRequestHandler
        >[0]["log"],
      });
      const server = createGatewayHttpServer({
        clients: new Set(),
        controlUiEnabled: false,
        controlUiBasePath: "",
        openAiChatCompletionsEnabled: false,
        openResponsesEnabled: false,
        handleHooksRequest: owner === "hook" ? route : async () => false,
        handlePluginRequest: owner === "plugin" ? handlePluginRequest : undefined,
        shouldEnforcePluginGatewayAuth: () => false,
        resolvedAuth,
        getRuntimeConfig: () => ({}),
      });
      const port = await listen(server);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/failure`, {
          method,
          signal: AbortSignal.timeout(1_000),
        });

        expect(response.status).toBe(500);
        expect.soft(response.statusText).toBe("Internal Server Error");
        expect(await response.text()).toBe(method === "HEAD" ? "" : "Internal Server Error");
        expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        expect(response.headers.get("content-length")).toBe("21");
        expect(response.headers.get("content-encoding")).toBeNull();
        expect(response.headers.get("transfer-encoding")).toBeNull();
        expect(response.headers.get("trailer")).toBeNull();
        expect.soft(response.headers.get("cache-control")).toBe("no-store");
        for (const header of [
          "content-disposition",
          "content-range",
          "content-language",
          "content-location",
          "etag",
          "last-modified",
        ]) {
          expect.soft(response.headers.get(header), header).toBeNull();
        }
        expect(response.headers.get("access-control-allow-origin")).toBe("https://example.test");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      } finally {
        server.closeAllConnections();
        await closeServer(server);
        errorLog.mockRestore();
      }
    });
  });

  it("preserves plugin route ownership when plugin dispatch fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const handlePluginRequest = vi.fn(async () => {
      throw new Error("plugin route dispatch failed");
    });
    const server = createGatewayHttpServer({
      clients: new Set(),
      controlUiEnabled: false,
      controlUiBasePath: "",
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      handleHooksRequest: async () => false,
      handlePluginRequest,
      resolvedAuth,
      getRuntimeConfig: () => ({}),
    });
    const port = await listen(server);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/plugin-failure`);

      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Internal Server Error");
      expect(handlePluginRequest).toHaveBeenCalledOnce();
      expect(errorLog).toHaveBeenCalledWith(
        "[gateway-http] unhandled error in request handler:",
        expect.objectContaining({ message: "plugin route dispatch failed" }),
      );
    } finally {
      server.closeAllConnections();
      await closeServer(server);
      errorLog.mockRestore();
    }
  });
});

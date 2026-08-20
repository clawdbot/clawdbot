// HTTP request trace tests ensure gateway request scope reaches logs and
// diagnostic events for per-request debugging.
import fs from "node:fs";
import type { ServerResponse } from "node:http";
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

  it("preserves the 500 response when its route fails before writing headers", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = createGatewayHttpServer({
      clients: new Set(),
      controlUiEnabled: false,
      controlUiBasePath: "",
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      handleHooksRequest: async () => {
        throw new Error("route failed before writing a response");
      },
      resolvedAuth,
      getRuntimeConfig: () => ({}),
    });
    const port = await listen(server);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/hooks/test`);

      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Internal Server Error");
    } finally {
      server.closeAllConnections();
      await closeServer(server);
      errorLog.mockRestore();
    }
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

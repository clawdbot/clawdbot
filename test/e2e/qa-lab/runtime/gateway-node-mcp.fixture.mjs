#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

const READY_TYPE = "openclaw-mcp-parity-ready";

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function createProbeServer(label, catalogState = { rotated: false }) {
  const server = new McpServer({ name: `openclaw-mcp-parity-${label}`, version: "1.0.0" });
  const initialToolConfig = {
    description: `MCP parity probe for ${label}`,
    inputSchema: { marker: z.string() },
  };
  const rotatedToolConfig = {
    description: `Rotated MCP parity probe for ${label}`,
    inputSchema: { marker: z.string(), revision: z.string().optional() },
  };
  const result = (resultLabel, marker) => ({
    content: [
      { type: "text", text: JSON.stringify({ label: resultLabel, marker, pid: process.pid }) },
    ],
  });
  const runProbe = async ({ marker }) => {
    if (marker === "rotate-remove" && !catalogState.rotated) {
      catalogState.rotated = true;
      registeredProbe.update({
        name: "parity_rotated",
        paramsSchema: rotatedToolConfig.inputSchema,
      });
    }
    const response = result(label, marker);
    return marker.startsWith("error-")
      ? {
          ...response,
          structuredContent: { label, marker, retryable: true },
          isError: true,
        }
      : response;
  };
  const registeredProbe = catalogState.rotated
    ? server.registerTool("parity_rotated", rotatedToolConfig, runProbe)
    : server.registerTool("parity_probe", initialToolConfig, runProbe);
  server.registerTool("parity_hidden", initialToolConfig, async ({ marker }) =>
    result(`${label}-hidden`, marker),
  );
  return server;
}

function installSignalShutdown(shutdown) {
  let stopping;
  const stop = () => {
    stopping ??= shutdown().catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function runStdio() {
  const label = readOption("--label")?.trim() || "stdio";
  const server = createProbeServer(label);
  installSignalShutdown(async () => await server.close());
  await server.connect(new StdioServerTransport());
}

async function runHttp() {
  const labelPrefix = readOption("--label-prefix")?.trim();
  if (!labelPrefix) {
    throw new Error("HTTP mode requires --label-prefix");
  }
  const app = createMcpExpressApp();
  const sessions = new Map();
  const records = new Set();
  const catalogState = { rotated: false };
  const route = (handler) => (req, res, next) => void handler(req, res).catch(next);
  const rpcError = (res, code, message) =>
    res.status(code === -32603 ? 500 : 400).json({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    });

  function track(server, transport) {
    const record = { server, transport };
    records.add(record);
    // The MCP SDK exposes callback properties rather than an EventTarget surface.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    transport.onclose = () => {
      records.delete(record);
      const sessionId = transport.sessionId;
      if (sessionId) {
        sessions.delete(sessionId);
      }
    };
    return record;
  }

  async function handleStreamableRequest(req, res) {
    try {
      const sessionId = req.headers["mcp-session-id"];
      let transport;
      if (typeof sessionId === "string") {
        const record = sessions.get(sessionId);
        if (!(record?.transport instanceof StreamableHTTPServerTransport)) {
          rpcError(res, -32000, "Unknown Streamable HTTP session");
          return;
        }
        if (req.body?.params?.arguments?.marker === "expire-session") {
          sessions.delete(sessionId);
          res.status(404).json({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: req.body?.id ?? null,
          });
          return;
        }
        transport = record.transport;
      } else if (req.method === "POST" && isInitializeRequest(req.body)) {
        const createdTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (createdSessionId) => {
            sessions.set(createdSessionId, record);
          },
        });
        const server = createProbeServer(`${labelPrefix}-streamable-http`, catalogState);
        const record = track(server, createdTransport);
        transport = createdTransport;
        await server.connect(createdTransport);
      } else {
        rpcError(res, -32000, "Missing Streamable HTTP session");
        return;
      }
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      process.stderr.write(`Streamable HTTP request failed: ${String(error)}\n`);
      if (!res.headersSent) {
        rpcError(res, -32603, "Internal server error");
      }
    }
  }

  app.all("/mcp", route(handleStreamableRequest));

  async function handleSseConnect(_req, res) {
    const transport = new SSEServerTransport("/messages", res);
    const server = createProbeServer(`${labelPrefix}-sse`, catalogState);
    const record = track(server, transport);
    sessions.set(transport.sessionId, record);
    await server.connect(transport);
  }

  app.get("/sse", route(handleSseConnect));

  async function handleSseMessage(req, res) {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
    const record = sessions.get(sessionId);
    if (!(record?.transport instanceof SSEServerTransport)) {
      res.status(400).send("Unknown SSE session");
      return;
    }
    await record.transport.handlePostMessage(req, res, req.body);
  }

  app.post("/messages", route(handleSseMessage));

  const httpServer = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP MCP fixture did not bind a TCP port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  process.stdout.write(
    `${JSON.stringify({
      type: READY_TYPE,
      urls: {
        streamableHttp: `${baseUrl}/mcp`,
        sse: `${baseUrl}/sse`,
      },
    })}\n`,
  );

  installSignalShutdown(async () => {
    await Promise.allSettled([...records].map((record) => record.server.close()));
    httpServer.closeAllConnections?.();
    await new Promise((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

const mode = process.argv[2];
if (mode === "stdio") {
  await runStdio();
} else if (mode === "http") {
  await runHttp();
} else {
  throw new Error(
    "usage: gateway-node-mcp.fixture.mjs stdio --label <label> | http --label-prefix <prefix>",
  );
}

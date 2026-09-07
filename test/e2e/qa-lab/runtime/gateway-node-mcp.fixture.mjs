#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

const READY_TYPE = "openclaw-mcp-parity-ready";
const APP_URI = "ui://parity/app";

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function buildProbeResult({ label, marker, generation, expiryCalls }) {
  if (marker === "expiry-stats") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ label, marker, pid: process.pid, expiryCalls: expiryCalls ?? 0 }),
        },
      ],
    };
  }
  if (marker === "empty-error") {
    return { content: [], isError: true };
  }
  if (marker === "rich-result") {
    return {
      content: [
        { type: "text", text: "mirrored" },
        { type: "resource_link", uri: "memo://report", name: "report", title: "Report" },
        { type: "resource", resource: { uri: "memo://one", text: "memo body" } },
        { type: "audio", data: "AAAA", mimeType: "audio/mpeg" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ],
      structuredContent: { label, marker, rich: true },
    };
  }
  const response = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          label,
          marker,
          pid: process.pid,
          ...(generation === undefined ? {} : { generation }),
        }),
      },
    ],
  };
  return marker.startsWith("error-")
    ? {
        ...response,
        structuredContent: { label, marker, retryable: true },
        isError: true,
      }
    : response;
}

function waitForFile(filePath) {
  if (fs.existsSync(filePath)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const directory = path.dirname(filePath);
    const filename = path.basename(filePath);
    const watcher = fs.watch(directory, (_event, changed) => {
      if (changed && changed.toString() !== filename) {
        return;
      }
      if (fs.existsSync(filePath)) {
        watcher.close();
        resolve();
      }
    });
    watcher.once("error", reject);
    if (fs.existsSync(filePath)) {
      watcher.close();
      resolve();
    }
  });
}

async function holdNextCatalogList(catalogGate) {
  if (
    !catalogGate?.notificationSent ||
    catalogGate.claimed ||
    !fs.existsSync(path.join(catalogGate.directory, "arm"))
  ) {
    return;
  }
  catalogGate.claimed = true;
  fs.writeFileSync(path.join(catalogGate.directory, "started"), "started\n", { flag: "wx" });
  await waitForFile(path.join(catalogGate.directory, "release"));
}

function createProbeServer(label, catalogState = { rotated: false }, control = {}) {
  catalogState.generations ??= {};
  const generation = (catalogState.generations[label] ?? 0) + 1;
  catalogState.generations[label] = generation;
  const server = new McpServer({ name: `openclaw-mcp-parity-${label}`, version: "1.0.0" });
  const initialToolConfig = {
    description: `MCP parity probe for ${label}`,
    inputSchema: { marker: z.string() },
  };
  const rotatedToolConfig = {
    description: `Rotated MCP parity probe for ${label}`,
    inputSchema: { marker: z.string(), revision: z.string().optional() },
  };
  const runProbe = async ({ marker }) => {
    if (marker === "break-notifications") {
      control.breakNotifications?.();
    }
    if (marker === "crash-generation") {
      control.crashGeneration?.();
    }
    if (marker === "rotate-remove" && !catalogState.rotated) {
      catalogState.rotated = true;
      registeredProbe.update({
        name: "parity_rotated",
        paramsSchema: rotatedToolConfig.inputSchema,
      });
    }
    return buildProbeResult({
      label,
      marker,
      generation,
      expiryCalls: catalogState.expiryCalls,
    });
  };
  const registeredProbe = catalogState.rotated
    ? server.registerTool("parity_rotated", rotatedToolConfig, runProbe)
    : server.registerTool("parity_probe", initialToolConfig, runProbe);
  server.registerTool("parity_hidden", initialToolConfig, async ({ marker }) =>
    buildProbeResult({ label: `${label}-hidden`, marker, generation }),
  );
  if (control.appFixture) {
    const appTool = server.registerTool("parity_app", initialToolConfig, async ({ marker }) => {
      fs.appendFileSync(
        control.appFixture.eventPath,
        `${JSON.stringify({ type: "parity_app_call", marker })}\n`,
      );
      if (marker === "notify-list-changed") {
        control.appFixture.catalogGate.notificationSent = true;
        server.sendToolListChanged();
        // The SDK helper is fire-and-forget. Yield once so the notification is
        // queued before the successful call lets the next request begin.
        await new Promise((resolve) => setImmediate(resolve));
      }
      return buildProbeResult({ label: `${label}-app`, marker, generation });
    });
    appTool.update({ _meta: { ui: { resourceUri: APP_URI } } });
    server.registerResource(
      "parity_app",
      APP_URI,
      { mimeType: "text/html;profile=mcp-app" },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "text/html;profile=mcp-app",
            text: "<!doctype html><main>Parity MCP App</main>",
            _meta: { ui: { csp: { connectDomains: [] } } },
          },
        ],
      }),
    );
  }
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
  if (process.env.MCP_STRESS_STARTUP_INVERSION === "1") {
    await runStressStdio(label);
    return;
  }
  const eventPath = process.env.MCP_STRESS_EVENT_PATH;
  let descendant;
  if (eventPath) {
    descendant = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    fs.appendFileSync(
      eventPath,
      `${JSON.stringify({ leaderPid: process.pid, descendantPid: descendant.pid })}\n`,
    );
  }
  const server = createProbeServer(label, undefined, {
    crashGeneration: () => setTimeout(() => process.exit(1), 25),
  });
  installSignalShutdown(async () => await server.close());
  await server.connect(new StdioServerTransport());
}

async function runStressStdio(label) {
  const eventPath = process.env.MCP_STRESS_EVENT_PATH;
  const descendant = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  if (eventPath) {
    fs.appendFileSync(
      eventPath,
      `${JSON.stringify({ leaderPid: process.pid, descendantPid: descendant.pid })}\n`,
    );
  }
  let buffer = "";
  let listCount = 0;
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const tools = (name) => [
    {
      name,
      description: `MCP stress probe for ${label}`,
      inputSchema: {
        type: "object",
        properties: { marker: { type: "string" } },
        required: ["marker"],
      },
    },
  ];
  const handle = (message) => {
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "stress-stdio", version: "1" },
        },
      });
      return;
    }
    if (message.method === "notifications/initialized") {
      return;
    }
    if (message.method === "tools/list") {
      listCount += 1;
      if (listCount === 1) {
        send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      }
      const response = {
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: tools(listCount === 1 ? "parity_stale" : "parity_probe") },
      };
      setTimeout(() => send(response), listCount === 1 ? 125 : 0);
      return;
    }
    if (message.method !== "tools/call") {
      return;
    }
    const marker = message.params?.arguments?.marker ?? "";
    const result = buildProbeResult({ label, marker });
    send({ jsonrpc: "2.0", id: message.id, result });
    if (marker === "crash-generation") {
      setTimeout(() => process.exit(1), 25);
    }
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.trim()) {
        handle(JSON.parse(line));
      }
    }
  });
  const stop = () => process.exit(0);
  process.stdin.on("end", stop);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

async function runHttp() {
  const labelPrefix = readOption("--label-prefix")?.trim();
  if (!labelPrefix) {
    throw new Error("HTTP mode requires --label-prefix");
  }
  const app = createMcpExpressApp();
  const sessions = new Map();
  const pendingSessionExpirations = new Map();
  const records = new Set();
  const catalogState = { rotated: false, expiryCalls: 0 };
  const appFixtureEnabled = process.env.MCP_APP_GRANT_REVALIDATION_FIXTURE === "1";
  const catalogGateDirectory = process.env.MCP_APP_CATALOG_GATE_DIR;
  const appEventPath = process.env.MCP_APP_EVENT_PATH;
  if (appFixtureEnabled && (!catalogGateDirectory || !appEventPath)) {
    throw new Error("MCP App grant fixture requires catalog gate and event paths");
  }
  const catalogGate = appFixtureEnabled
    ? { directory: catalogGateDirectory, notificationSent: false, claimed: false }
    : undefined;
  const appFixture =
    catalogGate && appEventPath ? { catalogGate, eventPath: appEventPath } : undefined;
  let failStreamableGets = 0;
  let terminalSseOnce = false;
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
      if (req.method === "GET" && failStreamableGets > 0) {
        failStreamableGets -= 1;
        res.status(503).send("notification stream unavailable");
        return;
      }
      const sessionId = req.headers["mcp-session-id"];
      let transport;
      if (typeof sessionId === "string") {
        const marker = req.body?.params?.arguments?.marker;
        if (marker === "expire-session" || marker === "expire-concurrent-session") {
          catalogState.expiryCalls += 1;
          const pending = pendingSessionExpirations.get(sessionId) ?? [];
          pending.push({ response: res, id: req.body?.id ?? null });
          if (marker === "expire-concurrent-session" && pending.length < 2) {
            // Expire only after both calls reach this session. The first 404
            // otherwise retires the transport before the second request arrives.
            pendingSessionExpirations.set(sessionId, pending);
            return;
          }
          pendingSessionExpirations.delete(sessionId);
          sessions.delete(sessionId);
          for (const { response, id } of pending) {
            response.status(404).json({
              jsonrpc: "2.0",
              error: { code: -32001, message: "Session not found" },
              id,
            });
          }
          return;
        }
        const record = sessions.get(sessionId);
        if (!(record?.transport instanceof StreamableHTTPServerTransport)) {
          rpcError(res, -32000, "Unknown Streamable HTTP session");
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
        const server = createProbeServer(`${labelPrefix}-streamable-http`, catalogState, {
          appFixture,
          breakNotifications: () => {
            failStreamableGets = 2;
            setTimeout(() => createdTransport.closeStandaloneSSEStream(), 25);
          },
        });
        const record = track(server, createdTransport);
        transport = createdTransport;
        await server.connect(createdTransport);
      } else {
        rpcError(res, -32000, "Missing Streamable HTTP session");
        return;
      }
      if (req.method === "POST" && req.body?.method === "tools/list") {
        await holdNextCatalogList(catalogGate);
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
    if (terminalSseOnce) {
      terminalSseOnce = false;
      res.status(204).end();
      return;
    }
    const transport = new SSEServerTransport("/messages", res);
    const server = createProbeServer(`${labelPrefix}-sse`, catalogState, {
      breakNotifications: () => {
        terminalSseOnce = true;
        setTimeout(() => void transport.close().catch(() => {}), 25);
      },
    });
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

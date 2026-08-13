// Proves local Ollama inference crosses a real Gateway and paired node socket.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginNodeHostCommand } from "openclaw/plugin-sdk/plugin-entry";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import { createOllamaNodeHostCommands } from "./node-inference.js";

const E2E_TIMEOUT_MS = 90_000;
// Match the shared Gateway fixture and reserve separate bounded post-start phases.
const STARTUP_TIMEOUT_MS = Math.floor((E2E_TIMEOUT_MS * 2) / 3);
const CLEANUP_RESERVE_MS = 10_000;
const INFERENCE_TIMEOUT_MS = 10_000;
const CONNECT_ATTEMPT_TIMEOUT_MS = 5_000;
const GATEWAY_READINESS_TIMEOUT_MS =
  E2E_TIMEOUT_MS - STARTUP_TIMEOUT_MS - INFERENCE_TIMEOUT_MS - CLEANUP_RESERVE_MS;
const NODE_DISPLAY_NAME = "paired-ollama-e2e";
const NODE_MODEL = "node-local:latest";
const LOADED_NODE_MODEL = "loaded-node-local:latest";

type FakeOllama = {
  baseUrl: string;
  chatRequests: Array<Record<string, unknown>>;
  paths: string[];
  close: () => Promise<void>;
};

type NodeInvokeFrame = {
  id?: string;
  nodeId?: string;
  command?: string;
  params?: unknown;
  paramsJSON?: string | null;
};

describe("Ollama paired-node Gateway inference", () => {
  it(
    "routes authenticated discovery and chat over the actual paired node socket",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const nodeOllama = await startFakeOllama("node");
      const gatewayOllama = await startFakeOllama("gateway");
      const state = await createOpenClawTestState({
        label: "ollama-paired-node-e2e",
        layout: "home",
      });
      const gatewayPort = await reserveLoopbackPort();
      const gatewayToken = `ollama-e2e-${randomUUID()}`;
      const gatewayLogs: string[] = [];
      const handlerErrors: Error[] = [];
      let gateway: ChildProcessWithoutNullStreams | undefined;
      let operator: GatewayClient | undefined;
      let node: GatewayClient | undefined;

      try {
        await state.writeConfig({
          gateway: {
            mode: "local",
            port: gatewayPort,
            bind: "loopback",
            auth: { mode: "token", token: gatewayToken },
            controlUi: { enabled: false },
            nodes: { commands: { allow: ["ollama.models", "ollama.chat"] } },
          },
          plugins: {
            allow: ["ollama"],
          },
          agents: {
            defaults: { heartbeat: { every: "0m" }, skipBootstrap: true },
            entries: { main: { default: true, tools: { allow: ["node_inference"] } } },
          },
          models: {
            providers: {
              ollama: { api: "ollama", baseUrl: gatewayOllama.baseUrl, models: [] },
            },
          },
        });

        gateway = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "src/entry.ts",
            "gateway",
            "--port",
            String(gatewayPort),
            "--bind",
            "loopback",
            "--allow-unconfigured",
          ],
          {
            cwd: process.cwd(),
            env: {
              ...state.env,
              OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(process.cwd(), "extensions"),
              OPENCLAW_CLI: "1",
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
              OPENCLAW_GATEWAY_TOKEN: gatewayToken,
              OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
              OPENCLAW_NO_RESPAWN: "1",
              OPENCLAW_TEST_FAST: "1",
              OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
              OPENCLAW_SKIP_CHANNELS: "1",
              OPENCLAW_SKIP_PROVIDERS: "0",
              OPENCLAW_SKIP_GMAIL_WATCHER: "1",
              OPENCLAW_SKIP_CRON: "1",
              OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
              OPENCLAW_SKIP_CANVAS_HOST: "1",
              OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
              OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
            },
            stdio: "pipe",
          },
        );
        gateway.stdout.setEncoding("utf8");
        gateway.stderr.setEncoding("utf8");
        gateway.stdout.on("data", (chunk: string) => appendGatewayLog(gatewayLogs, chunk));
        gateway.stderr.on("data", (chunk: string) => appendGatewayLog(gatewayLogs, chunk));
        gateway.once("error", (error) => appendGatewayLog(gatewayLogs, error.message));

        await waitForGatewayHealth(gateway, gatewayPort, gatewayLogs);
        const readinessDeadline = performance.now() + GATEWAY_READINESS_TIMEOUT_MS;

        try {
          operator = await vi.waitFor(
            () =>
              connectClient({
                gatewayPort,
                gatewayToken,
                readinessDeadline,
                role: "operator",
                clientName: "test",
                mode: "test",
                scopes: ["operator.admin", "operator.pairing", "operator.read", "operator.write"],
              }),
            {
              timeout: remainingPhaseTimeoutMs(readinessDeadline, "Gateway readiness"),
              interval: 250,
            },
          );
        } catch (error) {
          throw new Error(
            `Gateway did not accept its authenticated operator:\n${gatewayLogs.join("")}`,
            {
              cause: error,
            },
          );
        }

        const commands = createOllamaNodeHostCommands({ baseUrl: nodeOllama.baseUrl });
        const commandsByName = new Map(commands.map((command) => [command.command, command]));
        node = await connectPairedNode(operator, {
          gatewayPort,
          gatewayToken,
          readinessDeadline,
          role: "node",
          clientName: "node-host",
          mode: "node",
          platform: "macos",
          displayName: NODE_DISPLAY_NAME,
          caps: ["local-inference"],
          commands: [...commandsByName.keys()],
          onEvent: (event) => {
            if (event.event !== "node.invoke.request") {
              return;
            }
            void respondToNodeInvocation(node, event.payload, commandsByName).catch(
              (error: unknown) => {
                handlerErrors.push(error instanceof Error ? error : new Error(String(error)));
              },
            );
          },
        });

        const pairedNode = await waitForPairedInferenceNode(
          operator,
          gatewayLogs,
          readinessDeadline,
        );
        expect(pairedNode.commands).toEqual(
          expect.arrayContaining(["ollama.models", "ollama.chat"]),
        );

        const inferenceDeadline = performance.now() + INFERENCE_TIMEOUT_MS;
        const rejected = await invokeGatewayTool({
          port: gatewayPort,
          token: "not-the-gateway-token",
          args: { action: "discover" },
          timeoutMs: remainingPhaseTimeoutMs(inferenceDeadline, "Ollama inference"),
        });
        expect(rejected.status).toBe(401);

        const discoveryTimeoutMs = remainingPhaseTimeoutMs(inferenceDeadline, "Ollama discovery");
        const discovered = await operator.request(
          "node.invoke",
          {
            nodeId: pairedNode.nodeId,
            command: "ollama.models",
            params: {},
            timeoutMs: discoveryTimeoutMs,
            idempotencyKey: randomUUID(),
          },
          { timeoutMs: discoveryTimeoutMs },
        );
        expect(discovered).toMatchObject({
          ok: true,
          nodeId: pairedNode.nodeId,
          command: "ollama.models",
          payload: {
            provider: "ollama",
            models: [
              expect.objectContaining({ name: LOADED_NODE_MODEL, loaded: true }),
              expect.objectContaining({ name: NODE_MODEL, loaded: false }),
            ],
          },
        });

        const chatTimeoutMs = remainingPhaseTimeoutMs(inferenceDeadline, "Ollama chat");
        const chat = await operator.request(
          "node.invoke",
          {
            nodeId: pairedNode.nodeId,
            command: "ollama.chat",
            params: {
              model: NODE_MODEL,
              prompt: "Reply exactly with PAIRED_NODE_OK",
              maxTokens: 16,
              timeoutMs: chatTimeoutMs,
            },
            timeoutMs: chatTimeoutMs,
            idempotencyKey: randomUUID(),
          },
          { timeoutMs: chatTimeoutMs },
        );
        expect(chat).toMatchObject({
          ok: true,
          nodeId: pairedNode.nodeId,
          command: "ollama.chat",
          payload: {
            provider: "ollama",
            model: NODE_MODEL,
            response: "PAIRED_NODE_OK",
            usage: { promptTokens: 8, completionTokens: 3 },
          },
        });

        expect(handlerErrors).toEqual([]);
        expect(nodeOllama.chatRequests).toEqual([
          expect.objectContaining({
            model: NODE_MODEL,
            stream: false,
            think: false,
            options: expect.objectContaining({ num_predict: 16 }),
          }),
        ]);
        expect(gatewayOllama.chatRequests).toEqual([]);
        expect(nodeOllama.paths).toEqual(
          expect.arrayContaining(["/api/tags", "/api/ps", "/api/show", "/api/chat"]),
        );
      } finally {
        await Promise.allSettled([
          ...(node ? [node.stopAndWait({ timeoutMs: 1000 })] : []),
          ...(operator ? [operator.stopAndWait({ timeoutMs: 1000 })] : []),
        ]);
        if (gateway) {
          await stopGatewayProcess(gateway);
        }
        await Promise.allSettled([nodeOllama.close(), gatewayOllama.close()]);
        await state.cleanup();
      }
    },
  );
});

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function appendGatewayLog(logs: string[], chunk: string): void {
  logs.push(chunk);
  if (logs.length > 32) {
    logs.shift();
  }
}

async function waitForGatewayHealth(
  gateway: ChildProcessWithoutNullStreams,
  port: number,
  logs: string[],
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (gateway.exitCode !== null || gateway.signalCode !== null) {
      throw new Error(
        `Gateway exited before listening (code=${String(gateway.exitCode)}, signal=${String(gateway.signalCode)}):\n${logs.join("")}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) {
        return;
      }
      lastError = new Error(`Gateway health returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Gateway did not become healthy:\n${logs.join("")}`, { cause: lastError });
}

function remainingPhaseTimeoutMs(deadline: number, phase: string): number {
  const remainingMs = Math.ceil(deadline - performance.now());
  if (remainingMs <= 0) {
    throw new Error(`${phase} exceeded its bounded E2E phase`);
  }
  return remainingMs;
}

async function connectClient(params: {
  gatewayPort: number;
  gatewayToken: string;
  readinessDeadline: number;
  role: "operator" | "node";
  clientName: "test" | "node-host";
  mode: "test" | "node";
  scopes?: string[];
  platform?: string;
  displayName?: string;
  caps?: string[];
  commands?: string[];
  onEvent?: (event: { event: string; payload?: unknown }) => void;
}): Promise<GatewayClient> {
  // Leave the shared readiness deadline available for another handshake attempt.
  const timeoutMs = Math.min(
    CONNECT_ATTEMPT_TIMEOUT_MS,
    remainingPhaseTimeoutMs(params.readinessDeadline, "Gateway client readiness"),
  );
  return await new Promise<GatewayClient>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        client.stop();
        reject(error);
      } else {
        resolve(client);
      }
    };
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${params.gatewayPort}`,
      token: params.gatewayToken,
      role: params.role,
      clientName: params.clientName,
      clientDisplayName: params.displayName ?? "ollama-paired-node-e2e",
      clientVersion: "1.0.0",
      platform: params.platform ?? process.platform,
      mode: params.mode,
      scopes: params.scopes ?? [],
      caps: params.caps,
      commands: params.commands,
      requestTimeoutMs: INFERENCE_TIMEOUT_MS,
      onEvent: params.onEvent,
      onHelloOk: () => finish(),
      onConnectError: (error) => finish(error),
      onClose: (code, reason) => finish(new Error(`Gateway closed (${code}): ${reason}`)),
    });
    const timeout = setTimeout(
      () => finish(new Error("Gateway client connection timed out")),
      timeoutMs,
    );
    timeout.unref();
    client.start();
  });
}

async function approvePendingNodePairings(
  operator: GatewayClient,
  readinessDeadline: number,
): Promise<void> {
  const pairingOptions = () => ({
    timeoutMs: remainingPhaseTimeoutMs(readinessDeadline, "Gateway node pairing"),
  });
  const devices = await operator.request<{
    pending?: Array<{ requestId?: string; role?: string }>;
  }>("device.pair.list", {}, pairingOptions());
  for (const request of devices.pending ?? []) {
    if (request.requestId) {
      await operator.request(
        "device.pair.approve",
        { requestId: request.requestId },
        pairingOptions(),
      );
    }
  }

  const nodes = await operator.request<{
    pending?: Array<{ requestId?: string; displayName?: string }>;
  }>("node.pair.list", {}, pairingOptions());
  for (const request of nodes.pending ?? []) {
    if (request.requestId) {
      await operator.request(
        "node.pair.approve",
        { requestId: request.requestId },
        pairingOptions(),
      );
    }
  }
}

async function connectPairedNode(
  operator: GatewayClient,
  params: Parameters<typeof connectClient>[0],
): Promise<GatewayClient> {
  try {
    return await connectClient(params);
  } catch (error) {
    const details = (error as { details?: { code?: string } }).details;
    if (details?.code !== "PAIRING_REQUIRED") {
      throw error;
    }
    // The operator and node share this isolated device identity. Approving the
    // Gateway's requested role upgrade preserves the real node pairing boundary.
    await approvePendingNodePairings(operator, params.readinessDeadline);
    return await connectClient(params);
  }
}

async function waitForPairedInferenceNode(
  operator: GatewayClient,
  logs: string[],
  readinessDeadline: number,
) {
  let paired:
    | { nodeId: string; displayName?: string; connected?: boolean; commands?: string[] }
    | undefined;
  await vi.waitFor(
    async () => {
      await approvePendingNodePairings(operator, readinessDeadline);
      const result = await operator.request<{
        nodes?: Array<{
          nodeId: string;
          displayName?: string;
          connected?: boolean;
          commands?: string[];
        }>;
      }>(
        "node.list",
        {},
        {
          timeoutMs: remainingPhaseTimeoutMs(readinessDeadline, "Gateway node discovery"),
        },
      );
      paired = result.nodes?.find(
        (entry) => entry.displayName === NODE_DISPLAY_NAME && entry.connected,
      );
      expect(paired, logs.join("")).toBeDefined();
      expect(paired?.commands).toEqual(expect.arrayContaining(["ollama.models", "ollama.chat"]));
    },
    {
      timeout: remainingPhaseTimeoutMs(readinessDeadline, "Gateway node readiness"),
      interval: 100,
    },
  );
  if (!paired) {
    throw new Error("Ollama-capable paired node never connected");
  }
  return paired;
}

async function respondToNodeInvocation(
  node: GatewayClient | undefined,
  payload: unknown,
  commands: ReadonlyMap<string, OpenClawPluginNodeHostCommand>,
): Promise<void> {
  const frame = payload as NodeInvokeFrame;
  const command = typeof frame.command === "string" ? commands.get(frame.command) : undefined;
  if (!node || !frame.id || !frame.nodeId || !command) {
    throw new Error("Gateway sent an invalid or unauthorized Ollama node invocation");
  }
  const paramsJSON =
    frame.paramsJSON ?? (frame.params === undefined ? null : JSON.stringify(frame.params));
  try {
    const payloadJSON = await command.handle(paramsJSON);
    await node.request("node.invoke.result", {
      id: frame.id,
      nodeId: frame.nodeId,
      ok: true,
      payloadJSON,
    });
  } catch (error) {
    await node.request("node.invoke.result", {
      id: frame.id,
      nodeId: frame.nodeId,
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function invokeGatewayTool(params: {
  port: number;
  token: string;
  args: Record<string, unknown>;
  timeoutMs: number;
}): Promise<Response> {
  return await fetch(`http://127.0.0.1:${params.port}/tools/invoke`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${params.token}`,
    },
    body: JSON.stringify({ tool: "node_inference", args: params.args }),
    signal: AbortSignal.timeout(params.timeoutMs),
  });
}

async function readRequestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function startFakeOllama(owner: "node" | "gateway"): Promise<FakeOllama> {
  const paths: string[] = [];
  const chatRequests: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    void handleFakeOllamaRequest(request, response, owner, paths, chatRequests).catch(
      (error: unknown) => {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: String(error) }));
      },
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    paths,
    chatRequests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function handleFakeOllamaRequest(
  request: IncomingMessage,
  response: ServerResponse,
  owner: "node" | "gateway",
  paths: string[],
  chatRequests: Array<Record<string, unknown>>,
): Promise<void> {
  const requestPath = request.url ?? "/";
  paths.push(requestPath);
  response.setHeader("content-type", "application/json");

  if (requestPath === "/api/tags") {
    const models =
      owner === "node"
        ? [
            { name: "remote:cloud", remote_host: "https://ollama.com" },
            ...Array.from({ length: 200 }, (_, index) => ({ name: `embedding-${index}:latest` })),
            { name: NODE_MODEL, size: 600 },
            { name: LOADED_NODE_MODEL, size: 1200 },
          ]
        : [{ name: "gateway-remote:latest" }];
    response.end(JSON.stringify({ models }));
    return;
  }
  if (requestPath === "/api/ps") {
    response.end(JSON.stringify({ models: [{ name: LOADED_NODE_MODEL }] }));
    return;
  }
  if (requestPath === "/api/show") {
    const body = await readRequestJson(request);
    const modelName = typeof body.model === "string" ? body.model : undefined;
    if (!modelName) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "model is required" }));
      return;
    }
    const isEmbedding = modelName.startsWith("embedding-");
    response.end(
      JSON.stringify({
        capabilities: isEmbedding ? ["embedding"] : ["completion", "tools"],
        model_info: isEmbedding ? {} : { "test.context_length": 32_768 },
      }),
    );
    return;
  }
  if (requestPath === "/api/chat") {
    const body = await readRequestJson(request);
    chatRequests.push(body);
    response.end(
      JSON.stringify({
        model: body.model,
        message: { content: owner === "node" ? "PAIRED_NODE_OK" : "WRONG_GATEWAY_ENDPOINT" },
        done_reason: "stop",
        prompt_eval_count: 8,
        eval_count: 3,
      }),
    );
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not found" }));
}

async function stopGatewayProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit").then(() => true);
  child.kill("SIGTERM");
  if (await Promise.race([exited, delay(2_000).then(() => false)])) {
    return;
  }
  child.kill("SIGKILL");
  await Promise.race([exited, delay(2_000)]);
}

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  approvePairing,
  createChildEnv,
  processIsAlive,
  readNode,
  startNodeProcess,
  stopChild,
  type CapturedChild,
  type GatewayHandle,
} from "./gateway-node-mcp.test-support.js";
import {
  closeWireServer,
  createPublishedWireWorkspace,
  type PublishedWireWorkspace,
} from "./paired-node-worker-wire-fixture.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const COMMAND = "codex.exec-server.stdio.v2";
const MODEL = "mock-openai/gpt-5.6-luna";
const SESSION_KEY = "agent:qa:codex-node-exec-server-proof";
const SUCCESS_MARKER = "CODEX_NODE_EXEC_SUCCESS_PROOF";
const REPEAT_MARKER = "CODEX_NODE_EXEC_REPEAT_PROOF";
const DISCONNECT_MARKER = "CODEX_NODE_EXEC_DISCONNECT_PROOF";
const RECOVERY_MARKER = "CODEX_NODE_EXEC_FRESH_ATTEMPT_PROOF";
const REQUEST_TIMEOUT_MS = 120_000;
const WAIT_OPTIONS = { timeout: 60_000, interval: 100 };

type ProofScenario = "success" | "repeat" | "disconnect" | "recovery";
type PendingPluginApproval = {
  id: string;
  request?: { pluginId?: string; allowedDecisions?: string[]; title?: string };
};
type ProofProvider = {
  readonly baseUrl: string;
  readonly httpHits: number;
  readonly nativeExecCalls: number;
  readonly observations: readonly string[];
  readonly visibleTools: ReadonlySet<string>;
  stop: () => Promise<void>;
};

function writeProofEvent(response: ServerResponse, event: Record<string, unknown>): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function finishProofResponse(response: ServerResponse, item: Record<string, unknown>): void {
  const responseId = `resp_codex_node_${randomUUID()}`;
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  writeProofEvent(response, { type: "response.created", response: { id: responseId } });
  writeProofEvent(response, { type: "response.output_item.done", item });
  writeProofEvent(response, {
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output: [item],
      usage: {
        input_tokens: 32,
        input_tokens_details: null,
        output_tokens: 16,
        output_tokens_details: null,
        total_tokens: 48,
      },
    },
  });
  response.end("data: [DONE]\n\n");
}

function readProofScenario(body: Record<string, unknown>): ProofScenario | undefined {
  const input = Array.isArray(body.input) ? body.input : [];
  for (const entry of input.toReversed()) {
    if (!entry || typeof entry !== "object" || !("role" in entry) || entry.role !== "user") {
      continue;
    }
    const userText = JSON.stringify(entry);
    if (userText.includes(RECOVERY_MARKER)) {
      return "recovery";
    }
    if (userText.includes(REPEAT_MARKER)) {
      return "repeat";
    }
    if (userText.includes(DISCONNECT_MARKER)) {
      return "disconnect";
    }
    if (userText.includes(SUCCESS_MARKER)) {
      return "success";
    }
  }
  return undefined;
}

function proofShellCommand(params: {
  scenario: ProofScenario;
  baseUrl: string;
  nodeHome: string;
}): string {
  const evidenceFile =
    params.scenario === "recovery"
      ? "codex-node-recovery.json"
      : params.scenario === "repeat"
        ? "codex-node-repeat.json"
        : "codex-node-proof.json";
  const script =
    params.scenario === "disconnect"
      ? [
          'const fs=require("node:fs");',
          'fs.writeFileSync("codex-node-disconnect.json",JSON.stringify({pid:process.pid}));',
          "setInterval(()=>{},1000);",
        ].join("")
      : [
          'const fs=require("node:fs");',
          `fetch(${JSON.stringify(`${params.baseUrl}/proof-http`)})`,
          ".then(async response=>{",
          "const evidence={",
          "openaiKeyPresent:Boolean(process.env.OPENAI_API_KEY),",
          "anthropicKeyPresent:Boolean(process.env.ANTHROPIC_API_KEY),",
          "forgeTokenPresent:Boolean(process.env.GITHUB_TOKEN||process.env.GH_TOKEN),",
          "cloudKeyPresent:Boolean(process.env.AWS_ACCESS_KEY_ID),",
          "gatewayTokenPresent:Boolean(process.env.OPENCLAW_GATEWAY_TOKEN),",
          "runtimeInjectionPresent:Boolean(process.env.NODE_OPTIONS),",
          "ordinary:process.env.NODE_ENV||null,",
          `privateHome:process.env.HOME!==${JSON.stringify(params.nodeHome)},`,
          'privateCodexHome:Boolean(process.env.CODEX_HOME&&process.env.CODEX_HOME.startsWith(process.env.HOME+"/")),',
          "http:await response.text(),pid:process.pid};",
          `fs.writeFileSync(${JSON.stringify(evidenceFile)},JSON.stringify(evidence));`,
          `console.log(${JSON.stringify(params.scenario === "recovery" ? "CODEX_NODE_FRESH_ATTEMPT_OK" : "CODEX_NODE_PROCESS_OK")});`,
          "}).catch(error=>{console.error(error.message);process.exitCode=1});",
        ].join("");
  return `node -e ${JSON.stringify(script)}`;
}

async function startProofProvider(nodeHome: string): Promise<ProofProvider> {
  const mock = await startQaMockOpenAiServer({ host: "127.0.0.1", port: 0 });
  let httpHits = 0;
  let nativeExecCalls = 0;
  const observations: string[] = [];
  const visibleTools = new Set<string>();
  let baseUrl = "";
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/proof-http") {
        httpHits += 1;
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("CODEX_NODE_HTTP_OK");
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      const raw = Buffer.concat(chunks);
      if (request.method === "POST" && request.url === "/v1/responses") {
        const body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        for (const tool of Array.isArray(body.tools) ? body.tools : []) {
          if (tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string") {
            visibleTools.add(tool.name);
          }
        }
        const scenario = readProofScenario(body);
        if (scenario) {
          const callId = `call_codex_node_${scenario}`;
          const completed = (Array.isArray(body.input) ? body.input : []).some(
            (entry) =>
              entry &&
              typeof entry === "object" &&
              "type" in entry &&
              entry.type === "function_call_output" &&
              "call_id" in entry &&
              entry.call_id === callId,
          );
          observations.push(`${scenario}:${completed ? "completed" : "native-call"}`);
          if (observations.length > 16) {
            observations.shift();
          }
          if (completed) {
            finishProofResponse(response, {
              type: "message",
              role: "assistant",
              id: `msg_codex_node_${scenario}`,
              content: [{ type: "output_text", text: `CODEX_NODE_${scenario.toUpperCase()}_OK` }],
            });
            return;
          }
          nativeExecCalls += 1;
          finishProofResponse(response, {
            type: "function_call",
            call_id: callId,
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: proofShellCommand({ scenario, baseUrl, nodeHome }),
              yield_time_ms: scenario === "disconnect" ? 10_000 : 30_000,
              max_output_tokens: 1_000,
            }),
          });
          return;
        }
        observations.push("unmatched");
        if (observations.length > 16) {
          observations.shift();
        }
      }

      const forwarded = await fetch(`${mock.baseUrl}${request.url ?? "/"}`, {
        method: request.method,
        ...(raw.byteLength ? { body: raw } : {}),
        headers: { "content-type": request.headers["content-type"] ?? "application/json" },
      });
      response.writeHead(forwarded.status, Object.fromEntries(forwarded.headers));
      response.end(Buffer.from(await forwarded.arrayBuffer()));
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "text/plain" });
      }
      response.end(error instanceof Error ? error.message : "proof provider failed");
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Codex paired-node proof provider did not bind");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    return {
      baseUrl,
      get httpHits() {
        return httpHits;
      },
      get nativeExecCalls() {
        return nativeExecCalls;
      },
      observations,
      visibleTools,
      async stop() {
        const cleanup = await Promise.allSettled([closeWireServer(server), mock.stop()]);
        const failures = cleanup.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length) {
          throw new AggregateError(failures, "Codex proof provider cleanup failed");
        }
      },
    };
  } catch (error) {
    server.closeAllConnections();
    server.close();
    await mock.stop();
    throw error;
  }
}

async function connectApprovalReviewer(gateway: GatewayHandle): Promise<GatewayClient> {
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
    const timeout = setTimeout(
      () => finish(new Error("Codex node approval reviewer connection timed out")),
      REQUEST_TIMEOUT_MS,
    );
    timeout.unref();
    const client = new GatewayClient({
      url: gateway.wsUrl,
      token: gateway.token,
      role: "operator",
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "Codex paired-node approval reviewer",
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.admin", "operator.approvals", "operator.pairing", "operator.write"],
      caps: [GATEWAY_CLIENT_CAPS.PLUGIN_APPROVALS],
      deviceIdentity: null,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      onHelloOk: () => finish(),
      onConnectError: (error) => finish(error),
      onClose: (code, reason) => finish(new Error(`approval reviewer closed (${code}): ${reason}`)),
    });
    client.start();
  });
}

async function resolveNextApproval(
  reviewer: GatewayClient,
  decision: "allow-once" | "allow-always" | "deny",
  context: { gateway: GatewayHandle; runId: string },
): Promise<PendingPluginApproval> {
  let pending: PendingPluginApproval;
  try {
    pending = await vi.waitFor(
      async () => {
        const approvals = await reviewer.request<PendingPluginApproval[]>(
          "plugin.approval.list",
          {},
        );
        const candidate = approvals.find((approval) => approval.request?.pluginId === "codex");
        expect(candidate, "expected a pending Codex paired-node approval").toBeDefined();
        return candidate!;
      },
      { timeout: 15_000, interval: 100 },
    );
  } catch (error) {
    const [terminal, approvals] = await Promise.allSettled([
      reviewer.request<{ status?: string; error?: string }>(
        "agent.wait",
        { runId: context.runId, timeoutMs: 1_000 },
        { timeoutMs: 2_000 },
      ),
      reviewer.request<PendingPluginApproval[]>("plugin.approval.list", {}),
    ]);
    const details = {
      runId: context.runId,
      turn:
        terminal.status === "fulfilled"
          ? { status: terminal.value.status, error: terminal.value.error?.slice(0, 512) }
          : { status: "unavailable" },
      approvals:
        approvals.status === "fulfilled"
          ? approvals.value.map((approval) => ({
              pluginId: approval.request?.pluginId,
              title: approval.request?.title,
              decisions: approval.request?.allowedDecisions,
            }))
          : "unavailable",
    };
    throw new Error(
      `Codex paired-node approval did not become pending: ${JSON.stringify(details)}\n${context.gateway.logs().slice(-6_000)}`,
      { cause: error },
    );
  }
  expect(
    pending.request,
    `unexpected Codex approval request: ${JSON.stringify(pending.request)}`,
  ).toMatchObject({
    pluginId: "codex",
    title: "Run Codex on this node placement",
    allowedDecisions: ["allow-once", "allow-always", "deny"],
  });
  await reviewer.request("plugin.approval.resolve", { id: pending.id, decision });
  return pending;
}

async function readRemoteEvidence<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function nodeChildCommands(nodePid: number): Promise<string[]> {
  const { stdout } = await execFileAsync("ps", ["-ax", "-o", "ppid=", "-o", "command="], {
    encoding: "utf8",
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${nodePid} `))
    .map((line) => line.slice(String(nodePid).length).trim());
}

async function startTurn(reviewer: GatewayClient, marker: string): Promise<{ runId: string }> {
  const runId = `codex-node-proof-${randomUUID()}`;
  const started = await reviewer.request<{ runId?: string; status?: string }>("chat.send", {
    sessionKey: SESSION_KEY,
    message: marker,
    deliver: false,
    idempotencyKey: runId,
  });
  expect(started).toMatchObject({ runId, status: "started" });
  return { runId };
}

async function expectSuccessfulTurn(params: {
  reviewer: GatewayClient;
  gateway: GatewayHandle;
  node: CapturedChild;
  provider: ProofProvider;
  runId: string;
}): Promise<void> {
  const outcome = await params.reviewer.request<{ status?: string; error?: string }>(
    "agent.wait",
    { runId: params.runId, timeoutMs: REQUEST_TIMEOUT_MS },
    { timeoutMs: REQUEST_TIMEOUT_MS + 5_000 },
  );
  if (outcome.status !== "ok") {
    throw new Error(
      `Codex paired-node turn failed: ${JSON.stringify({
        runId: params.runId,
        status: outcome.status,
        error: outcome.error?.slice(0, 512),
        nativeExecCalls: params.provider.nativeExecCalls,
        httpHits: params.provider.httpHits,
        observations: params.provider.observations,
      })}\nGateway logs:\n${params.gateway.logs().slice(-6_000)}\nNode logs:\n${params.node.logs().slice(-6_000)}`,
    );
  }
}

describe("Codex paired-device exec-server carrier", () => {
  it(
    "keeps approved native execution on the real node, reconciles files, and never resumes a disconnect",
    { timeout: 360_000 },
    async () => {
      const root = tempDirs.make("openclaw-codex-node-exec-server-");
      const nodeRoot = path.join(root, "node");
      const nodeHome = path.join(nodeRoot, "home");
      const nodeState = path.join(nodeRoot, "state");
      const nodeTmp = path.join(nodeRoot, "tmp");
      const nodeConfigPath = path.join(nodeRoot, "openclaw.json");
      await Promise.all(
        [nodeHome, nodeState, nodeTmp].map(async (dir) => await fs.mkdir(dir, { recursive: true })),
      );

      let provider: ProofProvider | undefined;
      let published: PublishedWireWorkspace | undefined;
      const gatewayOwner = createQaGatewayChild();
      let gateway: GatewayHandle | undefined;
      let requester: GatewayClient | undefined;
      let reviewer: GatewayClient | undefined;
      let node: CapturedChild | undefined;

      const runProof = async () => {
        provider = await startProofProvider(nodeHome);
        published = await createPublishedWireWorkspace(path.join(root, "workspace"));
        gateway = await gatewayOwner.start({
          repoRoot: process.cwd(),
          command: {
            executablePath: process.execPath,
            argsPrefix: ["dist/index.js"],
            cwd: process.cwd(),
            usePackagedPlugins: true,
          },
          transportBaseUrl: "http://127.0.0.1",
          providerMode: "mock-openai",
          providerBaseUrl: `${provider.baseUrl}/v1`,
          primaryModel: MODEL,
          alternateModel: MODEL,
          forcedRuntime: "codex",
          enabledPluginIds: ["codex"],
          controlUiEnabled: false,
          runtimeEnvPatch: {
            OPENAI_API_KEY: "codex-node-gateway-fake-canary",
            GITHUB_TOKEN: "codex-node-gateway-fake-forge-canary",
            NODE_ENV: "ordinary-node-process-value",
          },
          mutateConfig: (config) => ({
            ...config,
            gateway: {
              ...config.gateway,
              nodes: {
                ...config.gateway?.nodes,
                commands: { allow: [COMMAND] },
                pairing: {
                  ...config.gateway?.nodes?.pairing,
                  autoApproveLocal: false,
                  sshVerify: false,
                },
              },
            },
            agents: {
              ...config.agents,
              defaults: {
                ...config.agents?.defaults,
                models: {
                  ...config.agents?.defaults?.models,
                  "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } },
                },
              },
            },
            nodeHost: { ...config.nodeHost, workerRuns: { enabled: true } },
          }),
        });
        requester = await connectApprovalReviewer(gateway);
        reviewer = await connectApprovalReviewer(gateway);

        const nodeConfig: OpenClawConfig = {
          gateway: { mode: "local" },
          plugins: { allow: ["codex"], entries: { codex: { enabled: false } } },
          nodeHost: { workerRuns: { enabled: true }, skills: { enabled: false } },
        };
        await fs.writeFile(nodeConfigPath, `${JSON.stringify(nodeConfig)}\n`, { mode: 0o600 });
        const nodeEnv = createChildEnv({
          home: nodeHome,
          tempDir: nodeTmp,
          extra: {
            OPENCLAW_HOME: nodeHome,
            OPENCLAW_STATE_DIR: nodeState,
            OPENCLAW_CONFIG_PATH: nodeConfigPath,
            OPENCLAW_GATEWAY_TOKEN: gateway.token,
            OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
            NODE_ENV: "ordinary-node-process-value",
            OPENAI_API_KEY: "codex-node-device-fake-canary",
            ANTHROPIC_API_KEY: "codex-node-device-fake-anthropic-canary",
            GITHUB_TOKEN: "codex-node-device-fake-forge-canary",
            AWS_ACCESS_KEY_ID: "codex-node-device-fake-cloud-canary",
          },
        });
        const gatewayPort = Number(new URL(gateway.baseUrl).port);
        node = startNodeProcess(gatewayPort, nodeEnv);
        const nodeId = await approvePairing(gateway, "device");
        await stopChild(node);
        node = startNodeProcess(gatewayPort, nodeEnv);
        await approvePairing(gateway, "node", nodeId);
        await vi.waitFor(async () => {
          const approved = (await readNode(gateway!, nodeId)) as
            | {
                connected?: boolean;
                approvalState?: string;
                commands?: string[];
                sessionHost?: boolean;
              }
            | undefined;
          expect(approved).toMatchObject({
            connected: true,
            approvalState: "approved",
            sessionHost: true,
          });
          expect(approved?.commands).not.toContain(COMMAND);
        }, WAIT_OPTIONS);

        await gateway.call("sessions.create", {
          key: SESSION_KEY,
          agentId: "qa",
          model: "openai/gpt-5.6-luna",
          worktree: true,
          worktreeName: "codex-node-exec-proof",
          worktreeBaseRef: "main",
          cwd: published.source,
        });
        const localSession = (await gateway.call("sessions.describe", { key: SESSION_KEY })) as {
          session?: {
            execCwd?: string;
            spawnedCwd?: string;
            placement?: Record<string, unknown>;
          };
        };
        const localWorkspace = localSession.session?.execCwd ?? localSession.session?.spawnedCwd;
        expect(localWorkspace).toBeTruthy();

        await vi.waitFor(async () => {
          const inventory = await reviewer!.request<{
            environments?: Array<{
              id?: string;
              status?: string;
              sessionHost?: boolean;
              workerSlots?: { total: number; available: number };
              invocableCommands?: string[];
            }>;
          }>("environments.list", {});
          const environment = inventory.environments?.find(
            (entry) => entry.id === `node:${nodeId}`,
          );
          expect(environment).toMatchObject({ status: "available", sessionHost: true });
          expect(environment?.workerSlots?.available).toBeGreaterThan(0);
          expect(environment?.invocableCommands ?? []).not.toContain(COMMAND);
        }, WAIT_OPTIONS);
        const unapprovedNodePid = node.child.pid;
        expect(unapprovedNodePid).toBeTruthy();
        await expect(
          gateway.call(
            "sessions.dispatch",
            { key: SESSION_KEY, deviceId: nodeId },
            { timeoutMs: REQUEST_TIMEOUT_MS },
          ),
        ).rejects.toThrow(/codex\.exec-server\.stdio\.v1|enabled|approved|command/iu);
        const rejectedSession = (await gateway.call("sessions.describe", { key: SESSION_KEY })) as {
          session?: { placement?: Record<string, unknown> };
        };
        expect(rejectedSession.session?.placement).toEqual(localSession.session?.placement);
        expect(
          (await reviewer.request<PendingPluginApproval[]>("plugin.approval.list", {})).filter(
            (approval) => approval.request?.pluginId === "codex",
          ),
        ).toEqual([]);
        expect(
          (await nodeChildCommands(unapprovedNodePid!)).filter((command) =>
            /(?:^|\s)(?:worker|codex(?:\s+exec-server)?)(?:\s|$)/iu.test(command),
          ),
        ).toEqual([]);
        expect(provider.nativeExecCalls).toBe(0);

        nodeConfig.plugins!.entries!.codex!.enabled = true;
        await fs.writeFile(nodeConfigPath, `${JSON.stringify(nodeConfig)}\n`, { mode: 0o600 });
        await stopChild(node);
        node = startNodeProcess(gatewayPort, nodeEnv);
        await approvePairing(gateway, "node", nodeId);
        await stopChild(node);
        node = startNodeProcess(gatewayPort, nodeEnv);
        await vi.waitFor(async () => {
          const approved = (await readNode(gateway!, nodeId)) as
            | {
                connected?: boolean;
                approvalState?: string;
                commands?: string[];
                sessionHost?: boolean;
              }
            | undefined;
          expect(approved).toMatchObject({
            connected: true,
            approvalState: "approved",
            sessionHost: true,
          });
          expect(approved?.commands).toContain(COMMAND);
          const inventory = await reviewer!.request<{
            environments?: Array<{ id?: string; invocableCommands?: string[] }>;
          }>("environments.list", {});
          expect(
            inventory.environments?.find((entry) => entry.id === `node:${nodeId}`)
              ?.invocableCommands,
          ).toContain(COMMAND);
        }, WAIT_OPTIONS);

        const dispatched = (await gateway.call(
          "sessions.dispatch",
          { key: SESSION_KEY, deviceId: nodeId },
          { timeoutMs: REQUEST_TIMEOUT_MS },
        )) as { placement?: { state?: string; remoteWorkspaceDir?: string } };
        expect(dispatched.placement).toMatchObject({ state: "active" });
        const remoteWorkspace = dispatched.placement?.remoteWorkspaceDir;
        expect(remoteWorkspace).toEqual(expect.any(String));

        const denied = await startTurn(requester, SUCCESS_MARKER);
        await resolveNextApproval(reviewer, "deny", { gateway, runId: denied.runId });
        const deniedOutcome = await reviewer.request<{ status?: string; error?: unknown }>(
          "agent.wait",
          { runId: denied.runId, timeoutMs: REQUEST_TIMEOUT_MS },
          { timeoutMs: REQUEST_TIMEOUT_MS + 5_000 },
        );
        expect(deniedOutcome).toMatchObject({ status: "error" });
        expect(provider.nativeExecCalls).toBe(0);
        await expect(
          fs.access(path.join(remoteWorkspace!, "codex-node-proof.json")),
        ).rejects.toThrow();

        const allowed = await startTurn(requester, SUCCESS_MARKER);
        await resolveNextApproval(reviewer, "allow-always", { gateway, runId: allowed.runId });
        await expectSuccessfulTurn({ reviewer, gateway, node, provider, runId: allowed.runId });
        expect(provider.visibleTools).toContain("exec_command");
        expect(provider.httpHits).toBe(1);
        const expectedEvidence = {
          openaiKeyPresent: false,
          anthropicKeyPresent: false,
          forgeTokenPresent: false,
          cloudKeyPresent: false,
          gatewayTokenPresent: false,
          runtimeInjectionPresent: false,
          ordinary: "ordinary-node-process-value",
          privateHome: true,
          privateCodexHome: true,
          http: "CODEX_NODE_HTTP_OK",
        };
        await vi.waitFor(async () => {
          expect(
            await readRemoteEvidence<Record<string, unknown>>(
              path.join(localWorkspace!, "codex-node-proof.json"),
            ),
          ).toMatchObject(expectedEvidence);
        }, WAIT_OPTIONS);
        const nodePid = node.child.pid;
        expect(nodePid).toBeTruthy();
        const children = await nodeChildCommands(nodePid!);
        expect(children.filter((command) => /(?:^|\s)worker(?:\s|$)/u.test(command))).toEqual([]);

        const repeated = await startTurn(requester, REPEAT_MARKER);
        await expectSuccessfulTurn({ reviewer, gateway, node, provider, runId: repeated.runId });
        await vi.waitFor(async () => {
          expect(
            await readRemoteEvidence<Record<string, unknown>>(
              path.join(localWorkspace!, "codex-node-repeat.json"),
            ),
          ).toMatchObject(expectedEvidence);
        }, WAIT_OPTIONS);
        expect(
          (await reviewer.request<PendingPluginApproval[]>("plugin.approval.list", {})).filter(
            (approval) => approval.request?.pluginId === "codex",
          ),
        ).toEqual([]);
        expect(provider.httpHits).toBe(2);

        const interrupted = await startTurn(requester, DISCONNECT_MARKER);
        let interruptedProcess: number;
        try {
          interruptedProcess = await vi.waitFor(
            async () => {
              const evidence = await readRemoteEvidence<{ pid?: number }>(
                path.join(remoteWorkspace!, "codex-node-disconnect.json"),
              );
              expect(evidence.pid).toEqual(expect.any(Number));
              expect(processIsAlive(evidence.pid!)).toBe(true);
              return evidence.pid!;
            },
            { timeout: 15_000, interval: 100 },
          );
        } catch (error) {
          const terminal = await reviewer
            .request<{ status?: string; error?: string }>(
              "agent.wait",
              { runId: interrupted.runId, timeoutMs: 1_000 },
              { timeoutMs: 2_000 },
            )
            .catch(() => ({ status: "unavailable" }));
          throw new Error(
            `Codex disconnect process never started: ${JSON.stringify({
              runId: interrupted.runId,
              turn: {
                status: terminal.status,
                error: "error" in terminal ? terminal.error?.slice(0, 512) : undefined,
              },
              nativeExecCalls: provider.nativeExecCalls,
              httpHits: provider.httpHits,
              observations: provider.observations,
              nativeExecAvailable: provider.visibleTools.has("exec_command"),
            })}\n${gateway.logs().slice(-6_000)}`,
            { cause: error },
          );
        }
        const interruptedTerminal = reviewer.request<{ status?: string; error?: unknown }>(
          "agent.wait",
          { runId: interrupted.runId, timeoutMs: 12_000 },
          { timeoutMs: 17_000 },
        );
        await stopChild(node);
        node = undefined;
        const interruptedOutcome = await interruptedTerminal;
        expect(interruptedOutcome).toMatchObject({ status: "error" });
        if (
          typeof interruptedOutcome.error !== "string" ||
          !/execution node disconnected.*fresh attempt/iu.test(interruptedOutcome.error)
        ) {
          throw new Error(
            `Codex node disconnect omitted actionable guidance: ${JSON.stringify({
              runId: interrupted.runId,
              status: interruptedOutcome.status,
              error:
                typeof interruptedOutcome.error === "string"
                  ? interruptedOutcome.error.slice(0, 1_000)
                  : undefined,
              observations: provider.observations,
            })}\n${gateway.logs().slice(-6_000)}`,
          );
        }
        expect(interruptedOutcome.error).toEqual(
          expect.stringMatching(/execution node disconnected.*fresh attempt/iu),
        );
        await vi.waitFor(
          () => expect(processIsAlive(interruptedProcess)).toBe(false),
          WAIT_OPTIONS,
        );
        await vi.waitFor(async () => {
          expect(await readNode(gateway!, nodeId)).toMatchObject({ connected: false });
        }, WAIT_OPTIONS);

        node = startNodeProcess(gatewayPort, nodeEnv);
        await vi.waitFor(async () => {
          const reconnected = (await readNode(gateway!, nodeId)) as
            | {
                connected?: boolean;
                paired?: boolean;
                approvalState?: string;
                commands?: string[];
                sessionHost?: boolean;
              }
            | undefined;
          expect(reconnected).toMatchObject({
            connected: true,
            paired: true,
            approvalState: "approved",
            sessionHost: true,
          });
          expect(reconnected?.commands).toContain(COMMAND);
        }, WAIT_OPTIONS);
        const reconnectPlacement = (await gateway.call("sessions.describe", {
          key: SESSION_KEY,
        })) as {
          session?: {
            placement?: {
              generation?: number;
              environmentId?: string;
              activeOwnerEpoch?: number;
            };
          };
        };
        const moveSource = reconnectPlacement.session?.placement;
        expect(moveSource).toMatchObject({
          generation: expect.any(Number),
          environmentId: expect.any(String),
          activeOwnerEpoch: expect.any(Number),
        });
        if (
          typeof moveSource?.generation !== "number" ||
          typeof moveSource.environmentId !== "string" ||
          typeof moveSource.activeOwnerEpoch !== "number"
        ) {
          throw new Error("reconnected Codex placement omitted exact move-source facts");
        }
        await gateway.call(
          "sessions.move",
          {
            key: SESSION_KEY,
            expected: {
              generation: moveSource.generation,
              environmentId: moveSource.environmentId,
              ownerEpoch: moveSource.activeOwnerEpoch,
            },
            target: { kind: "gateway" },
          },
          { timeoutMs: REQUEST_TIMEOUT_MS },
        );
        await gateway.call(
          "sessions.dispatch",
          { key: SESSION_KEY, deviceId: nodeId },
          { timeoutMs: REQUEST_TIMEOUT_MS },
        );
        const recovered = await startTurn(requester, RECOVERY_MARKER);
        expect(recovered.runId).not.toBe(interrupted.runId);
        await resolveNextApproval(reviewer, "allow-once", { gateway, runId: recovered.runId });
        await expectSuccessfulTurn({ reviewer, gateway, node, provider, runId: recovered.runId });
        await vi.waitFor(async () => {
          expect(
            await readRemoteEvidence<Record<string, unknown>>(
              path.join(localWorkspace!, "codex-node-recovery.json"),
            ),
          ).toMatchObject(expectedEvidence);
          expect(
            await readRemoteEvidence<{ pid?: number }>(
              path.join(localWorkspace!, "codex-node-disconnect.json"),
            ),
          ).toMatchObject({ pid: interruptedProcess });
        }, WAIT_OPTIONS);
        expect(provider.httpHits).toBe(3);
        console.info(
          JSON.stringify({
            proof: "codex-paired-device-remote-exec",
            gatewayUrl: gateway.baseUrl,
            nodeId,
            deniedRunId: denied.runId,
            allowedRunId: allowed.runId,
            repeatedRunId: repeated.runId,
            interruptedRunId: interrupted.runId,
            recoveredRunId: recovered.runId,
            inferenceProvider: "deterministic mock",
            realAppServer: true,
            realExecServer: true,
            httpHits: provider.httpHits,
            credentialCanaries: "absent",
            missingCommandRejectedBeforeProvision: true,
            workerSlotsDoNotGrantCommandAuthority: true,
            workspaceReconciled: true,
            disconnectTerminal: true,
            freshReconnect: true,
            placementMoveInvalidatedStandingGrant: true,
            workerChildLaunched: false,
          }),
        );
      };
      await runQaGatewayFixture(runProof, async () => {
        const connectionCleanup = await Promise.allSettled([
          stopChild(node),
          requester?.stopAndWait({ timeoutMs: 5_000 }) ?? Promise.resolve(),
          reviewer?.stopAndWait({ timeoutMs: 5_000 }) ?? Promise.resolve(),
        ]);
        const resourceCleanup = await Promise.allSettled([
          stopQaGatewayFixture(gatewayOwner),
          published ? closeWireServer(published.server) : Promise.resolve(),
          provider?.stop() ?? Promise.resolve(),
        ]);
        const failures = [...connectionCleanup, ...resourceCleanup].flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length) {
          throw new AggregateError(failures, "Codex paired-node proof cleanup failed");
        }
      });
    },
  );
});

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it } from "vitest";
import { createQaGatewayChild, type QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { McpServerConfig } from "../../../../src/config/types.mcp.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  NODE_MCP_COMMAND,
  approvePairing,
  createChildEnv,
  startNodeProcess,
  stopChild,
  waitForNode,
} from "./gateway-node-mcp.test-support.js";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() ?? "";
const LIVE_ENABLED = process.env.OPENCLAW_LIVE_TEST === "1" && Boolean(OPENAI_API_KEY);
const MODEL_ID = process.env.OPENCLAW_MCP_LIVE_MODEL?.trim() || "gpt-5.6-luna";
const MODEL_REF = `openai/${MODEL_ID}`;
const REQUEST_TIMEOUT_MS = 120_000;
const LIVE_TEST_TIMEOUT_MS = 5 * 60_000;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type HistoryMessage = Record<string, unknown>;
function stdioServer(
  name: string,
  label: string,
  fixturePath: string,
  repoRoot: string,
  env: Record<string, string>,
): Record<string, McpServerConfig> {
  return {
    [name]: {
      transport: "stdio",
      command: process.execPath,
      args: [fixturePath, "stdio", "--label", label],
      cwd: repoRoot,
      env,
      connectionTimeoutMs: 30_000,
      requestTimeoutMs: 30_000,
      toolFilter: { include: ["parity_probe"], exclude: ["parity_hidden"] },
    },
  };
}
function modelConfig(workspace: string): OpenClawConfig {
  return {
    secrets: { providers: { default: { source: "env" } } },
    models: {
      mode: "replace",
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          models: [
            {
              id: MODEL_ID,
              name: MODEL_ID,
              api: "openai-responses",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 48_000,
              contextTokens: 48_000,
              maxTokens: 8_192,
            },
          ],
        },
      },
    },
    agents: {
      defaults: {
        workspace,
        model: { primary: MODEL_REF },
        timeoutSeconds: Math.ceil(REQUEST_TIMEOUT_MS / 1_000),
      },
    },
    tools: { profile: "full", toolSearch: false, codeMode: false },
    memory: { search: { enabled: false } },
    plugins: { enabled: false },
    channels: {},
  };
}
function expectCompletedTool(
  messages: HistoryMessage[],
  params: { name: string; marker: string; label: string },
): void {
  const called = messages.some((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return false;
    }
    return message.content.some((block) => {
      if (!isRecord(block) || block.type !== "toolCall" || block.name !== params.name) {
        return false;
      }
      return JSON.stringify(block.arguments ?? block.input).includes(params.marker);
    });
  });
  expect(called, `chat.history omitted tool call ${params.name}`).toBe(true);
  const result = messages.find(
    (candidate) =>
      candidate.role === "toolResult" &&
      candidate.toolName === params.name &&
      JSON.stringify(candidate).includes(params.marker) &&
      JSON.stringify(candidate).includes(params.label),
  );
  expect(result, `chat.history omitted completed result for ${params.name}`).toBeDefined();
}
function assistantText(message: HistoryMessage): string {
  if (typeof message.content === "string") {
    return message.content.trim();
  }
  const content = Array.isArray(message.content) ? message.content : [];
  const text = content.find(
    (block) => isRecord(block) && block.type === "text" && typeof block.text === "string",
  );
  return isRecord(text) && typeof text.text === "string" ? text.text.trim() : "";
}
describe.skipIf(!LIVE_ENABLED)("OpenAI cross-placement MCP model proof", () => {
  it(
    "calls one Gateway MCP tool and one node MCP tool in a real agent turn",
    { timeout: LIVE_TEST_TIMEOUT_MS },
    async () => {
      const repoRoot = process.cwd();
      const taskRoot = tempDirs.make("openclaw-gateway-node-mcp-live-");
      const gatewayParent = path.join(taskRoot, "gateway");
      const nodeRoot = path.join(taskRoot, "node");
      const nodeHome = path.join(nodeRoot, "home");
      const nodeStateDir = path.join(nodeRoot, "state");
      const nodeConfigPath = path.join(nodeRoot, "openclaw.json");
      const nodeWorkspace = path.join(nodeRoot, "workspace");
      const nodeTempDir = path.join(nodeRoot, "tmp");
      const fixturePath = path.join(
        repoRoot,
        "test/e2e/qa-lab/runtime/gateway-node-mcp.fixture.mjs",
      );
      const gatewayOwner = createQaGatewayChild();
      let gateway: QaGatewayChild | undefined;
      let node: ReturnType<typeof startNodeProcess> | undefined;
      let proofError: unknown;
      const cleanupErrors: unknown[] = [];
      try {
        await Promise.all(
          [gatewayParent, nodeHome, nodeStateDir, nodeWorkspace, nodeTempDir].map((dir) =>
            fs.mkdir(dir, { recursive: true }),
          ),
        );
        const gatewayServers = stdioServer(
          "gatewayLive",
          "gateway-live",
          fixturePath,
          repoRoot,
          createChildEnv({ home: gatewayParent, tempDir: gatewayParent }),
        );
        const nodeServers = stdioServer(
          "nodeLive",
          "node-live",
          fixturePath,
          repoRoot,
          createChildEnv({ home: nodeHome, tempDir: nodeTempDir }),
        );
        const nodeConfig: OpenClawConfig = {
          gateway: { mode: "local" },
          agents: { defaults: { workspace: nodeWorkspace } },
          plugins: { enabled: false },
          nodeHost: { mcp: { servers: nodeServers }, skills: { enabled: false } },
        };
        await fs.writeFile(nodeConfigPath, `${JSON.stringify(nodeConfig, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        gateway = await gatewayOwner.start({
          repoRoot,
          command: {
            executablePath: process.execPath,
            argsPrefix: ["dist/index.js"],
            cwd: repoRoot,
            tempParentDir: gatewayParent,
            usePackagedPlugins: true,
          },
          transportBaseUrl: "http://127.0.0.1",
          controlUiEnabled: false,
          runtimeEnvPatch: {
            OPENAI_API_KEY,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_SKIP_CHANNELS: "1",
          },
          mutateConfig: (cfg) => {
            const live = modelConfig(cfg.agents?.defaults?.workspace ?? gatewayParent);
            return {
              ...live,
              agents: {
                ...cfg.agents,
                ...live.agents,
                defaults: { ...cfg.agents?.defaults, ...live.agents?.defaults },
                entries: {
                  ...cfg.agents?.entries,
                  qa: {
                    ...cfg.agents?.entries?.qa,
                    model: { primary: MODEL_REF },
                    tools: { ...cfg.agents?.entries?.qa?.tools, profile: "full" },
                  },
                },
              },
              mcp: { servers: gatewayServers },
              gateway: {
                ...cfg.gateway,
                nodes: {
                  ...cfg.gateway?.nodes,
                  commands: { allow: [NODE_MCP_COMMAND] },
                  pairing: { ...cfg.gateway?.nodes?.pairing, autoApproveLocal: false },
                },
              },
            };
          },
        });
        const gatewayPort = Number(new URL(gateway.baseUrl).port);
        expect(gatewayPort).not.toBe(18_789);
        const nodeEnv = createChildEnv({
          home: nodeHome,
          tempDir: nodeTempDir,
          extra: {
            OPENCLAW_HOME: nodeHome,
            OPENCLAW_STATE_DIR: nodeStateDir,
            OPENCLAW_CONFIG_PATH: nodeConfigPath,
            OPENCLAW_GATEWAY_TOKEN: gateway.token,
            OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
          },
        });
        expect(nodeEnv).not.toHaveProperty("OPENAI_API_KEY");
        node = startNodeProcess(gatewayPort, nodeEnv);
        const nodeId = await approvePairing(gateway, "device");
        await stopChild(node);
        node = startNodeProcess(gatewayPort, nodeEnv);
        await approvePairing(gateway, "node", nodeId);
        const descriptors = (await waitForNode(gateway, nodeId, 1)).nodePluginTools ?? [];
        expect(descriptors.map(({ name, mcp }) => ({ name, mcp }))).toEqual([
          { name: "nodeLive_parity_probe", mcp: { server: "nodeLive", tool: "parity_probe" } },
        ]);
        const gatewayMarker = `gateway-${randomUUID()}`;
        const nodeMarker = `node-${randomUUID()}`;
        const expectedToken = `MCP_LIVE_OK_${randomUUID().replaceAll("-", "")}`;
        const sessionKey = `agent:qa:mcp-live-${randomUUID()}`;
        const idempotencyKey = randomUUID();
        const prompt =
          `Call gatewayLive__parity_probe with marker ${gatewayMarker}. ` +
          `Call nodeLive_parity_probe with marker ${nodeMarker}. ` +
          `Only after both calls return successfully, reply with exactly ${expectedToken} and nothing else.`;
        const started = (await gateway.call(
          "agent",
          { sessionKey, message: prompt, deliver: false, idempotencyKey },
          { timeoutMs: 30_000 },
        )) as { runId?: unknown; status?: unknown };
        if (started.status !== "accepted" || typeof started.runId !== "string") {
          throw new Error(`live Gateway run did not start: ${JSON.stringify(started)}`);
        }
        const runId = started.runId;
        const terminal = await gateway.call(
          "agent.wait",
          { runId, timeoutMs: REQUEST_TIMEOUT_MS },
          { timeoutMs: REQUEST_TIMEOUT_MS + 5_000 },
        );
        expect(terminal, gateway.logs()).toMatchObject({ runId, status: "ok" });
        const history = (await gateway.call("chat.history", {
          sessionKey,
          limit: 50,
        })) as { messages?: HistoryMessage[] };
        const messages = history.messages ?? [];
        expectCompletedTool(messages, {
          name: "gatewayLive__parity_probe",
          marker: gatewayMarker,
          label: "gateway-live",
        });
        expectCompletedTool(messages, {
          name: "nodeLive_parity_probe",
          marker: nodeMarker,
          label: "node-live",
        });
        expect(
          messages.some(
            (message) => message.role === "assistant" && assistantText(message) === expectedToken,
          ),
          "chat.history omitted the exact final expected token",
        ).toBe(true);
      } catch (error) {
        proofError = error;
      } finally {
        const stopped = await Promise.allSettled([
          ...(node ? [stopChild(node)] : []),
          stopQaGatewayFixture(gatewayOwner),
        ]);
        cleanupErrors.push(
          ...stopped.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        );
      }
      const failures = proofError === undefined ? cleanupErrors : [proofError, ...cleanupErrors];
      if (failures.length > 0) {
        throw failures.length === 1
          ? failures[0]
          : new AggregateError(failures, "OpenAI cross-placement MCP model proof failed");
      }
    },
  );
});

// Mcp Code Mode Gateway E2E script supports OpenClaw repository automation.
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as setNodeTimeout, clearTimeout as clearNodeTimeout } from "node:timers";
import { pathToFileURL } from "node:url";
import { startQaMockOpenAiServer } from "../extensions/qa-lab/src/providers/mock-openai/server.js";
import {
  qaMockRequestCursorUrl,
  qaMockRequestsAfterUrl,
  readQaMockRequestCursor,
} from "../extensions/qa-lab/src/providers/shared/debug-request-cursor.js";
import { stageQaMockAuthProfiles } from "../extensions/qa-lab/src/providers/shared/mock-auth.js";
import { buildQaGatewayConfig } from "../extensions/qa-lab/src/qa-gateway-config.js";
import { resetConfigRuntimeState } from "../src/config/config.js";
import { startGatewayServer } from "../src/gateway/server.js";
import { deleteTestEnvValue, setTestEnvValue } from "../src/test-utils/env.js";
import { writeProbeMcpServer } from "./e2e/lib/mcp-code-mode-probe-server.ts";
import {
  type McpCodeModeMentions,
  validateMcpCodeModeResult,
} from "./e2e/lib/mcp-code-mode-validation.ts";
import { countSessionLogMentions } from "./e2e/lib/session-log-mentions.ts";
import { readBoundedResponseText } from "./lib/bounded-response.ts";

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const timeoutMs = 180_000;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setNodeTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setNodeTimeout(() => {
      const error = Object.assign(new Error(`HTTP request to ${url} timed out`), {
        code: "ETIMEDOUT",
      });
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetch(url, { ...init, signal: controller.signal }),
      timeoutPromise,
    ]);
    const text = await readBoundedResponseText(response, url, 1024 * 1024, {
      createTooLargeError(message) {
        return Object.assign(new Error(message), { code: "ETOOBIG" });
      },
      formatTooLargeMessage(targetUrl, byteLimit) {
        return `HTTP response from ${targetUrl} exceeded ${byteLimit} bytes`;
      },
      timeoutPromise,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}: ${text}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    if (timeout) {
      clearNodeTimeout(timeout);
    }
  }
}

async function readSessionLogMentions(stateDir: string): Promise<Record<string, number>> {
  const sessionsDir = path.join(stateDir, "agents", "qa", "sessions");
  return await countSessionLogMentions({
    sessionsDir,
    needles: {
      apiCall: "MCP.$api",
      apiFileList: "API.list",
      apiFileRead: "API.read",
      mcpNamespace: "MCP.fixture",
      mcpTool: "fixture__lookup_note",
      toolSearchPollution: 'tools.search("lookup note"',
    },
  });
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    deleteTestEnvValue(key);
  } else {
    setTestEnvValue(key, value);
  }
}

async function writeConfig(params: {
  configPath: string;
  stateDir: string;
  workspaceDir: string;
  gatewayPort: number;
  providerBaseUrl: string;
  serverPath: string;
}) {
  let cfg = buildQaGatewayConfig({
    bind: "loopback",
    gatewayPort: params.gatewayPort,
    gatewayToken: "mcp-code-mode-e2e",
    providerBaseUrl: `${params.providerBaseUrl}/v1`,
    workspaceDir: params.workspaceDir,
    controlUiEnabled: false,
    providerMode: "mock-openai",
  });
  cfg = {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      slots: {
        ...cfg.plugins?.slots,
        memory: "none",
      },
    },
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        memorySearch: {
          ...cfg.agents?.defaults?.memorySearch,
          enabled: false,
          sync: {
            ...cfg.agents?.defaults?.memorySearch?.sync,
            onSearch: false,
            onSessionStart: false,
            watch: false,
          },
        },
      },
    },
    tools: {
      ...cfg.tools,
      alsoAllow: [...new Set([...(cfg.tools?.alsoAllow ?? []), "bundle-mcp"])],
      codeMode: {
        enabled: true,
        timeoutMs: 20_000,
        maxPendingToolCalls: 16,
      },
    },
    mcp: {
      servers: {
        fixture: {
          command: "node",
          args: [params.serverPath],
          cwd: path.dirname(params.serverPath),
          connectionTimeoutMs: 30_000,
        },
      },
    },
    gateway: {
      ...cfg.gateway,
      http: {
        endpoints: {
          responses: {
            enabled: true,
          },
        },
      },
    },
  };
  cfg = await stageQaMockAuthProfiles({
    cfg,
    stateDir: params.stateDir,
    agentIds: ["qa"],
    providers: ["mock-openai", "openai", "anthropic"],
  });
  await fs.mkdir(path.dirname(params.configPath), { recursive: true });
  await fs.writeFile(params.configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

async function main() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mcp-code-mode-"));
  const keep = process.env.OPENCLAW_MCP_CODE_MODE_GATEWAY_E2E_KEEP === "1";
  const previousEnv = {
    configPath: process.env.OPENCLAW_CONFIG_PATH,
    stateDir: process.env.OPENCLAW_STATE_DIR,
    testFast: process.env.OPENCLAW_TEST_FAST,
  };
  let provider: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  try {
    provider = await startQaMockOpenAiServer();
    const stateDir = path.join(rootDir, "state");
    const workspaceDir = path.join(rootDir, "workspace");
    const serverPath = path.join(rootDir, "mcp", "fixture-server.mjs");
    const configPath = path.join(stateDir, "openclaw.json");
    const gatewayPort = await freePort();
    await fs.mkdir(workspaceDir, { recursive: true });
    await writeProbeMcpServer(serverPath);
    await writeConfig({
      configPath,
      stateDir,
      workspaceDir,
      gatewayPort,
      providerBaseUrl: provider.baseUrl,
      serverPath,
    });

    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
    setTestEnvValue("OPENCLAW_TEST_FAST", "1");
    resetConfigRuntimeState();

    server = await startGatewayServer(gatewayPort, {
      host: "127.0.0.1",
      auth: { mode: "none" },
      controlUiEnabled: false,
      openResponsesEnabled: true,
    });

    const requestCursorBefore = readQaMockRequestCursor(
      await fetchJson(qaMockRequestCursorUrl(provider.baseUrl)),
    );
    const response = await fetchJson(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openclaw-scopes": "operator.write",
        "x-openclaw-agent": "qa",
      },
      body: JSON.stringify({
        model: "openclaw/qa",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "mcp code mode api file qa check: inspect the MCP TypeScript declaration files through API.read, call the fixture lookup_note tool for alpha, and return the note text plus what was unclear.",
              },
            ],
          },
        ],
        max_output_tokens: 256,
        stream: false,
      }),
    });
    const laneRequests = (await fetchJson(
      qaMockRequestsAfterUrl(provider.baseUrl, requestCursorBefore),
    )) as Array<{
      raw?: string;
      body?: { tools?: unknown[] };
      plannedToolName?: string;
    }>;
    const firstRequest = laneRequests[0] ?? {};
    const mentions = await readSessionLogMentions(stateDir);
    const plannedTools = laneRequests
      .map((request) => request.plannedToolName)
      .filter((name): name is string => typeof name === "string");
    const finalText = validateMcpCodeModeResult(response, mentions as McpCodeModeMentions, {
      plannedTools,
      requireExec: true,
    });

    const summary = {
      ok: true,
      rootDir,
      stateDir,
      gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
      finalText,
      providerRequestCount: laneRequests.length,
      providerDeclaredToolCount: Array.isArray(firstRequest.body?.tools)
        ? firstRequest.body.tools.length
        : 0,
      providerRawBytes: typeof firstRequest.raw === "string" ? firstRequest.raw.length : 0,
      plannedTools,
      sessionLogMentions: mentions,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await server?.close({ reason: "mcp code-mode gateway e2e complete" });
    await provider?.stop();
    resetConfigRuntimeState();
    restoreEnvValue("OPENCLAW_STATE_DIR", previousEnv.stateDir);
    restoreEnvValue("OPENCLAW_CONFIG_PATH", previousEnv.configPath);
    restoreEnvValue("OPENCLAW_TEST_FAST", previousEnv.testFast);
    if (!keep) {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

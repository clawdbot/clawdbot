import fs from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as setNodeTimeout, clearTimeout as clearNodeTimeout } from "node:timers";
import { pathToFileURL } from "node:url";
import { startQaMockOpenAiServer } from "../extensions/qa-lab/src/providers/mock-openai/server.js";
import { stageQaMockAuthProfiles } from "../extensions/qa-lab/src/providers/shared/mock-auth.js";
import { buildQaGatewayConfig } from "../extensions/qa-lab/src/qa-gateway-config.js";
import { resetConfigRuntimeState } from "../src/config/config.js";
import { startGatewayServer } from "../src/gateway/server.js";
import { countSessionLogMentions } from "./e2e/lib/session-log-mentions.ts";
import { readBoundedResponseText } from "./lib/bounded-response.ts";

const require = createRequire(import.meta.url);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

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

function outputText(response: unknown): string {
  const output = (response as { output?: Array<{ type?: unknown; content?: unknown }> }).output;
  if (!Array.isArray(output)) {
    return "";
  }
  return output
    .flatMap((item) => {
      if (item.type !== "message" || !Array.isArray(item.content)) {
        return [];
      }
      return item.content.flatMap((piece) => {
        if (!piece || typeof piece !== "object") {
          return [];
        }
        const record = piece as { text?: unknown };
        return typeof record.text === "string" ? [record.text] : [];
      });
    })
    .join("\n");
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

async function writeProbeMcpServer(serverPath: string) {
  const sdkMcpServerPath = require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
  const sdkStdioServerPath = require.resolve("@modelcontextprotocol/sdk/server/stdio.js");
  const zodPath = require.resolve("zod");
  await fs.mkdir(path.dirname(serverPath), { recursive: true });
  await fs.writeFile(
    serverPath,
    `#!/usr/bin/env node
import { McpServer } from ${JSON.stringify(sdkMcpServerPath)};
import { StdioServerTransport } from ${JSON.stringify(sdkStdioServerPath)};
import { z } from ${JSON.stringify(zodPath)};

const notes = new Map([
  ["alpha", "fixture-note-alpha"],
  ["beta", "fixture-note-beta"],
]);
const server = new McpServer({ name: "code-mode-fixture", version: "1.0.0" });

server.tool(
  "lookup_note",
  "Look up one read-only fixture note by id.",
  {
    id: z.string().describe("Fixture note id to look up."),
  },
  async ({ id }) => ({
    content: [{ type: "text", text: notes.get(id) ?? "missing-note" }],
  }),
);

await server.connect(new StdioServerTransport());
`,
    { encoding: "utf8", mode: 0o755 },
  );
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

export async function main() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mcp-code-mode-"));
  const keep = process.env.OPENCLAW_MCP_CODE_MODE_GATEWAY_E2E_KEEP === "1";
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

    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_TEST_FAST = "1";
    resetConfigRuntimeState();

    server = await startGatewayServer(gatewayPort, {
      host: "127.0.0.1",
      auth: { mode: "none" },
      controlUiEnabled: false,
      openResponsesEnabled: true,
    });

    const beforeRequests = (await fetchJson(`${provider.baseUrl}/debug/requests`)) as unknown[];
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
    const requests = (await fetchJson(`${provider.baseUrl}/debug/requests`)) as Array<{
      raw?: string;
      body?: { tools?: unknown[] };
      plannedToolName?: string;
    }>;
    const laneRequests = requests.slice(beforeRequests.length);
    const firstRequest = laneRequests[0] ?? {};
    const finalText = outputText(response);
    const mentions = await readSessionLogMentions(stateDir);
    const plannedTools = laneRequests
      .map((request) => request.plannedToolName)
      .filter((name): name is string => typeof name === "string");

    assert(
      finalText.includes("MCP_CODE_MODE_FILE_OK"),
      "agent did not complete MCP code-mode API file turn",
    );
    assert(finalText.includes("fixture-note-alpha"), "agent did not return MCP fixture note");
    assert(plannedTools.includes("exec"), "agent did not call code-mode exec");
    assert(
      mentions.apiFileRead > 0 && mentions.mcpNamespace > 0,
      "session log lacks MCP API file usage",
    );
    assert(mentions.apiCall === 0, "agent should not need MCP.$api when API files are available");
    assert(mentions.mcpTool > 0, "session log lacks materialized MCP tool call");
    assert(mentions.toolSearchPollution === 0, "MCP lookup leaked through tools.search");

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
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.OPENCLAW_TEST_FAST;
    if (!keep) {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

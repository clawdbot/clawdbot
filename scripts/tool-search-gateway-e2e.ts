import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import { pathToFileURL } from "node:url";
import { startQaMockOpenAiServer } from "../extensions/qa-lab/src/providers/mock-openai/server.js";
import { stageQaMockAuthProfiles } from "../extensions/qa-lab/src/providers/shared/mock-auth.js";
import { buildQaGatewayConfig } from "../extensions/qa-lab/src/qa-gateway-config.js";
import { resetConfigRuntimeState } from "../src/config/config.js";
import { startGatewayServer } from "../src/gateway/server.js";
import { readPositiveIntEnv } from "./e2e/lib/env-limits.mjs";
import { countSessionLogMentions } from "./e2e/lib/session-log-mentions.ts";
import { readBoundedResponseText } from "./lib/bounded-response.ts";

type Lane = "normal" | "code";

type FetchJsonOptions = {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  maxBodyBytes?: number;
  timeoutMs?: number;
};

type LaneResult = {
  lane: Lane;
  status: string;
  providerRequestCount: number;
  providerRawBytes: number;
  providerSystemPromptChars: number;
  providerDeclaredToolCount: number;
  providerPlannedTools: string[];
  gatewayOutputToolNames: string[];
  gatewayOutputText: string;
  sessionLogToolMentions: Record<string, number>;
};

const FAKE_PLUGIN_ID = "tool-search-e2e-fixture";
export type ToolSearchGatewayFetchLimits = {
  bodyMaxBytes: number;
  timeoutMs: number;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function readToolSearchGatewayFetchLimits(
  env: NodeJS.ProcessEnv = process.env,
): ToolSearchGatewayFetchLimits {
  return {
    bodyMaxBytes: readPositiveIntEnv(
      "OPENCLAW_TOOL_SEARCH_GATEWAY_E2E_FETCH_BODY_MAX_BYTES",
      1024 * 1024,
      env,
    ),
    timeoutMs: readPositiveIntEnv(
      "OPENCLAW_TOOL_SEARCH_GATEWAY_E2E_FETCH_TIMEOUT_MS",
      180_000,
      env,
    ),
  };
}

const DEFAULT_FETCH_LIMITS = readToolSearchGatewayFetchLimits();

function timeoutError(message: string) {
  return Object.assign(new Error(message), { code: "ETIMEDOUT" });
}

function bodyTooLargeErrorMessage(url: string, byteLimit: number) {
  return `HTTP response from ${url} exceeded ${byteLimit} bytes`;
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

function buildFakeTools(count = 36) {
  return Array.from({ length: count }, (_, index) => {
    const id = `fake_plugin_tool_${String(index + 1).padStart(2, "0")}`;
    return {
      type: "function",
      name: id,
      description: [
        `Fake plugin tool ${index + 1}.`,
        "Used by the Tool Search gateway E2E to prove a large plugin-owned tool catalog can be hidden from the model prompt and still called through the compact bridge.",
        "The description is intentionally non-trivial so prompt-size regression is measurable.",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          marker: {
            type: "string",
            description: "Lane marker supplied by the scripted model.",
          },
        },
        required: ["marker"],
        additionalProperties: false,
      },
      strict: true,
    };
  });
}

async function readSessionLogMentions(params: {
  stateDir: string;
  targetTool: string;
}): Promise<Record<string, number>> {
  const sessionsDir = path.join(params.stateDir, "agents", "qa", "sessions");
  return await countSessionLogMentions({
    sessionsDir,
    needles: {
      tool_search_code: "tool_search_code",
      [params.targetTool]: params.targetTool,
    },
  });
}

export async function fetchJson(
  url: string,
  init: RequestInit = {},
  options: FetchJsonOptions = {},
): Promise<unknown> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_FETCH_LIMITS.timeoutMs);
  const maxBodyBytes = Math.max(1, options.maxBodyBytes ?? DEFAULT_FETCH_LIMITS.bodyMaxBytes);
  const controller = new AbortController();
  const error = timeoutError(`HTTP request to ${url} timed out after ${timeoutMs}ms`);
  let timeout: ReturnType<typeof setNodeTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setNodeTimeout(() => {
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  let response: Response;
  let text: string;
  try {
    response = await Promise.race([
      (options.fetchImpl ?? fetch)(url, {
        ...init,
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    text = await readBoundedResponseText(response, url, maxBodyBytes, {
      createTooLargeError(message) {
        return Object.assign(new Error(message), { code: "ETOOBIG" });
      },
      formatTooLargeMessage: bodyTooLargeErrorMessage,
      timeoutPromise,
      signal: controller.signal,
    });
  } finally {
    if (timeout) {
      clearNodeTimeout(timeout);
    }
  }
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${text}`);
  }
  return parsed;
}

function outputToolNames(response: unknown): string[] {
  const output = (response as { output?: Array<{ type?: unknown; name?: unknown }> }).output;
  if (!Array.isArray(output)) {
    return [];
  }
  return output
    .filter((item) => item.type === "function_call" && typeof item.name === "string")
    .map((item) => item.name as string);
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

function readContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const record = item as { type?: unknown; text?: unknown };
      return typeof record.text === "string" ? record.text : "";
    })
    .join("\n");
}

function countSystemPromptChars(body: unknown): number {
  if (!body || typeof body !== "object") {
    return 0;
  }
  const record = body as { instructions?: unknown; input?: unknown };
  let total = typeof record.instructions === "string" ? record.instructions.length : 0;
  if (Array.isArray(record.input)) {
    for (const item of record.input) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const inputRecord = item as { role?: unknown; content?: unknown };
      if (inputRecord.role === "system" || inputRecord.role === "developer") {
        total += readContentText(inputRecord.content).length;
      }
    }
  }
  return total;
}

async function writeConfig(params: {
  lane: Lane;
  stateDir: string;
  configPath: string;
  workspaceDir: string;
  gatewayPort: number;
  providerBaseUrl: string;
  fakePluginDir: string;
}) {
  let cfg = buildQaGatewayConfig({
    bind: "loopback",
    gatewayPort: params.gatewayPort,
    gatewayToken: "tool-search-e2e",
    providerBaseUrl: `${params.providerBaseUrl}/v1`,
    workspaceDir: params.workspaceDir,
    controlUiEnabled: false,
    providerMode: "mock-openai",
  });
  const defaults = cfg.agents?.defaults ?? {};
  cfg = {
    ...cfg,
    plugins: {
      allow: [FAKE_PLUGIN_ID],
      slots: {
        ...cfg.plugins?.slots,
        memory: "none",
      },
      entries: {
        [FAKE_PLUGIN_ID]: {
          enabled: true,
        },
      },
    },
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        memorySearch: {
          ...defaults.memorySearch,
          enabled: false,
          sync: {
            ...defaults.memorySearch?.sync,
            onSearch: false,
            onSessionStart: false,
            watch: false,
          },
        },
      },
    },
  };
  cfg = {
    ...cfg,
    tools: {
      ...cfg.tools,
      alsoAllow: [...new Set([...(cfg.tools?.alsoAllow ?? []), FAKE_PLUGIN_ID])],
    },
  };
  if (params.lane === "code") {
    cfg = {
      ...cfg,
      tools: {
        ...cfg.tools,
        alsoAllow: [
          ...new Set([
            ...(cfg.tools?.alsoAllow ?? []),
            "tool_search_code",
            "tool_search",
            "tool_describe",
            "tool_call",
          ]),
        ],
        toolSearch: true,
      },
      plugins: {
        ...cfg.plugins,
        allow: [...new Set([...(cfg.plugins?.allow ?? []), FAKE_PLUGIN_ID])],
        entries: {
          ...cfg.plugins?.entries,
          [FAKE_PLUGIN_ID]: {
            enabled: true,
          },
        },
      },
    };
  } else {
    cfg = {
      ...cfg,
      plugins: {
        ...cfg.plugins,
        allow: [...new Set([...(cfg.plugins?.allow ?? []), FAKE_PLUGIN_ID])],
        entries: {
          ...cfg.plugins?.entries,
          [FAKE_PLUGIN_ID]: {
            enabled: true,
          },
        },
      },
    };
  }
  cfg = {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      load: {
        ...cfg.plugins?.load,
        paths: [...new Set([...(cfg.plugins?.load?.paths ?? []), params.fakePluginDir])],
      },
    },
  };
  cfg = await stageQaMockAuthProfiles({
    cfg,
    stateDir: params.stateDir,
    agentIds: ["qa"],
    providers: ["mock-openai", "openai", "anthropic"],
  });
  cfg = {
    ...cfg,
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
  await fs.mkdir(path.dirname(params.configPath), { recursive: true });
  await fs.writeFile(params.configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

async function writeFakePlugin(params: {
  rootDir: string;
  repoRoot: string;
  fakeTools: ReturnType<typeof buildFakeTools>;
}): Promise<string> {
  const pluginDir = path.join(params.rootDir, "fake-plugin");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/tool-search-e2e-fixture",
        version: "0.0.0",
        type: "module",
        openclaw: {
          extensions: ["./index.js"],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: FAKE_PLUGIN_ID,
        activation: {
          onStartup: true,
        },
        name: "Tool Search E2E Fixture",
        description: "Fake plugin with a large tool catalog for Tool Search gateway validation.",
        contracts: {
          tools: params.fakeTools.map((tool) => tool.name),
        },
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const pluginEntryUrl = pathToFileURL(
    path.join(params.repoRoot, "src/plugin-sdk/plugin-entry.ts"),
  ).href;
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    [
      `import { definePluginEntry } from ${JSON.stringify(pluginEntryUrl)};`,
      `const tools = ${JSON.stringify(params.fakeTools, null, 2)};`,
      "export default definePluginEntry({",
      `  id: ${JSON.stringify(FAKE_PLUGIN_ID)},`,
      "  name: 'Tool Search E2E Fixture',",
      "  register(api) {",
      "    for (const spec of tools) {",
      "      api.registerTool({",
      "        name: spec.name,",
      "        label: spec.name,",
      "        description: spec.description,",
      "        parameters: spec.parameters,",
      "        execute: async (_toolCallId, input) => ({",
      "          content: [{ type: 'text', text: `FAKE_PLUGIN_OK ${spec.name} ${JSON.stringify(input ?? {})}` }],",
      "          details: { status: 'ok', tool: spec.name, input },",
      "        }),",
      "      }, { name: spec.name });",
      "    }",
      "  },",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  return pluginDir;
}

async function runLane(params: {
  lane: Lane;
  rootDir: string;
  providerBaseUrl: string;
  targetTool: string;
  fakeTools: ReturnType<typeof buildFakeTools>;
  fakePluginDir: string;
}): Promise<LaneResult> {
  const stateDir = path.join(params.rootDir, params.lane, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const workspaceDir = path.join(params.rootDir, params.lane, "workspace");
  const gatewayPort = await freePort();
  await fs.mkdir(workspaceDir, { recursive: true });
  await writeConfig({
    lane: params.lane,
    stateDir,
    configPath,
    workspaceDir,
    gatewayPort,
    providerBaseUrl: params.providerBaseUrl,
    fakePluginDir: params.fakePluginDir,
  });

  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  process.env.OPENCLAW_TEST_FAST = "1";
  resetConfigRuntimeState();

  const server = await startGatewayServer(gatewayPort, {
    host: "127.0.0.1",
    auth: { mode: "none" },
    controlUiEnabled: false,
    openResponsesEnabled: true,
  });
  try {
    const beforeRequests = (await fetchJson(
      `${params.providerBaseUrl}/debug/requests`,
    )) as unknown[];
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
                text: `tool search qa check target=${params.targetTool}`,
              },
            ],
          },
        ],
        max_output_tokens: 256,
        stream: false,
      }),
    });
    const requests = (await fetchJson(`${params.providerBaseUrl}/debug/requests`)) as Array<{
      raw?: string;
      body?: { tools?: unknown[] };
      instructions?: string;
      plannedToolName?: string;
    }>;
    const laneRequests = requests.slice(beforeRequests.length);
    const lastRequest = laneRequests.at(-1) ?? {};
    const responseStatus = (response as { status?: unknown }).status;
    return {
      lane: params.lane,
      status: typeof responseStatus === "string" ? responseStatus : "",
      providerRequestCount: laneRequests.length,
      providerRawBytes: typeof lastRequest.raw === "string" ? lastRequest.raw.length : 0,
      providerSystemPromptChars: countSystemPromptChars(lastRequest.body),
      providerDeclaredToolCount: Array.isArray(lastRequest.body?.tools)
        ? lastRequest.body.tools.length
        : 0,
      providerPlannedTools: laneRequests
        .map((request) => request.plannedToolName)
        .filter((name): name is string => typeof name === "string"),
      gatewayOutputToolNames: outputToolNames(response),
      gatewayOutputText: outputText(response),
      sessionLogToolMentions: await readSessionLogMentions({
        stateDir,
        targetTool: params.targetTool,
      }),
    };
  } finally {
    await server.close({ reason: `${params.lane} lane complete` });
    resetConfigRuntimeState();
  }
}

export async function main() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tool-search-"));
  let provider: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
  try {
    provider = await startQaMockOpenAiServer();
    const fakeTools = buildFakeTools();
    const fakePluginDir = await writeFakePlugin({
      rootDir,
      repoRoot: process.cwd(),
      fakeTools,
    });
    const targetTool = "fake_plugin_tool_17";
    const normal = await runLane({
      lane: "normal",
      rootDir,
      providerBaseUrl: provider.baseUrl,
      targetTool,
      fakeTools,
      fakePluginDir,
    });
    const code = await runLane({
      lane: "code",
      rootDir,
      providerBaseUrl: provider.baseUrl,
      targetTool,
      fakeTools,
      fakePluginDir,
    });

    assert(
      normal.providerPlannedTools.includes(targetTool) &&
        normal.gatewayOutputText.includes("FAKE_PLUGIN_OK") &&
        normal.gatewayOutputText.includes(targetTool),
      `normal lane did not call ${targetTool}`,
    );
    assert(
      code.providerPlannedTools.includes("tool_search_code") &&
        code.gatewayOutputText.includes(targetTool) &&
        code.sessionLogToolMentions[targetTool] > 0,
      `code lane did not bridge-call ${targetTool}`,
    );
    assert(
      normal.providerDeclaredToolCount > code.providerDeclaredToolCount,
      `expected Tool Search to expose fewer tools to provider: normal=${normal.providerDeclaredToolCount} code=${code.providerDeclaredToolCount}`,
    );
    assert(
      normal.providerRawBytes > code.providerRawBytes,
      `expected Tool Search request to be smaller: normal=${normal.providerRawBytes} code=${code.providerRawBytes}`,
    );
    assert(
      code.sessionLogToolMentions.tool_search_code > 0 &&
        code.sessionLogToolMentions[targetTool] > 0,
      "code lane session log did not record bridge and target tool mentions",
    );

    const summary = {
      ok: true,
      rootDir,
      targetTool,
      normal,
      code,
      reduction: {
        providerRawBytes: normal.providerRawBytes - code.providerRawBytes,
        providerDeclaredTools: normal.providerDeclaredToolCount - code.providerDeclaredToolCount,
        providerSystemPromptChars:
          normal.providerSystemPromptChars - code.providerSystemPromptChars,
      },
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await provider?.stop();
    await fs.rm(rootDir, { force: true, recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

// Qa Lab plugin module implements Tool Search gateway flow fixture behavior.
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  countSessionLogMentions,
  countSystemPromptChars,
  fetchQaFixtureJson,
  outputText,
  outputToolNames,
  readPositiveIntEnv,
  subtractMentionCounts,
  type QaFixtureFetchJsonOptions,
} from "./fixture-utils.js";
import {
  qaMockRequestCursorUrl,
  qaMockRequestsAfterUrl,
  readQaMockRequestCursor,
} from "./providers/shared/debug-request-cursor.js";
import { liveTurnTimeoutMs } from "./suite-runtime-agent-common.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

type Lane = "normal" | "code";

type LaneResult = {
  lane: Lane;
  status: string;
  providerRequestCount: number;
  providerRawBytes: number;
  providerSystemPromptChars: number;
  providerInputSnippet: string;
  providerToolOutputSnippet: string;
  providerDeclaredToolCount: number;
  providerPlannedTools: string[];
  gatewayOutputToolNames: string[];
  gatewayOutputText: string;
  sessionLogToolMentions: Record<string, number>;
};

type LaneResultSummary = Pick<
  LaneResult,
  | "providerDeclaredToolCount"
  | "providerPlannedTools"
  | "providerRawBytes"
  | "gatewayOutputText"
  | "sessionLogToolMentions"
> & {
  providerInputSnippet?: string;
  providerToolOutputSnippet?: string;
};

type ToolSearchGatewayFixture = {
  fakePluginDir: string;
  targetTool: string;
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
    timeoutMs: readPositiveIntEnv("OPENCLAW_TOOL_SEARCH_GATEWAY_E2E_FETCH_TIMEOUT_MS", 5_000, env),
  };
}

const DEFAULT_FETCH_LIMITS = readToolSearchGatewayFetchLimits();

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

export async function fetchJson(
  url: string,
  init: RequestInit = {},
  options: QaFixtureFetchJsonOptions = {},
): Promise<unknown> {
  return fetchQaFixtureJson(url, init, {
    fetchImpl: options.fetchImpl,
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_FETCH_LIMITS.bodyMaxBytes,
    timeoutMs: options.timeoutMs ?? DEFAULT_FETCH_LIMITS.timeoutMs,
  });
}

async function countToolSearchSessionLogMentions(params: { stateDir: string; targetTool: string }) {
  return countSessionLogMentions({
    sessionsDir: path.join(params.stateDir, "agents", "qa", "sessions"),
    needles: {
      tool_search_code: "tool_search_code",
      [params.targetTool]: params.targetTool,
    },
  });
}

async function writeFakePlugin(params: {
  rootDir: string;
  repoRoot: string;
  fakeTools: ReturnType<typeof buildFakeTools>;
}): Promise<string> {
  const pluginDir = path.join(params.rootDir, "tool-search-fake-plugin");
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
    path.join(params.repoRoot, "dist/plugin-sdk/plugin-entry.js"),
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
      '      api["registerTool"]({',
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

function applyLaneConfig(
  config: Record<string, unknown>,
  params: { lane: Lane; fakePluginDir: string },
) {
  const cfg = structuredClone(config);
  const plugins = (cfg.plugins && typeof cfg.plugins === "object" ? cfg.plugins : {}) as Record<
    string,
    unknown
  >;
  const pluginEntries =
    plugins.entries && typeof plugins.entries === "object"
      ? (plugins.entries as Record<string, unknown>)
      : {};
  const pluginLoad =
    plugins.load && typeof plugins.load === "object"
      ? (plugins.load as Record<string, unknown>)
      : {};
  cfg.plugins = {
    ...plugins,
    allow: [...new Set([...(Array.isArray(plugins.allow) ? plugins.allow : []), FAKE_PLUGIN_ID])],
    slots: {
      ...(plugins.slots && typeof plugins.slots === "object" ? plugins.slots : {}),
      memory: "none",
    },
    entries: {
      ...pluginEntries,
      [FAKE_PLUGIN_ID]: { enabled: true },
    },
    load: {
      ...pluginLoad,
      paths: [
        ...new Set([
          ...(Array.isArray(pluginLoad.paths) ? pluginLoad.paths : []),
          params.fakePluginDir,
        ]),
      ],
    },
  };

  const memory =
    cfg.memory && typeof cfg.memory === "object" ? (cfg.memory as Record<string, unknown>) : {};
  const memorySearch =
    memory.search && typeof memory.search === "object"
      ? (memory.search as Record<string, unknown>)
      : {};
  cfg.memory = {
    ...memory,
    search: {
      ...memorySearch,
      enabled: false,
      sync: {
        ...(memorySearch.sync && typeof memorySearch.sync === "object" ? memorySearch.sync : {}),
        onSearch: false,
        onSessionStart: false,
        watch: false,
      },
    },
  };

  const tools = (cfg.tools && typeof cfg.tools === "object" ? cfg.tools : {}) as Record<
    string,
    unknown
  >;
  cfg.tools = {
    ...tools,
    alsoAllow: [
      ...new Set([
        ...(Array.isArray(tools.alsoAllow) ? tools.alsoAllow : []),
        FAKE_PLUGIN_ID,
        ...(params.lane === "code"
          ? ["tool_search_code", "tool_search", "tool_describe", "tool_call"]
          : []),
      ]),
    ],
    toolSearch: params.lane === "code",
  };

  const gateway = (cfg.gateway && typeof cfg.gateway === "object" ? cfg.gateway : {}) as Record<
    string,
    unknown
  >;
  const gatewayHttp =
    gateway.http && typeof gateway.http === "object"
      ? (gateway.http as Record<string, unknown>)
      : {};
  const endpoints =
    gatewayHttp.endpoints && typeof gatewayHttp.endpoints === "object"
      ? (gatewayHttp.endpoints as Record<string, unknown>)
      : {};
  cfg.gateway = {
    ...gateway,
    http: {
      ...gatewayHttp,
      endpoints: {
        ...endpoints,
        responses: { enabled: true },
      },
    },
  };

  return cfg;
}

async function configureLane(params: {
  env: QaSuiteRuntimeEnv;
  fixture: ToolSearchGatewayFixture;
  lane: Lane;
}) {
  assert(
    params.env.gateway.restartAfterStateMutation,
    "qa gateway child cannot restart after state mutation",
  );
  await params.env.gateway.restartAfterStateMutation(async ({ configPath }) => {
    const raw = await fs.readFile(configPath, "utf8");
    const config = JSON.parse(raw || "{}") as Record<string, unknown>;
    const next = applyLaneConfig(config, {
      fakePluginDir: params.fixture.fakePluginDir,
      lane: params.lane,
    });
    await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  });
}

export async function stageToolSearchGatewayFixture(params: {
  env: QaSuiteRuntimeEnv;
  targetTool?: string;
  toolCount?: number;
}): Promise<ToolSearchGatewayFixture> {
  const fakeTools = buildFakeTools(params.toolCount ?? 36);
  return {
    fakePluginDir: await writeFakePlugin({
      rootDir: params.env.gateway.tempRoot,
      repoRoot: params.env.repoRoot,
      fakeTools,
    }),
    targetTool: params.targetTool ?? "fake_plugin_tool_17",
  };
}

export async function runToolSearchGatewayLane(params: {
  env: QaSuiteRuntimeEnv;
  fixture: ToolSearchGatewayFixture;
  lane: Lane;
}): Promise<LaneResult> {
  const providerBaseUrl = params.env.mock?.baseUrl;
  assert(providerBaseUrl, "Tool Search gateway fixture requires mock-openai provider mode");
  const gatewayToken = params.env.gateway.runtimeEnv.OPENCLAW_GATEWAY_TOKEN;
  assert(gatewayToken, "Tool Search gateway fixture requires QA gateway token");
  await configureLane(params);
  const stateDir = path.join(params.env.gateway.tempRoot, "state");
  const mentionCountsBefore = await countToolSearchSessionLogMentions({
    stateDir,
    targetTool: params.fixture.targetTool,
  });
  const requestCursorBefore = readQaMockRequestCursor(
    await fetchJson(qaMockRequestCursorUrl(providerBaseUrl)),
  );
  const response = await fetchJson(
    `${params.env.gateway.baseUrl}/v1/responses`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${gatewayToken}`,
        "content-type": "application/json",
        "x-openclaw-scopes": "operator.write",
        "x-openclaw-agent": "qa",
        "x-openclaw-session-key": `tool-search-gateway-${params.lane}`,
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
                text: `tool search qa check target=${params.fixture.targetTool}`,
              },
            ],
          },
        ],
        max_output_tokens: 256,
        stream: false,
      }),
    },
    { timeoutMs: liveTurnTimeoutMs(params.env, 30_000) },
  );
  const laneRequests = (await fetchJson(
    qaMockRequestsAfterUrl(providerBaseUrl, requestCursorBefore),
  )) as Array<{
    raw?: string;
    body?: { tools?: unknown[] };
    instructions?: string;
    allInputText?: string;
    prompt?: string;
    toolOutput?: string;
    plannedToolName?: string;
  }>;
  const lastRequest = laneRequests.at(-1) ?? {};
  const responseStatus = (response as { status?: unknown }).status;
  const mentionCountsAfter = await countToolSearchSessionLogMentions({
    stateDir,
    targetTool: params.fixture.targetTool,
  });
  return {
    lane: params.lane,
    status: typeof responseStatus === "string" ? responseStatus : "",
    providerRequestCount: laneRequests.length,
    providerRawBytes: typeof lastRequest.raw === "string" ? lastRequest.raw.length : 0,
    providerSystemPromptChars: countSystemPromptChars(lastRequest.body),
    providerInputSnippet: truncateUtf16Safe(
      lastRequest.allInputText ?? lastRequest.prompt ?? "",
      500,
    ),
    providerToolOutputSnippet: truncateUtf16Safe(lastRequest.toolOutput ?? "", 4_000),
    providerDeclaredToolCount: Array.isArray(lastRequest.body?.tools)
      ? lastRequest.body.tools.length
      : 0,
    providerPlannedTools: laneRequests
      .map((request) => request.plannedToolName)
      .filter((name): name is string => typeof name === "string"),
    gatewayOutputToolNames: outputToolNames(response),
    gatewayOutputText: outputText(response),
    sessionLogToolMentions: subtractMentionCounts(mentionCountsAfter, mentionCountsBefore),
  };
}

export function assertToolSearchLaneResults(params: {
  normal: LaneResultSummary;
  code: LaneResultSummary;
  targetTool: string;
}) {
  const { code, normal, targetTool } = params;
  const laneDebug = () =>
    JSON.stringify(
      {
        normal: {
          plannedTools: normal.providerPlannedTools,
          declaredToolCount: normal.providerDeclaredToolCount,
          input: normal.providerInputSnippet,
          toolOutput: normal.providerToolOutputSnippet,
          output: truncateUtf16Safe(normal.gatewayOutputText, 300),
          mentions: normal.sessionLogToolMentions,
        },
        code: {
          plannedTools: code.providerPlannedTools,
          declaredToolCount: code.providerDeclaredToolCount,
          input: code.providerInputSnippet,
          toolOutput: code.providerToolOutputSnippet,
          output: truncateUtf16Safe(code.gatewayOutputText, 300),
          mentions: code.sessionLogToolMentions,
        },
      },
      null,
      2,
    );
  assert(
    normal.providerPlannedTools.includes(targetTool) &&
      normal.gatewayOutputText.includes("FAKE_PLUGIN_OK") &&
      normal.gatewayOutputText.includes(targetTool) &&
      (normal.sessionLogToolMentions[targetTool] ?? 0) > 0,
    `normal lane did not call ${targetTool}: ${laneDebug()}`,
  );
  assert(
    code.providerPlannedTools.includes("tool_search_code") &&
      code.gatewayOutputText.includes("FAKE_PLUGIN_OK") &&
      code.gatewayOutputText.includes(targetTool) &&
      (code.sessionLogToolMentions[targetTool] ?? 0) > 0,
    `code lane did not bridge-call ${targetTool}: ${laneDebug()}`,
  );
  assert(
    !code.providerPlannedTools.includes(targetTool),
    `code lane exposed direct provider tool ${targetTool}: ${laneDebug()}`,
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
    (code.sessionLogToolMentions.tool_search_code ?? 0) > 0 &&
      (code.sessionLogToolMentions[targetTool] ?? 0) > 0,
    "code lane session log did not record bridge and target tool mentions",
  );
  assert(
    !normal.providerPlannedTools.includes("tool_search_code"),
    "normal lane unexpectedly used Tool Search bridge",
  );
}

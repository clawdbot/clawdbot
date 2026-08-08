// Qa Lab plugin module implements Tool Search gateway flow fixture behavior.
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
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
import { QA_TOOL_SEARCH_SECONDARY_TARGET } from "./providers/mock-openai/mock-openai-tooling.js";
import {
  qaMockRequestCursorUrl,
  qaMockRequestsAfterUrl,
  readQaMockRequestCursor,
} from "./providers/shared/debug-request-cursor.js";
import { liveTurnTimeoutMs } from "./suite-runtime-agent-common.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

type Lane = "normal" | "code" | "tools";

type LaneResult = {
  lane: Lane;
  status: string;
  providerRequestCount: number;
  providerRawBytes: number;
  providerSystemPromptChars: number;
  providerInputSnippet: string;
  providerToolOutputSnippet: string;
  providerToolSearchResult?: unknown;
  providerToolCallResult?: unknown;
  providerDeclaredToolCount: number;
  providerDeclaredToolNames: string[];
  providerDirectoryContainsTarget: boolean;
  providerPlannedTools: string[];
  gatewayOutputToolNames: string[];
  gatewayOutputText: string;
  sessionLogToolMentions: Record<string, number>;
  targetToolIdentity: {
    source: string;
    pluginId: string;
  };
};

type LaneResultSummary = Pick<
  LaneResult,
  | "providerDeclaredToolCount"
  | "providerDirectoryContainsTarget"
  | "providerPlannedTools"
  | "providerRawBytes"
  | "providerToolCallResult"
  | "providerToolSearchResult"
  | "gatewayOutputText"
  | "sessionLogToolMentions"
  | "targetToolIdentity"
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

function parseJson(text: string | undefined): unknown {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
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
      tool_search: "tool_search",
      tool_call: "tool_call",
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
        ...(params.lane !== "normal"
          ? ["tool_search_code", "tool_search", "tool_describe", "tool_call"]
          : []),
      ]),
    ],
    toolSearch:
      params.lane === "code"
        ? true
        : params.lane === "tools"
          ? { enabled: true, mode: "tools" }
          : false,
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

async function readTargetToolIdentity(params: {
  env: QaSuiteRuntimeEnv;
  sessionKey: string;
  targetTool: string;
}) {
  const payload = (await params.env.gateway.call(
    "tools.effective",
    { sessionKey: params.sessionKey },
    { timeoutMs: liveTurnTimeoutMs(params.env, 90_000) },
  )) as {
    groups?: Array<{
      tools?: Array<{ id?: string; source?: string; pluginId?: string }>;
    }>;
  };
  for (const group of payload.groups ?? []) {
    for (const tool of group.tools ?? []) {
      if (tool.id === params.targetTool) {
        return {
          source: tool.source?.trim() ?? "",
          pluginId: tool.pluginId?.trim() ?? "",
        };
      }
    }
  }
  throw new Error(`tools.effective did not report ${params.targetTool}`);
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
  const sessionKey = `tool-search-gateway-${params.lane}`;
  const response = await fetchJson(
    `${params.env.gateway.baseUrl}/v1/responses`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${gatewayToken}`,
        "content-type": "application/json",
        "x-openclaw-scopes": "operator.write",
        "x-openclaw-agent": "qa",
        "x-openclaw-session-key": sessionKey,
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
  // The last provider request contains the terminal target result, while earlier
  // requests contain discovery results needed to prove the complete bridge flow.
  const providerToolOutputs = laneRequests
    .map((request) => request.toolOutput)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
  const toolCallRequestIndex = laneRequests.findIndex(
    (request) => request.plannedToolName === "tool_call",
  );
  const providerToolSearchResult = parseJson(
    toolCallRequestIndex >= 0 ? laneRequests[toolCallRequestIndex]?.toolOutput : undefined,
  );
  const providerToolCallResult = parseJson(
    toolCallRequestIndex >= 0
      ? laneRequests.slice(toolCallRequestIndex + 1).find((request) => request.toolOutput)
          ?.toolOutput
      : undefined,
  );
  // Responses providers may carry system text in instructions or input items;
  // inspect the full recorded prompt so late directory entries are not lost.
  const providerPromptText = [lastRequest.instructions, lastRequest.allInputText]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  const responseStatus = (response as { status?: unknown }).status;
  const targetToolIdentity = await readTargetToolIdentity({
    env: params.env,
    sessionKey,
    targetTool: params.fixture.targetTool,
  });
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
    providerToolOutputSnippet: truncateUtf16Safe(providerToolOutputs, 4_000),
    providerToolSearchResult,
    providerToolCallResult,
    providerDeclaredToolCount: Array.isArray(lastRequest.body?.tools)
      ? lastRequest.body.tools.length
      : 0,
    providerDeclaredToolNames: Array.isArray(lastRequest.body?.tools)
      ? lastRequest.body.tools.flatMap((tool) =>
          isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
        )
      : [],
    providerDirectoryContainsTarget:
      providerPromptText.includes("### Deferred Tool Schemas") &&
      providerPromptText.includes(`- ${params.fixture.targetTool}`),
    providerPlannedTools: laneRequests
      .map((request) => request.plannedToolName)
      .filter((name): name is string => typeof name === "string"),
    gatewayOutputToolNames: outputToolNames(response),
    gatewayOutputText: outputText(response),
    sessionLogToolMentions: subtractMentionCounts(mentionCountsAfter, mentionCountsBefore),
    targetToolIdentity,
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
          directoryContainsTarget: normal.providerDirectoryContainsTarget,
          input: normal.providerInputSnippet,
          toolOutput: normal.providerToolOutputSnippet,
          output: truncateUtf16Safe(normal.gatewayOutputText, 300),
          mentions: normal.sessionLogToolMentions,
        },
        code: {
          plannedTools: code.providerPlannedTools,
          declaredToolCount: code.providerDeclaredToolCount,
          directoryContainsTarget: code.providerDirectoryContainsTarget,
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
    code.providerDirectoryContainsTarget,
    `code lane did not advertise ${targetTool} in the capability directory: ${laneDebug()}`,
  );
  assert(
    !normal.providerDirectoryContainsTarget,
    `normal lane unexpectedly advertised a Tool Search capability directory: ${laneDebug()}`,
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
  for (const lane of [normal, code]) {
    assert(
      lane.targetToolIdentity.source === "plugin" &&
        lane.targetToolIdentity.pluginId === FAKE_PLUGIN_ID,
      `tools.effective did not attribute ${targetTool} to plugin ${FAKE_PLUGIN_ID}: ${laneDebug()}`,
    );
  }
}

export function assertToolSearchBatchLaneResult(params: {
  tools: LaneResultSummary & Pick<LaneResult, "status" | "providerDeclaredToolNames">;
  targetTool: string;
}) {
  const { targetTool, tools } = params;
  const debug = () =>
    JSON.stringify(
      {
        plannedTools: tools.providerPlannedTools,
        toolOutput: tools.providerToolOutputSnippet,
        output: truncateUtf16Safe(tools.gatewayOutputText, 300),
        mentions: tools.sessionLogToolMentions,
        toolCallResult: tools.providerToolCallResult,
        declaredToolCount: tools.providerDeclaredToolCount,
        declaredToolNames: tools.providerDeclaredToolNames,
        directoryContainsTarget: tools.providerDirectoryContainsTarget,
      },
      null,
      2,
    );
  assert(tools.status === "completed", `structured lane did not complete successfully: ${debug()}`);
  const structuredControlTools = new Set(["tool_search", "tool_describe", "tool_call"]);
  assert(
    [...structuredControlTools].every((name) => tools.providerDeclaredToolNames.includes(name)) &&
      tools.providerDirectoryContainsTarget,
    `structured lane did not expose its bounded directory with all three control tools: ${debug()}`,
  );
  assert(
    tools.providerPlannedTools.filter((name) => name === "tool_search").length === 1 &&
      tools.providerPlannedTools.filter((name) => name === "tool_call").length === 1 &&
      tools.providerPlannedTools.indexOf("tool_search") <
        tools.providerPlannedTools.indexOf("tool_call"),
    `structured lane did not use one batch search followed by one catalog call: ${debug()}`,
  );
  const batchResult = tools.providerToolSearchResult;
  const groups =
    isRecord(batchResult) && Array.isArray(batchResult.results) ? batchResult.results : [];
  const targetGroup = groups[0];
  const catalogGroup = groups[1];
  assert(
    groups.length === 2 &&
      isRecord(targetGroup) &&
      targetGroup.query === targetTool &&
      Array.isArray(targetGroup.candidates) &&
      targetGroup.candidates.length === 1 &&
      targetGroup.candidates.some(
        (candidate) =>
          isRecord(candidate) && (candidate.name === targetTool || candidate.id === targetTool),
      ) &&
      isRecord(catalogGroup) &&
      catalogGroup.query === QA_TOOL_SEARCH_SECONDARY_TARGET &&
      Array.isArray(catalogGroup.candidates) &&
      catalogGroup.candidates.length === 1 &&
      catalogGroup.candidates.some(
        (candidate) =>
          isRecord(candidate) &&
          (candidate.name === QA_TOOL_SEARCH_SECONDARY_TARGET ||
            candidate.id === QA_TOOL_SEARCH_SECONDARY_TARGET),
      ),
    `structured lane did not return both grouped search results: ${debug()}`,
  );
  const toolCallResult = tools.providerToolCallResult;
  const calledTool = isRecord(toolCallResult) ? toolCallResult.tool : undefined;
  const callResult = isRecord(toolCallResult) ? toolCallResult.result : undefined;
  const callDetails = isRecord(callResult) ? callResult.details : undefined;
  assert(
    tools.gatewayOutputText.includes("FAKE_PLUGIN_OK") &&
      tools.gatewayOutputText.includes(targetTool) &&
      isRecord(calledTool) &&
      calledTool.name === targetTool &&
      isRecord(callDetails) &&
      callDetails.status === "ok" &&
      callDetails.tool === targetTool,
    `structured lane did not call ${targetTool}: ${debug()}`,
  );
  assert(
    (tools.sessionLogToolMentions.tool_search ?? 0) > 0 &&
      (tools.sessionLogToolMentions.tool_call ?? 0) > 0,
    `structured lane session log did not record search and call mentions: ${debug()}`,
  );
  assert(
    !tools.providerPlannedTools.includes(targetTool),
    `structured lane exposed direct provider tool ${targetTool}: ${debug()}`,
  );
  assert(
    tools.targetToolIdentity.source === "plugin" &&
      tools.targetToolIdentity.pluginId === FAKE_PLUGIN_ID,
    `tools.effective did not attribute ${targetTool} to plugin ${FAKE_PLUGIN_ID}: ${debug()}`,
  );
}

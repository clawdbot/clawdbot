import { jsonResult } from "openclaw/plugin-sdk/channel-actions";
// Ollama node inference exposes local models to agents through paired node hosts.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  readFiniteNumberParam,
  readPositiveIntegerParam,
  readStringParam,
} from "openclaw/plugin-sdk/param-readers";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  readProviderJsonResponse,
  readResponseTextLimited,
} from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { Type } from "typebox";
import { OLLAMA_DEFAULT_BASE_URL } from "./defaults.js";
import {
  buildOllamaBaseUrlSsrFPolicy,
  enrichOllamaModelsWithContext,
  fetchOllamaModels,
  resolveOllamaApiBase,
} from "./provider-models.js";

const OLLAMA_NODE_INFERENCE_CAPABILITY = "local-inference";
const OLLAMA_MODELS_COMMAND = "ollama.models";
const OLLAMA_CHAT_COMMAND = "ollama.chat";
const OLLAMA_NODE_INFERENCE_COMMANDS = [OLLAMA_MODELS_COMMAND, OLLAMA_CHAT_COMMAND] as const;

const DEFAULT_INFERENCE_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 512;
const DISCOVERY_TRANSPORT_TIMEOUT_MS = 90_000;
const INFERENCE_TRANSPORT_GRACE_MS = 10_000;
const MAX_INFERENCE_TIMEOUT_MS = 10 * 60_000;
const MAX_TOKENS = 8192;
const MAX_PROMPT_CHARS = 128_000;
const MAX_SYSTEM_PROMPT_CHARS = 32_000;
const MAX_DISCOVERED_MODELS = 200;
const MAX_ERROR_BODY_BYTES = 500;

type NodeModel = {
  name: string;
  size?: number;
  modifiedAt?: string;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  contextWindow?: number;
  capabilities?: string[];
  loaded: boolean;
};

type OllamaModelsPayload = {
  provider: "ollama";
  models: NodeModel[];
};

type OllamaChatPayload = {
  provider: "ollama";
  model: string;
  response: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
  timings?: {
    loadMs?: number;
    totalMs?: number;
  };
};

type NodeSummary = Awaited<
  ReturnType<OpenClawPluginApi["runtime"]["nodes"]["list"]>
>["nodes"][number];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNodeCommandParams(paramsJSON?: string | null): Record<string, unknown> {
  if (!paramsJSON) {
    return {};
  }
  const parsed = asRecord(JSON.parse(paramsJSON));
  if (!parsed) {
    throw new Error("node inference params must be a JSON object");
  }
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function durationMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.round((value / 1_000_000) * 100) / 100;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function requestOllamaJson<T>(params: {
  baseUrl: string;
  path: string;
  timeoutMs: number;
  init?: RequestInit;
}): Promise<T> {
  const apiBase = resolveOllamaApiBase(params.baseUrl);
  let response: Response;
  let release: (() => Promise<void>) | undefined;
  try {
    const guarded = await fetchWithSsrFGuard({
      url: `${apiBase}${params.path}`,
      init: {
        ...params.init,
        signal: AbortSignal.timeout(params.timeoutMs),
      },
      policy: buildOllamaBaseUrlSsrFPolicy(apiBase),
      auditContext: `ollama-node-inference${params.path}`,
    });
    response = guarded.response;
    release = guarded.release;
  } catch (error) {
    throw new Error(`Ollama is unavailable at ${apiBase}: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  try {
    if (!response.ok) {
      const body = (await readResponseTextLimited(response, MAX_ERROR_BODY_BYTES)).trim();
      let detail = body;
      try {
        const parsed = asRecord(JSON.parse(body));
        detail = typeof parsed?.error === "string" ? parsed.error : body;
      } catch {
        // Keep the bounded response text when Ollama returns a non-JSON error.
      }
      throw new Error(
        `Ollama ${params.path} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    return await readProviderJsonResponse<T>(response, `ollama-node-inference${params.path}`);
  } finally {
    await release();
  }
}

async function fetchLoadedModelNames(baseUrl: string): Promise<Set<string>> {
  try {
    const data = await requestOllamaJson<{ models?: Array<{ name?: unknown; model?: unknown }> }>({
      baseUrl,
      path: "/api/ps",
      timeoutMs: 5000,
    });
    return new Set(
      (data.models ?? [])
        .map((model) =>
          typeof model.name === "string"
            ? model.name.trim()
            : typeof model.model === "string"
              ? model.model.trim()
              : "",
        )
        .filter(Boolean),
    );
  } catch {
    // Model discovery still works against Ollama versions without /api/ps.
    return new Set();
  }
}

async function discoverOllamaNodeModels(
  baseUrl = OLLAMA_DEFAULT_BASE_URL,
): Promise<OllamaModelsPayload> {
  const apiBase = resolveOllamaApiBase(baseUrl);
  const discovered = await fetchOllamaModels(apiBase);
  if (!discovered.reachable) {
    throw new Error(`Ollama is not running at ${apiBase}`);
  }
  const localModels = discovered.models
    .filter((model) => !model.remote_host?.trim())
    .slice(0, MAX_DISCOVERED_MODELS);
  const [models, loadedNames] = await Promise.all([
    enrichOllamaModelsWithContext(apiBase, localModels),
    fetchLoadedModelNames(apiBase),
  ]);
  const rows = models
    // Nodes advertise only models Ollama positively identifies as chat-capable.
    // Failed /api/show probes must not turn embedding models into runnable choices.
    .filter((model) => model.capabilities?.includes("completion") === true)
    .map((model): NodeModel => {
      const details = model.details;
      const row: NodeModel = {
        name: model.name,
        loaded: loadedNames.has(model.name),
      };
      if (typeof model.size === "number") {
        row.size = model.size;
      }
      if (typeof model.modified_at === "string") {
        row.modifiedAt = model.modified_at;
      }
      if (details?.family) {
        row.family = details.family;
      }
      if (details?.parameter_size) {
        row.parameterSize = details.parameter_size;
      }
      if (details?.quantization_level) {
        row.quantization = details.quantization_level;
      }
      if (typeof model.contextWindow === "number") {
        row.contextWindow = model.contextWindow;
      }
      if (model.capabilities) {
        row.capabilities = model.capabilities;
      }
      return row;
    })
    .toSorted((left, right) => {
      if (left.loaded !== right.loaded) {
        return left.loaded ? -1 : 1;
      }
      const sizeDelta =
        (left.size ?? Number.MAX_SAFE_INTEGER) - (right.size ?? Number.MAX_SAFE_INTEGER);
      return sizeDelta || left.name.localeCompare(right.name);
    });
  return { provider: "ollama", models: rows };
}

async function runOllamaNodeChat(params: {
  baseUrl: string;
  model: string;
  prompt: string;
  system?: string;
  temperature?: number;
  maxTokens: number;
  timeoutMs: number;
}): Promise<OllamaChatPayload> {
  const apiBase = resolveOllamaApiBase(params.baseUrl);
  const discovered = await fetchOllamaModels(apiBase);
  const localModel = discovered.models.find(
    (model) => model.name === params.model && !model.remote_host?.trim(),
  );
  const [model] = localModel ? await enrichOllamaModelsWithContext(apiBase, [localModel]) : [];
  if (!discovered.reachable || model?.capabilities?.includes("completion") !== true) {
    throw new Error(
      `Ollama model ${JSON.stringify(params.model)} is not a local chat model; discover models first`,
    );
  }
  const messages = [
    ...(params.system ? [{ role: "system", content: params.system }] : []),
    { role: "user", content: params.prompt },
  ];
  const data = await requestOllamaJson<{
    model?: unknown;
    message?: { content?: unknown };
    done_reason?: unknown;
    prompt_eval_count?: unknown;
    eval_count?: unknown;
    load_duration?: unknown;
    total_duration?: unknown;
  }>({
    baseUrl: params.baseUrl,
    path: "/api/chat",
    timeoutMs: params.timeoutMs,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: params.model,
        messages,
        stream: false,
        think: false,
        options: {
          num_predict: params.maxTokens,
          ...(params.temperature !== undefined && { temperature: params.temperature }),
        },
      }),
    },
  });
  const response = typeof data.message?.content === "string" ? data.message.content : undefined;
  if (response === undefined) {
    throw new Error("Ollama /api/chat response did not contain message.content");
  }
  if (data.done_reason === "length") {
    throw new Error(
      `Ollama stopped after reaching maxTokens (${params.maxTokens}); retry with a larger maxTokens value`,
    );
  }
  const promptTokens = optionalNumber(data.prompt_eval_count);
  const completionTokens = optionalNumber(data.eval_count);
  const loadMs = durationMs(data.load_duration);
  const totalMs = durationMs(data.total_duration);
  return {
    provider: "ollama",
    model: typeof data.model === "string" && data.model.trim() ? data.model : params.model,
    response,
    ...(promptTokens !== undefined || completionTokens !== undefined
      ? { usage: { promptTokens, completionTokens } }
      : {}),
    ...(loadMs !== undefined || totalMs !== undefined ? { timings: { loadMs, totalMs } } : {}),
  };
}

export function createOllamaNodeHostCommands(options?: {
  baseUrl?: string;
}): OpenClawPluginNodeHostCommand[] {
  const baseUrl = options?.baseUrl ?? OLLAMA_DEFAULT_BASE_URL;
  return [
    {
      command: OLLAMA_MODELS_COMMAND,
      cap: OLLAMA_NODE_INFERENCE_CAPABILITY,
      handle: async () => JSON.stringify(await discoverOllamaNodeModels(baseUrl)),
    },
    {
      command: OLLAMA_CHAT_COMMAND,
      cap: OLLAMA_NODE_INFERENCE_CAPABILITY,
      handle: async (paramsJSON) => {
        const params = readNodeCommandParams(paramsJSON);
        const model = readStringParam(params, "model", { required: true });
        const prompt = readStringParam(params, "prompt", { required: true, trim: false });
        const system = readStringParam(params, "system", { trim: false });
        const maxTokens =
          readPositiveIntegerParam(params, "maxTokens", {
            max: MAX_TOKENS,
            message: `maxTokens must be an integer between 1 and ${MAX_TOKENS}`,
          }) ?? DEFAULT_MAX_TOKENS;
        const timeoutMs =
          readPositiveIntegerParam(params, "timeoutMs", {
            max: MAX_INFERENCE_TIMEOUT_MS,
            message: `timeoutMs must be an integer between 1 and ${MAX_INFERENCE_TIMEOUT_MS}`,
          }) ?? DEFAULT_INFERENCE_TIMEOUT_MS;
        const temperature = readFiniteNumberParam(params, "temperature", {
          min: 0,
          max: 2,
          message: "temperature must be between 0 and 2",
        });
        if (prompt.length > MAX_PROMPT_CHARS) {
          throw new Error(`prompt exceeds ${MAX_PROMPT_CHARS} characters`);
        }
        if (system && system.length > MAX_SYSTEM_PROMPT_CHARS) {
          throw new Error(`system exceeds ${MAX_SYSTEM_PROMPT_CHARS} characters`);
        }
        return JSON.stringify(
          await runOllamaNodeChat({
            baseUrl,
            model,
            prompt,
            system,
            temperature,
            maxTokens,
            timeoutMs,
          }),
        );
      },
    },
  ];
}

export function createOllamaNodeInvokePolicy(): OpenClawPluginNodeInvokePolicy {
  return {
    commands: [...OLLAMA_NODE_INFERENCE_COMMANDS],
    defaultPlatforms: ["macos", "linux", "windows"],
    handle: async (ctx) => await ctx.invokeNode(),
  };
}

function findNode(nodes: NodeSummary[], query: string): NodeSummary {
  const normalized = query.trim().toLowerCase();
  const matches = nodes.filter(
    (node) =>
      node.nodeId.toLowerCase() === normalized || node.displayName?.toLowerCase() === normalized,
  );
  if (matches.length === 0) {
    throw new Error(`node ${JSON.stringify(query)} is not connected with Ollama inference support`);
  }
  if (matches.length > 1) {
    throw new Error(`node ${JSON.stringify(query)} is ambiguous; use its nodeId`);
  }
  return expectDefined(matches[0], "single matching Ollama inference node");
}

function parseInvokePayload(raw: unknown): Record<string, unknown> {
  const result = asRecord(raw);
  let payload = asRecord(result?.payload);
  if (!payload && typeof result?.payloadJSON === "string") {
    payload = asRecord(JSON.parse(result.payloadJSON));
  }
  if (!payload) {
    throw new Error("node returned an invalid Ollama inference payload");
  }
  return payload;
}

async function invokeNode(
  api: OpenClawPluginApi,
  nodeId: string,
  command: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const raw = await api.runtime.nodes.invoke({
    nodeId,
    command,
    params,
    timeoutMs,
    scopes: ["operator.write"],
  });
  return parseInvokePayload(raw);
}

const ollamaNodeInferenceToolDefinition = {
  name: "node_inference",
  label: "Node Inference",
  description:
    "Discover and run chat-capable Ollama models installed on paired desktop/server nodes. Use action=discover first, then action=run with a node and model from that result. Inference stays on the selected node.",
  parameters: Type.Object(
    {
      action: Type.Union([Type.Literal("discover"), Type.Literal("run")]),
      node: Type.Optional(
        Type.String({ description: "Connected node id or display name. Required when ambiguous." }),
      ),
      model: Type.Optional(
        Type.String({ description: "Exact local model name returned by discover." }),
      ),
      prompt: Type.Optional(Type.String({ description: "Prompt for action=run." })),
      system: Type.Optional(Type.String({ description: "Optional system prompt for action=run." })),
      temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
      maxTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TOKENS })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_INFERENCE_TIMEOUT_MS })),
    },
    { additionalProperties: false },
  ),
} as const;

export function createOllamaNodeInferenceTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    ...ollamaNodeInferenceToolDefinition,
    execute: async (_toolCallId, args) => {
      const params = asRecord(args) ?? {};
      const action = readStringParam(params, "action", { required: true });
      const nodeQuery = readStringParam(params, "node");
      const listed = await api.runtime.nodes.list({ connected: true });
      const modelNodes = listed.nodes.filter((node) =>
        node.commands?.includes(OLLAMA_MODELS_COMMAND),
      );

      if (action === "discover") {
        const targets = nodeQuery ? [findNode(modelNodes, nodeQuery)] : modelNodes;
        const nodes = await Promise.all(
          targets.map(async (node) => {
            try {
              const payload = await invokeNode(
                api,
                node.nodeId,
                OLLAMA_MODELS_COMMAND,
                {},
                DISCOVERY_TRANSPORT_TIMEOUT_MS,
              );
              const result: Record<string, unknown> = { nodeId: node.nodeId, ok: true };
              if (node.displayName) {
                result.displayName = node.displayName;
              }
              return Object.assign(result, payload);
            } catch (error) {
              const result: Record<string, unknown> = {
                nodeId: node.nodeId,
                ok: false,
                error: errorMessage(error),
              };
              if (node.displayName) {
                result.displayName = node.displayName;
              }
              return result;
            }
          }),
        );
        return jsonResult({
          nodes,
          ...(modelNodes.length === 0 && {
            hint: "No connected node advertises Ollama inference. Start Ollama and `openclaw node run` on the target machine, then approve any request shown by `openclaw nodes pending`.",
          }),
        });
      }

      if (action !== "run") {
        throw new Error("action must be discover or run");
      }
      const chatNodes = modelNodes.filter((node) => node.commands?.includes(OLLAMA_CHAT_COMMAND));
      const node = nodeQuery
        ? findNode(chatNodes, nodeQuery)
        : chatNodes.length === 1
          ? chatNodes[0]
          : undefined;
      if (!node) {
        throw new Error(
          chatNodes.length === 0
            ? "no connected node advertises Ollama inference"
            : "multiple nodes advertise Ollama inference; specify node",
        );
      }
      const model = readStringParam(params, "model", { required: true });
      const prompt = readStringParam(params, "prompt", { required: true, trim: false });
      const maxTokens =
        readPositiveIntegerParam(params, "maxTokens", { max: MAX_TOKENS }) ?? DEFAULT_MAX_TOKENS;
      const timeoutMs =
        readPositiveIntegerParam(params, "timeoutMs", { max: MAX_INFERENCE_TIMEOUT_MS }) ??
        DEFAULT_INFERENCE_TIMEOUT_MS;
      const system = readStringParam(params, "system", { trim: false });
      const temperature = readFiniteNumberParam(params, "temperature", { min: 0, max: 2 });
      const commandParams: Record<string, unknown> = {
        model,
        prompt,
        maxTokens,
        timeoutMs,
      };
      if (system !== undefined) {
        commandParams.system = system;
      }
      if (temperature !== undefined) {
        commandParams.temperature = temperature;
      }
      const result = await invokeNode(
        api,
        node.nodeId,
        OLLAMA_CHAT_COMMAND,
        commandParams,
        // The command validates the selected model before starting its chat timeout.
        // Keep that bounded preflight outside the inference budget seen by users.
        timeoutMs + INFERENCE_TRANSPORT_GRACE_MS,
      );
      return jsonResult({
        nodeId: node.nodeId,
        ...(node.displayName && { displayName: node.displayName }),
        ...result,
      });
    },
  };
}

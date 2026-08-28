import { jsonResult } from "openclaw/plugin-sdk/channel-actions";
import { formatErrorMessage as errorMessage } from "openclaw/plugin-sdk/error-runtime";
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
import { asFiniteNumber, asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { OLLAMA_DEFAULT_BASE_URL } from "./defaults.js";
import {
  DEFAULT_INFERENCE_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS,
  DISCOVERY_TRANSPORT_TIMEOUT_MS,
  MAX_INFERENCE_TIMEOUT_MS,
  MAX_PROMPT_CHARS,
  MAX_SYSTEM_PROMPT_CHARS,
  MAX_TOKENS,
  OLLAMA_CHAT_COMMAND,
  OLLAMA_MODELS_COMMAND,
  OLLAMA_NODE_INFERENCE_CAPABILITY,
  OLLAMA_NODE_INFERENCE_COMMANDS,
  OLLAMA_NODE_INFERENCE_DEFAULT_PLATFORMS,
  ollamaNodeInferenceToolDefinition,
} from "./node-inference-contract.js";
import {
  buildOllamaBaseUrlSsrFPolicy,
  enrichOllamaCompletionModels,
  enrichOllamaModelsWithContext,
  fetchLoadedOllamaModelNames,
  fetchOllamaModels,
  isOllamaRemoteModel,
  resolveOllamaApiBase,
  throwIfOllamaRequestAborted,
} from "./provider-models.js";

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

function readNodeCommandParams(paramsJSON?: string | null): Record<string, unknown> {
  if (!paramsJSON) {
    return {};
  }
  const parsed = asNullableRecord(JSON.parse(paramsJSON));
  if (!parsed) {
    throw new Error("node inference params must be a JSON object");
  }
  return parsed;
}

function durationMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.round((value / 1_000_000) * 100) / 100;
}

async function requestOllamaJson<T>(params: {
  baseUrl: string;
  path: string;
  timeoutMs: number;
  init?: RequestInit;
  signal?: AbortSignal;
}): Promise<T> {
  const apiBase = resolveOllamaApiBase(params.baseUrl);
  let response: Response;
  let release: (() => Promise<void>) | undefined;
  try {
    const guarded = await fetchWithSsrFGuard({
      url: `${apiBase}${params.path}`,
      init: params.init,
      // Guard-owned timeoutMs also bounds DNS/proxy preflight; init.signal does not.
      timeoutMs: params.timeoutMs,
      ...(params.signal ? { signal: params.signal } : {}),
      policy: buildOllamaBaseUrlSsrFPolicy(apiBase),
      auditContext: `ollama-node-inference${params.path}`,
    });
    response = guarded.response;
    release = guarded.release;
  } catch (error) {
    throwIfOllamaRequestAborted(params.signal);
    throw new Error(`Ollama is unavailable at ${apiBase}: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  try {
    if (!response.ok) {
      const body = (await readResponseTextLimited(response, MAX_ERROR_BODY_BYTES)).trim();
      let detail = body;
      try {
        const parsed = asNullableRecord(JSON.parse(body));
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

async function discoverOllamaNodeModels(
  baseUrl = OLLAMA_DEFAULT_BASE_URL,
  signal?: AbortSignal,
): Promise<OllamaModelsPayload> {
  const apiBase = resolveOllamaApiBase(baseUrl);
  const discovered = await fetchOllamaModels(apiBase, signal ? { signal } : undefined);
  if (!discovered.reachable) {
    throw new Error(`Ollama is not running at ${apiBase}`);
  }
  const localModels = discovered.models.filter((model) => !isOllamaRemoteModel(model));
  const loaded = await fetchLoadedOllamaModelNames(apiBase, signal ? { signal } : undefined);
  // Model discovery still works against Ollama versions without /api/ps.
  const loadedNames = new Set(loaded.models);
  // Probe loaded models before the bounded catalog can hide already-runnable node models.
  const prioritizedModels = localModels.toSorted(
    (left, right) => Number(loadedNames.has(right.name)) - Number(loadedNames.has(left.name)),
  );
  // Paired nodes must positively confirm completion; unlike provider catalogs,
  // failed or legacy show probes must never expose unrunnable remote commands.
  const models = await enrichOllamaCompletionModels(apiBase, prioritizedModels, {
    requireCompletionCapability: true,
    ...(signal ? { signal } : {}),
  });
  const rows = models
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
  signal?: AbortSignal;
}): Promise<OllamaChatPayload> {
  const apiBase = resolveOllamaApiBase(params.baseUrl);
  const deadlineMs = performance.now() + params.timeoutMs;
  const remainingTimeoutMs = (): number => {
    const remainingMs = Math.ceil(deadlineMs - performance.now());
    if (remainingMs <= 0) {
      throw new Error(`Ollama node inference timed out after ${params.timeoutMs}ms`);
    }
    return remainingMs;
  };
  const discovered = await fetchOllamaModels(apiBase, {
    timeoutMs: remainingTimeoutMs(),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const localModel = discovered.models.find(
    (model) => model.name === params.model && !isOllamaRemoteModel(model),
  );
  const [model] = localModel
    ? await enrichOllamaModelsWithContext(apiBase, [localModel], {
        timeoutMs: remainingTimeoutMs(),
        ...(params.signal ? { signal: params.signal } : {}),
      })
    : [];
  if (!discovered.reachable || model?.capabilities?.includes("completion") !== true) {
    remainingTimeoutMs();
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
    timeoutMs: remainingTimeoutMs(),
    ...(params.signal ? { signal: params.signal } : {}),
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
  const promptTokens = asFiniteNumber(data.prompt_eval_count);
  const completionTokens = asFiniteNumber(data.eval_count);
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
      handle: async (_paramsJSON, _io, context) =>
        JSON.stringify(await discoverOllamaNodeModels(baseUrl, context?.signal)),
    },
    {
      command: OLLAMA_CHAT_COMMAND,
      cap: OLLAMA_NODE_INFERENCE_CAPABILITY,
      handle: async (paramsJSON, _io, context) => {
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
            ...(context?.signal ? { signal: context.signal } : {}),
          }),
        );
      },
    },
  ];
}

export function createOllamaNodeInvokePolicy(): OpenClawPluginNodeInvokePolicy {
  return {
    commands: [...OLLAMA_NODE_INFERENCE_COMMANDS],
    defaultPlatforms: [...OLLAMA_NODE_INFERENCE_DEFAULT_PLATFORMS],
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
  const result = asNullableRecord(raw);
  let payload = asNullableRecord(result?.payload);
  if (!payload && typeof result?.payloadJSON === "string") {
    payload = asNullableRecord(JSON.parse(result.payloadJSON));
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
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  throwIfOllamaRequestAborted(signal);
  const raw = await api.runtime.nodes.invoke({
    nodeId,
    command,
    params,
    timeoutMs,
    scopes: ["operator.write"],
    ...(signal ? { signal } : {}),
  });
  return parseInvokePayload(raw);
}

export function createOllamaNodeInferenceTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    ...ollamaNodeInferenceToolDefinition,
    execute: async (_toolCallId, args, signal) => {
      throwIfOllamaRequestAborted(signal);
      const params = asNullableRecord(args) ?? {};
      const action = readStringParam(params, "action", { required: true });
      const nodeQuery = readStringParam(params, "node");
      const listed = await api.runtime.nodes.list({ connected: true });
      const modelNodes = listed.nodes.filter((node) =>
        (node.invocableCommands ?? node.commands)?.includes(OLLAMA_MODELS_COMMAND),
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
                signal,
              );
              const result: Record<string, unknown> = { nodeId: node.nodeId, ok: true };
              if (node.displayName) {
                result.displayName = node.displayName;
              }
              return Object.assign(result, payload);
            } catch (error) {
              throwIfOllamaRequestAborted(signal);
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
      const chatNodes = modelNodes.filter((node) =>
        (node.invocableCommands ?? node.commands)?.includes(OLLAMA_CHAT_COMMAND),
      );
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
        timeoutMs,
        signal,
      );
      return jsonResult({
        nodeId: node.nodeId,
        ...(node.displayName && { displayName: node.displayName }),
        ...result,
      });
    },
  };
}

// Llm Task plugin module implements llm task tool behavior.
import { buildModelAliasIndex, resolveModelRefFromString } from "openclaw/plugin-sdk/agent-runtime";
import {
  optionalFiniteNumberSchema,
  optionalPositiveIntegerSchema,
} from "openclaw/plugin-sdk/channel-actions";
import {
  type JsonSchemaObject,
  validateJsonSchemaValue,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { readFiniteNumberParam, readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import {
  asPositiveSafeInteger,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import type { OpenClawPluginApi } from "../api.js";

function stripCodeFences(s: string): string {
  const trimmed = s.trim();
  const m = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (m) {
    return (m[1] ?? "").trim();
  }
  return trimmed;
}

function toModelKey(provider?: string, model?: string): string | undefined {
  const p = provider?.trim();
  const m = model?.trim();
  if (!p || !m) {
    return undefined;
  }
  return `${p}/${m}`;
}

function stripDuplicateProviderPrefix(provider: string | undefined, model: string | undefined) {
  const p = provider?.trim();
  const m = model?.trim();
  if (!p || !m) {
    return m || undefined;
  }
  const prefix = `${p}/`;
  return m.startsWith(prefix) ? m.slice(prefix.length) : m;
}

function resolveLlmTaskModelRef(params: {
  api: OpenClawPluginApi;
  provider?: string;
  rawModel?: string;
}): { provider?: string; model?: string } {
  const defaultProvider =
    normalizeOptionalString(params.provider) ??
    normalizeOptionalString(params.api.runtime.agent.defaults.provider);
  const rawModel = normalizeOptionalString(params.rawModel);
  if (!rawModel || !defaultProvider) {
    return {
      provider: params.provider,
      model: stripDuplicateProviderPrefix(params.provider, rawModel),
    };
  }

  const cfg = params.api.config;
  const aliasIndex = cfg
    ? buildModelAliasIndex({
        cfg,
        defaultProvider,
      })
    : undefined;
  const resolved = resolveModelRefFromString({
    cfg,
    raw: rawModel,
    defaultProvider,
    aliasIndex,
  });
  if (!resolved) {
    return {
      provider: params.provider,
      model: stripDuplicateProviderPrefix(params.provider, rawModel),
    };
  }
  return resolved.ref;
}

type PluginCfg = {
  defaultProvider?: string;
  defaultModel?: string;
  defaultAuthProfileId?: string;
  maxTokens?: number;
  timeoutMs?: number;
};

type LlmTaskParams = {
  prompt?: unknown;
  input?: unknown;
  schema?: unknown;
  provider?: unknown;
  model?: unknown;
  thinking?: unknown;
  authProfileId?: unknown;
  temperature?: unknown;
  maxTokens?: unknown;
  timeoutMs?: unknown;
};

export const llmTaskToolDefinition = {
  name: "llm-task",
  label: "LLM Task",
  description:
    "Run a generic JSON-only LLM task and return schema-validated JSON. Designed for orchestration from Lobster workflows via openclaw.invoke.",
  parameters: Type.Object({
    prompt: Type.String({ description: "Task instruction for the LLM." }),
    input: Type.Optional(Type.Unknown({ description: "Optional input payload for the task." })),
    schema: Type.Optional(
      Type.Unknown({ description: "Optional JSON Schema to validate the returned JSON." }),
    ),
    provider: Type.Optional(
      Type.String({ description: "Provider override (e.g. openai, anthropic)." }),
    ),
    model: Type.Optional(Type.String({ description: "Model id override." })),
    thinking: Type.Optional(Type.String({ description: "Thinking level override." })),
    authProfileId: Type.Optional(Type.String({ description: "Auth profile override." })),
    temperature: optionalFiniteNumberSchema({ description: "Best-effort temperature override." }),
    maxTokens: optionalPositiveIntegerSchema({
      description: "Best-effort maxTokens override.",
    }),
    timeoutMs: optionalPositiveIntegerSchema({ description: "Timeout for the LLM run." }),
  }),
};

export function createLlmTaskTool(api: OpenClawPluginApi) {
  return {
    ...llmTaskToolDefinition,

    async execute(_id: string, params: LlmTaskParams, signal?: AbortSignal) {
      const prompt = typeof params.prompt === "string" ? params.prompt : "";
      if (!prompt.trim()) {
        throw new Error("prompt required");
      }

      const pluginCfg = (api.pluginConfig ?? {}) as PluginCfg;

      const defaultsModel = api.config?.agents?.defaults?.model;
      const primary =
        typeof defaultsModel === "string"
          ? normalizeOptionalString(defaultsModel)
          : normalizeOptionalString(defaultsModel?.primary);
      const primaryProvider = typeof primary === "string" ? primary.split("/")[0] : undefined;
      const primaryModel =
        typeof primary === "string" ? primary.split("/").slice(1).join("/") : undefined;

      const requestProvider =
        typeof params.provider === "string" ? params.provider.trim() : undefined;
      const configuredProvider =
        typeof pluginCfg.defaultProvider === "string"
          ? pluginCfg.defaultProvider.trim()
          : undefined;
      const requestModel = typeof params.model === "string" ? params.model.trim() : undefined;
      const configuredModel =
        typeof pluginCfg.defaultModel === "string" ? pluginCfg.defaultModel.trim() : undefined;
      const requestedProvider =
        requestProvider || configuredProvider || primaryProvider || undefined;
      const rawModel = requestModel || configuredModel || primaryModel || undefined;
      const hasModelOverride = Boolean(
        requestProvider || configuredProvider || requestModel || configuredModel,
      );
      const { provider: resolvedProvider, model } = resolveLlmTaskModelRef({
        api,
        provider: requestedProvider,
        rawModel,
      });
      const provider = resolvedProvider;

      const authProfileId =
        (typeof params.authProfileId === "string" && params.authProfileId.trim()) ||
        (typeof pluginCfg.defaultAuthProfileId === "string" &&
          pluginCfg.defaultAuthProfileId.trim()) ||
        undefined;

      const modelKey = toModelKey(provider, model);
      if (!provider || !model || !modelKey) {
        throw new Error(
          `provider/model could not be resolved (provider=${provider ?? ""}, model=${model ?? ""})`,
        );
      }

      const thinkingRaw =
        typeof params.thinking === "string" && params.thinking.trim() ? params.thinking : undefined;
      let thinkLevel: ReturnType<OpenClawPluginApi["runtime"]["agent"]["normalizeThinkingLevel"]> =
        undefined;
      if (thinkingRaw) {
        thinkLevel = api.runtime.agent.normalizeThinkingLevel(thinkingRaw);
        if (!thinkLevel) {
          throw new Error(`Invalid thinking level "${thinkingRaw}".`);
        }
      }

      const timeoutMs =
        readPositiveIntegerParam(params as Record<string, unknown>, "timeoutMs") ??
        asPositiveSafeInteger(pluginCfg.timeoutMs) ??
        30_000;

      const streamParams = {
        temperature: readFiniteNumberParam(params as Record<string, unknown>, "temperature"),
        maxTokens:
          readPositiveIntegerParam(params as Record<string, unknown>, "maxTokens") ??
          asPositiveSafeInteger(pluginCfg.maxTokens),
      };

      const input = params.input;
      let inputJson: string;
      try {
        inputJson = JSON.stringify(input ?? null, null, 2);
      } catch {
        throw new Error("input must be JSON-serializable");
      }

      const system = [
        "You are a JSON-only function.",
        "Return ONLY a valid JSON value.",
        "Do not wrap in markdown fences.",
        "Do not include commentary.",
        "Do not call tools.",
      ].join(" ");

      const result = await api.runtime.llm.complete({
        messages: [
          {
            role: "user",
            content: `TASK:\n${prompt}\n\nINPUT_JSON:\n${inputJson}\n`,
          },
        ],
        systemPrompt: system,
        model: hasModelOverride ? modelKey : undefined,
        reasoning: thinkLevel,
        maxTokens: streamParams.maxTokens,
        temperature: streamParams.temperature,
        signal,
        purpose: "llm-task",
        execution: {
          mode: "isolated-agent-runtime",
          authProfileId,
          timeoutMs,
        },
      });

      const raw = stripCodeFences(result.text);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("LLM returned invalid JSON");
      }

      const schema = params.schema;
      if (schema && typeof schema === "object" && !Array.isArray(schema)) {
        const validation = validateJsonSchemaValue({
          schema: schema as JsonSchemaObject,
          cacheKey: "llm-task.result",
          value: parsed,
          cache: false,
        });
        if (!validation.ok) {
          const msg = validation.errors.map((error) => error.text).join("; ") || "invalid";
          throw new Error(`LLM JSON did not match schema: ${msg}`);
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
        details: { json: parsed, provider: result.provider, model: result.model },
      };
    },
  };
}

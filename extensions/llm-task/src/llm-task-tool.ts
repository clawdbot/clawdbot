import path from "node:path";
import { buildModelAliasIndex, resolveModelRefFromString } from "openclaw/plugin-sdk/agent-runtime";
import {
  type JsonSchemaObject,
  validateJsonSchemaValue,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "../api.js";
import type { OpenClawPluginApi } from "../api.js";

function stripCodeFences(s: string): string {
  const trimmed = s.trim();
  const m = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (m) {
    return (m[1] ?? "").trim();
  }
  return trimmed;
}

function collectText(payloads: Array<{ text?: string; isError?: boolean }> | undefined): string {
  const texts = (payloads ?? [])
    .filter((p) => !p.isError && typeof p.text === "string")
    .map((p) => p.text ?? "");
  return texts.join("\n").trim();
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
  allowedModels?: string[];
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

type ThinkingPolicy = ReturnType<OpenClawPluginApi["runtime"]["agent"]["resolveThinkingPolicy"]>;

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
      Type.String({ description: "Provider override (e.g. openai-codex, anthropic)." }),
    ),
    model: Type.Optional(Type.String({ description: "Model id override." })),
    thinking: Type.Optional(Type.String({ description: "Thinking level override." })),
    authProfileId: Type.Optional(Type.String({ description: "Auth profile override." })),
    temperature: Type.Optional(Type.Number({ description: "Best-effort temperature override." })),
    maxTokens: Type.Optional(Type.Number({ description: "Best-effort maxTokens override." })),
    timeoutMs: Type.Optional(Type.Number({ description: "Timeout for the LLM run." })),
  }),
};

function formatThinkingPolicy(policy: ThinkingPolicy): string {
  return policy.levels.map((level) => level.label).join(", ");
}

function supportsThinkingPolicyLevel(
  policy: ThinkingPolicy,
  level: ReturnType<OpenClawPluginApi["runtime"]["agent"]["normalizeThinkingLevel"]>,
): boolean {
  return !!level && policy.levels.some((entry) => entry.id === level);
}

export function createLlmTaskTool(api: OpenClawPluginApi) {
  return {
    ...llmTaskToolDefinition,

    async execute(_id: string, params: LlmTaskParams) {
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

      const requestedProvider =
        (typeof params.provider === "string" && params.provider.trim()) ||
        (typeof pluginCfg.defaultProvider === "string" && pluginCfg.defaultProvider.trim()) ||
        primaryProvider ||
        undefined;

      const rawModel =
        (typeof params.model === "string" && params.model.trim()) ||
        (typeof pluginCfg.defaultModel === "string" && pluginCfg.defaultModel.trim()) ||
        primaryModel ||
        undefined;
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

      const allowed = Array.isArray(pluginCfg.allowedModels) ? pluginCfg.allowedModels : undefined;
      if (allowed && allowed.length > 0 && !allowed.includes(modelKey)) {
        throw new Error(
          `Model not allowed by llm-task plugin config: ${modelKey}. Allowed models: ${allowed.join(", ")}`,
        );
      }

      const thinkingRaw =
        typeof params.thinking === "string" && params.thinking.trim() ? params.thinking : undefined;
      let thinkLevel: ReturnType<OpenClawPluginApi["runtime"]["agent"]["normalizeThinkingLevel"]> =
        undefined;
      if (thinkingRaw) {
        const thinkingPolicy = api.runtime.agent.resolveThinkingPolicy({ provider, model });
        const thinkingLevelsHint = formatThinkingPolicy(thinkingPolicy);
        thinkLevel = api.runtime.agent.normalizeThinkingLevel(thinkingRaw);
        if (!thinkLevel) {
          throw new Error(
            `Invalid thinking level "${thinkingRaw}". Use one of: ${thinkingLevelsHint}.`,
          );
        }
        if (!supportsThinkingPolicyLevel(thinkingPolicy, thinkLevel)) {
          throw new Error(
            `Thinking level "${thinkLevel}" is not supported for ${provider}/${model}. Use one of: ${thinkingLevelsHint}.`,
          );
        }
      }

      const timeoutMs =
        (typeof params.timeoutMs === "number" && params.timeoutMs > 0
          ? params.timeoutMs
          : undefined) ||
        (typeof pluginCfg.timeoutMs === "number" && pluginCfg.timeoutMs > 0
          ? pluginCfg.timeoutMs
          : undefined) ||
        30_000;

      const streamParams = {
        temperature: typeof params.temperature === "number" ? params.temperature : undefined,
        maxTokens:
          typeof params.maxTokens === "number"
            ? params.maxTokens
            : typeof pluginCfg.maxTokens === "number"
              ? pluginCfg.maxTokens
              : undefined,
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

      const fullPrompt = `${system}\n\nTASK:\n${prompt}\n\nINPUT_JSON:\n${inputJson}\n`;

      return await withTempWorkspace(
        { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-llm-task-" },
        async ({ dir: tmpDir }) => {
          const sessionId = `llm-task-${Date.now()}`;
          const sessionFile = path.join(tmpDir, "session.json");

          const result = await api.runtime.agent.runEmbeddedPiAgent({
            sessionId,
            sessionFile,
            workspaceDir: api.config?.agents?.defaults?.workspace ?? process.cwd(),
            config: api.config,
            prompt: fullPrompt,
            timeoutMs,
            runId: `llm-task-${Date.now()}`,
            provider,
            model,
            authProfileId,
            authProfileIdSource: authProfileId ? "user" : "auto",
            thinkLevel,
            streamParams,
            disableTools: true,
          });

          const text = collectText(
            typeof result === "object" && result !== null && "payloads" in result
              ? (result as { payloads?: Array<{ text?: string; isError?: boolean }> }).payloads
              : undefined,
          );
          if (!text) {
            throw new Error("LLM returned empty output");
          }

          const raw = stripCodeFences(text);
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
            details: { json: parsed, provider, model },
          };
        },
      );
    },
  };
}

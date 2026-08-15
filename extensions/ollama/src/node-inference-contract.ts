import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";

export const OLLAMA_NODE_INFERENCE_CAPABILITY = "local-inference";
export const OLLAMA_MODELS_COMMAND = "ollama.models";
export const OLLAMA_CHAT_COMMAND = "ollama.chat";
export const OLLAMA_NODE_INFERENCE_COMMANDS = [OLLAMA_MODELS_COMMAND, OLLAMA_CHAT_COMMAND] as const;
export const OLLAMA_NODE_INFERENCE_DEFAULT_PLATFORMS = ["macos", "linux", "windows"] as const;

export const DEFAULT_INFERENCE_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_TOKENS = 512;
export const DISCOVERY_TRANSPORT_TIMEOUT_MS = 90_000;
export const MAX_INFERENCE_TIMEOUT_MS = 10 * 60_000;
export const MAX_TOKENS = 8192;
export const MAX_PROMPT_CHARS = 128_000;
export const MAX_SYSTEM_PROMPT_CHARS = 32_000;

export const ollamaNodeInferenceToolDefinition = {
  name: "node_inference",
  label: "Node Inference",
  description:
    "Discover and run chat-capable Ollama models installed on paired desktop/server nodes. Use action=discover first, then action=run with a node and model from that result. Inference stays on the selected node.",
  parameters: Type.Object(
    {
      action: stringEnum(["discover", "run"] as const),
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
} as const satisfies Pick<AnyAgentTool, "name" | "label" | "description" | "parameters">;

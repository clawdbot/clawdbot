import type { Api, AssistantMessage, Context, Model } from "@mariozechner/pi-ai";

export const LIVE_MODEL_FILE_PROBE_TOKEN = "opal";

export const LIVE_MODEL_FILE_PROBE_ENV = "OPENCLAW_LIVE_MODEL_FILE_PROBE";
export const LIVE_MODEL_IMAGE_PROBE_ENV = "OPENCLAW_LIVE_MODEL_IMAGE_PROBE";

const PROBE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAALUlEQVR4nO3OIQEAAAwCMPrnod8fAzMxv7S9pQgICAgICAgICAgICAgICKwDD+yWbLXSniMNAAAAAElFTkSuQmCC";

const KNOWN_EMPTY_EXTRA_PROBE_MODELS = new Set(["openrouter/amazon/nova-2-lite-v1"]);
const KNOWN_EMPTY_FILE_PROBE_MODELS = new Set([
  "google/gemini-3-pro-preview",
  "google/gemini-3.1-pro-preview-customtools",
  "opencode-go/glm-5",
  "opencode-go/glm-5.1",
  "opencode-go/mimo-v2-omni",
  "opencode-go/mimo-v2-pro",
  "opencode-go/minimax-m2.5",
  "openrouter/arcee-ai/trinity-mini",
  "openrouter/deepseek/deepseek-chat-v3.1",
  "openrouter/minimax/minimax-m2.5",
  "openrouter/nvidia/llama-3.3-nemotron-super-49b-v1.5",
  "openrouter/nvidia/nemotron-nano-12b-v2-vl:free",
  "openrouter/qwen/qwen3.5-9b",
  "openrouter/tngtech/deepseek-r1t2-chimera",
  "openrouter/z-ai/glm-4.5",
  "openrouter/z-ai/glm-4.6",
  "openrouter/z-ai/glm-4.7",
  "openrouter/z-ai/glm-4.7-flash",
  "openrouter/z-ai/glm-5",
  "openrouter/z-ai/glm-5.1",
]);
const KNOWN_EMPTY_IMAGE_PROBE_MODELS = new Set([
  "fireworks/accounts/fireworks/models/kimi-k2p5",
  "fireworks/accounts/fireworks/models/kimi-k2p6",
  "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
  "google/gemini-3.1-pro-preview-customtools",
  "opencode/kimi-k2.6",
  "opencode-go/mimo-v2-omni",
  "opencode-go/kimi-k2.5",
  "opencode-go/kimi-k2.6",
  "openrouter/amazon/nova-pro-v1",
  "openrouter/bytedance-seed/seed-1.6",
]);

function modelKey(model: Pick<Model<Api>, "id" | "provider">): string {
  return `${model.provider}/${model.id}`;
}

export function isLiveModelProbeEnabled(
  env: Record<string, string | undefined>,
  key: string,
): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) {
    return true;
  }
  return !["0", "false", "no", "off"].includes(raw);
}

export function extractAssistantText(message: Pick<AssistantMessage, "content">): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join(" ");
}

export function modelSupportsImageInput(model: Pick<Model<Api>, "input">): boolean {
  return model.input.includes("image");
}

export function shouldSkipLiveModelExtraProbes(
  model: Pick<Model<Api>, "id" | "provider">,
): boolean {
  return KNOWN_EMPTY_EXTRA_PROBE_MODELS.has(modelKey(model));
}

export function shouldSkipLiveModelFileProbe(model: Pick<Model<Api>, "id" | "provider">): boolean {
  if (model.provider === "opencode-go") {
    return true;
  }
  return KNOWN_EMPTY_FILE_PROBE_MODELS.has(modelKey(model));
}

export function shouldSkipLiveModelImageProbe(model: Pick<Model<Api>, "id" | "provider">): boolean {
  return KNOWN_EMPTY_IMAGE_PROBE_MODELS.has(modelKey(model));
}

export function buildLiveModelFileProbeContext(params: { systemPrompt?: string }): Context {
  return {
    systemPrompt: params.systemPrompt,
    messages: [
      {
        role: "user",
        content:
          "Read this visible label and reply with only the value after LIVE_LABEL.\n\n" +
          `LIVE_LABEL=${LIVE_MODEL_FILE_PROBE_TOKEN}`,
        timestamp: Date.now(),
      },
    ],
  };
}

export function buildLiveModelFileProbeRetryContext(params: { systemPrompt?: string }): Context {
  return {
    systemPrompt: params.systemPrompt,
    messages: [
      {
        role: "user",
        content:
          "The visible label value is:\n\n" +
          `${LIVE_MODEL_FILE_PROBE_TOKEN}\n\n` +
          `Reply with exactly ${LIVE_MODEL_FILE_PROBE_TOKEN}.`,
        timestamp: Date.now(),
      },
    ],
  };
}

export function buildLiveModelImageProbeContext(params: { systemPrompt?: string }): Context {
  return {
    systemPrompt: params.systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Reply with exactly OK.",
          },
          {
            type: "image",
            data: PROBE_PNG_BASE64,
            mimeType: "image/png",
          },
        ],
        timestamp: Date.now(),
      },
    ],
  };
}

export function fileProbeTextMatches(text: string): boolean {
  return text.toLowerCase().includes(LIVE_MODEL_FILE_PROBE_TOKEN.toLowerCase());
}

export function imageProbeTextMatches(text: string): boolean {
  return /\bok\b/i.test(text);
}

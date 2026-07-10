/**
 * Prompt/context builders for live model turn probes.
 *
 * Live profile tests use these fixtures to verify text, file-label, and image
 * turn behavior without coupling probe construction to the large live suite.
 */
import type { Context, Model } from "../llm/types.js";

/** Stable token embedded in file-style live probe prompts. */
export const LIVE_MODEL_FILE_PROBE_TOKEN = "opal";

/** Environment toggle for live file-label probes. */
export const LIVE_MODEL_FILE_PROBE_ENV = "OPENCLAW_LIVE_MODEL_FILE_PROBE";
/** Environment toggle for live image probes. */
export const LIVE_MODEL_IMAGE_PROBE_ENV = "OPENCLAW_LIVE_MODEL_IMAGE_PROBE";

const PROBE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAALUlEQVR4nO3OIQEAAAwCMPrnod8fAzMxv7S9pQgICAgICAgICAgICAgICKwDD+yWbLXSniMNAAAAAElFTkSuQmCC";

const KNOWN_EMPTY_EXTRA_PROBE_MODELS = new Set(["openrouter/amazon/nova-2-lite-v1"]);
const KNOWN_EMPTY_FILE_PROBE_MODELS = new Set([
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.1-pro-preview-customtools",
  "opencode-go/glm-5",
  "opencode-go/glm-5.1",
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
  "opencode-go/kimi-k2.5",
  "opencode-go/kimi-k2.6",
  "openrouter/amazon/nova-pro-v1",
  "openrouter/bytedance-seed/seed-1.6",
]);

function modelKey(model: Pick<Model, "id" | "provider">): string {
  return `${model.provider}/${model.id}`;
}

/** Resolves live probe env toggles, defaulting to enabled when unset. */
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

/** Returns whether model metadata advertises image input support. */
export function modelSupportsImageInput(model: Pick<Model, "input">): boolean {
  return model.input.includes("image");
}

/** Returns whether extra probes should skip known empty-response models. */
export function shouldSkipLiveModelExtraProbes(model: Pick<Model, "id" | "provider">): boolean {
  return KNOWN_EMPTY_EXTRA_PROBE_MODELS.has(modelKey(model));
}

/** Returns whether file-label probes should skip known empty-response models. */
export function shouldSkipLiveModelFileProbe(model: Pick<Model, "id" | "provider">): boolean {
  if (model.provider === "opencode-go") {
    return true;
  }
  return KNOWN_EMPTY_FILE_PROBE_MODELS.has(modelKey(model));
}

/** Returns whether image probes should skip known empty-response models. */
export function shouldSkipLiveModelImageProbe(model: Pick<Model, "id" | "provider">): boolean {
  return KNOWN_EMPTY_IMAGE_PROBE_MODELS.has(modelKey(model));
}

/** Builds the primary file-label probe context. */
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

/** Builds the fallback file-label prompt when the primary file probe is ambiguous. */
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

/** Builds the image probe context with a tiny stable PNG fixture. */
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

/** Returns whether file probe output contains the expected token. */
export function fileProbeTextMatches(text: string): boolean {
  return text.toLowerCase().includes(LIVE_MODEL_FILE_PROBE_TOKEN.toLowerCase());
}

/** Returns whether image probe output contains an OK acknowledgement. */
export function imageProbeTextMatches(text: string): boolean {
  return /\bok\b/i.test(text);
}

function formatImageProbeText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "<empty>";
  }
  return `<non-matching response: ${normalized.length} chars>`;
}

/** Retries one ambiguous image reply without weakening the strict OK matcher. */
export async function runLiveModelImageProbeWithRetry(params: {
  run: (attempt: 1 | 2) => Promise<string>;
  onRetry: (firstText: string) => void;
}): Promise<string> {
  const firstText = await params.run(1);
  if (imageProbeTextMatches(firstText)) {
    return firstText;
  }

  params.onRetry(firstText);
  const retryText = await params.run(2);
  if (imageProbeTextMatches(retryText)) {
    return retryText;
  }

  throw new Error(
    "image probe did not return ok after retry " +
      `(attempt 1: ${formatImageProbeText(firstText)}; ` +
      `attempt 2: ${formatImageProbeText(retryText)})`,
  );
}

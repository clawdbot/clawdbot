// TTS core coordinates text preparation, provider selection, and speech output.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { requireApiKey } from "../agents/model-auth.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
  type ModelRef,
} from "../agents/model-selection.js";
import { prepareSimpleCompletionModel } from "../agents/simple-completion-runtime.js";
import type { OpenClawConfig } from "../config/types.js";
import { completeSimple } from "../llm/stream.js";
import type { TextContent } from "../llm/types.js";
import { resolveTimerTimeoutMs } from "../shared/number-coercion.js";
import type { ResolvedTtsConfig } from "./tts-types.js";
export {
  normalizeApplyTextNormalization,
  normalizeLanguageCode,
  normalizeSeed,
  requireInRange,
  resolveSpeechProviderApiKey,
  scheduleCleanup,
} from "./tts-provider-helpers.js";

type SummarizeTextDeps = {
  completeSimple: typeof completeSimple;
  prepareSimpleCompletionModel: typeof prepareSimpleCompletionModel;
  requireApiKey: typeof requireApiKey;
};

function resolveDefaultSummarizeTextDeps(): SummarizeTextDeps {
  return {
    completeSimple,
    prepareSimpleCompletionModel,
    requireApiKey,
  };
}

type SummarizeResult = {
  summary: string;
  latencyMs: number;
  inputLength: number;
  outputLength: number;
};

type SummaryModelSelection = {
  ref: ModelRef;
  source: "summaryModel" | "default";
};

function resolveSummaryModelRef(
  cfg: OpenClawConfig,
  config: ResolvedTtsConfig,
): SummaryModelSelection {
  const defaultRef = resolveDefaultModelForAgent({ cfg });
  const override = normalizeOptionalString(config.summaryModel);
  if (!override) {
    return { ref: defaultRef, source: "default" };
  }

  const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: defaultRef.provider });
  const resolved = resolveModelRefFromString({
    raw: override,
    defaultProvider: defaultRef.provider,
    aliasIndex,
  });
  if (!resolved) {
    return { ref: defaultRef, source: "default" };
  }
  return { ref: resolved.ref, source: "summaryModel" };
}

function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === "text";
}

/** Summarize long text before synthesis using the configured summary model. */
export async function summarizeText(
  params: {
    text: string;
    targetLength: number;
    cfg: OpenClawConfig;
    config: ResolvedTtsConfig;
    timeoutMs: number;
  },
  deps: SummarizeTextDeps = resolveDefaultSummarizeTextDeps(),
): Promise<SummarizeResult> {
  const { text, targetLength, cfg, config, timeoutMs } = params;
  if (targetLength < 100 || targetLength > 10_000) {
    throw new Error(`Invalid targetLength: ${targetLength}`);
  }

  const startTime = Date.now();
  const { ref } = resolveSummaryModelRef(cfg, config);
  // Dynamic model discovery precedes the request timeout, matching the established
  // summarization contract. The timeout below bounds only the completion request.
  const prepared = await deps.prepareSimpleCompletionModel({
    cfg,
    provider: ref.provider,
    modelId: ref.model,
    useAsyncModelResolution: true,
  });
  if ("error" in prepared) {
    throw new Error(prepared.error);
  }
  const completionModel = prepared.model;
  const apiKey = deps.requireApiKey(prepared.auth, ref.provider);

  try {
    const controller = new AbortController();
    const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 1);
    const timeout = setTimeout(() => controller.abort(), resolvedTimeoutMs);

    try {
      // Keep summarization on the simple-completion path so provider auth,
      // aliases, and timeout behavior match other lightweight model calls.
      const res = await deps.completeSimple(
        completionModel,
        {
          messages: [
            {
              role: "user",
              content:
                `You are an assistant that summarizes texts concisely while keeping the most important information. ` +
                `Summarize the text to approximately ${targetLength} characters. Maintain the original tone and style. ` +
                `Reply only with the summary, without additional explanations.\n\n` +
                `<text_to_summarize>\n${text}\n</text_to_summarize>`,
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey,
          maxTokens: Math.ceil(targetLength / 2),
          temperature: 0.3,
          signal: controller.signal,
        },
      );
      const summary = res.content
        .filter(isTextContentBlock)
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join(" ")
        .trim();

      if (!summary) {
        throw new Error("No summary returned");
      }

      return {
        summary,
        latencyMs: Date.now() - startTime,
        inputLength: text.length,
        outputLength: summary.length,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const error = err as Error;
    if (error.name === "AbortError") {
      throw new Error("Summarization timed out", { cause: err });
    }
    throw err;
  }
}

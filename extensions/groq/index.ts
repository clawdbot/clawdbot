import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  streamSimple,
  type AssistantMessageEvent,
} from "openclaw/plugin-sdk/llm";
// Groq plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { groqMediaUnderstandingProvider } from "./media-understanding-provider.js";

const GROQ_DEFAULT_MODEL_REF = "groq/llama-3.3-70b-versatile";
const GROQ_DEFAULT_MODEL_ID = "llama-3.3-70b-versatile";
const GROQ_FALLBACK_MAX_TOKENS = 1_024;

function hasWireMaxTokens(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.max_completion_tokens !== undefined || record.max_tokens !== undefined;
}

function hasExplicitMaxTokens(extraParams: Record<string, unknown> | undefined): boolean {
  return (
    extraParams?.maxTokens !== undefined ||
    hasWireMaxTokens(extraParams) ||
    hasWireMaxTokens(extraParams?.extra_body) ||
    hasWireMaxTokens(extraParams?.extraBody)
  );
}

function isGroqTpmRequestTooLargeEvent(event: AssistantMessageEvent): boolean {
  if (event.type !== "error") {
    return false;
  }
  const message = event.error.errorMessage?.toLowerCase() ?? "";
  return (
    message.includes("413 request too large for model") &&
    message.includes("tokens per minute (tpm)") &&
    message.includes("limit ") &&
    message.includes("requested ")
  );
}

function wrapGroqOversizedRequestRecovery(
  streamFn: StreamFn | undefined,
  enabled: boolean,
): StreamFn {
  const underlying = streamFn ?? streamSimple;
  if (!enabled) {
    return underlying;
  }
  const withoutTools: StreamFn = (model, context, options) => {
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      async onPayload(payload, payloadModel) {
        // Run configured payload hooks first so they cannot restore the tools or
        // output budget that caused this recovery request's TPM rejection.
        const replacement = await originalOnPayload?.(payload, payloadModel);
        const finalPayload = replacement && typeof replacement === "object" ? replacement : payload;
        const record = finalPayload as Record<string, unknown>;
        delete record.tools;
        delete record.tool_choice;
        delete record.parallel_tool_calls;
        delete record.parallelToolCalls;
        delete record.max_tokens;
        delete record.max_completion_tokens;
        record.max_completion_tokens = GROQ_FALLBACK_MAX_TOKENS;
        return finalPayload;
      },
    });
  };
  return (model, context, options) => {
    // Request-scoped params wrap provider hooks from the outside, so check the
    // final stream options here to preserve explicit per-call output budgets.
    if (options?.maxTokens !== undefined) {
      return underlying(model, context, options);
    }
    // Invoke before constructing the proxy stream so synchronous provider failures
    // retain the caller-visible throw semantics of the underlying transport.
    const initial = underlying(model, context, options);
    const output = createAssistantMessageEventStream();
    const writable = output as unknown as { push(event: unknown): void; end(): void };

    void (async () => {
      try {
        const resolvedInitial = await Promise.resolve(initial);
        let forwarded = false;
        let retryWithoutTools = false;
        for await (const event of resolvedInitial) {
          if (!forwarded && !options?.signal?.aborted && isGroqTpmRequestTooLargeEvent(event)) {
            retryWithoutTools = true;
            break;
          }
          writable.push(event);
          forwarded = true;
        }
        if (retryWithoutTools) {
          const fallback = await Promise.resolve(withoutTools(model, context, options));
          for await (const event of fallback) {
            writable.push(event);
          }
        }
      } catch (error) {
        writable.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "error",
            errorMessage: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          },
        });
      } finally {
        writable.end();
      }
    })();

    return output;
  };
}

export default definePluginEntry({
  id: "groq",
  name: "Groq Provider",
  description: "Bundled Groq provider plugin",
  register(api) {
    api.registerProvider({
      id: "groq",
      label: "Groq",
      docsPath: "/providers/groq",
      envVars: ["GROQ_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: "groq",
          methodId: "api-key",
          label: "Groq API key",
          hint: "Fast OpenAI-compatible inference",
          optionKey: "groqApiKey",
          flagName: "--groq-api-key",
          envVar: "GROQ_API_KEY",
          promptMessage: "Enter Groq API key",
          defaultModel: GROQ_DEFAULT_MODEL_REF,
          wizard: {
            choiceId: "groq-api-key",
            choiceLabel: "Groq API key",
            choiceHint: "Fast OpenAI-compatible inference",
            groupId: "groq",
            groupLabel: "Groq",
            groupHint: "Fast OpenAI-compatible inference",
          },
        }),
      ],
      wrapStreamFn: (ctx) =>
        wrapGroqOversizedRequestRecovery(
          ctx.streamFn,
          // Older compatible hosts omit this provenance. Only a known discovered default
          // is safe to replace; an unknown value could be a user-configured cap.
          ctx.modelId === GROQ_DEFAULT_MODEL_ID &&
            !hasExplicitMaxTokens(ctx.extraParams) &&
            !hasExplicitMaxTokens(ctx.model?.params) &&
            ctx.model?.maxTokensSource === "discovered",
        ),
    });
    api.registerMediaUnderstandingProvider(groqMediaUnderstandingProvider);
  },
});

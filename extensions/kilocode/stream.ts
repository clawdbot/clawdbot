// Kilocode plugin module implements stream behavior.
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { resolveProviderRequestHeaders } from "openclaw/plugin-sdk/provider-http";
import { normalizeOpenAICompatibleReasoningPayload } from "openclaw/plugin-sdk/provider-stream-shared";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";

const KILOCODE_FEATURE_HEADER = "X-KILOCODE-FEATURE";
const KILOCODE_FEATURE_DEFAULT = "openclaw";
const KILOCODE_FEATURE_ENV_VAR = "KILOCODE_FEATURE";

type ThinkLevel = NonNullable<ProviderWrapStreamFnContext["thinkingLevel"]>;
type ProviderStreamFn = NonNullable<ProviderWrapStreamFnContext["streamFn"]>;

function resolveKilocodeAppHeaders(): Record<string, string> {
  const feature = process.env[KILOCODE_FEATURE_ENV_VAR]?.trim() || KILOCODE_FEATURE_DEFAULT;
  return { [KILOCODE_FEATURE_HEADER]: feature };
}

function normalizeKilocodeStopPayload(payloadObj: Record<string, unknown>): void {
  if (typeof payloadObj.stop === "string") {
    payloadObj.stop = [payloadObj.stop];
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeKilocodeStopAfterCaller(
  value: unknown,
  fallbackPayload: Record<string, unknown> | undefined,
): unknown {
  const replacementPayload = asRecord(value);
  if (replacementPayload) {
    normalizeKilocodeStopPayload(replacementPayload);
    return value;
  }
  if (fallbackPayload) {
    normalizeKilocodeStopPayload(fallbackPayload);
  }
  return value;
}

function isProxyReasoningUnsupported(modelId: string): boolean {
  const trimmed = normalizeOptionalLowercaseString(modelId);
  const slashIndex = trimmed?.indexOf("/") ?? -1;
  return slashIndex > 0 && trimmed?.slice(0, slashIndex) === "x-ai";
}

function resolveKilocodeThinkingLevel(ctx: ProviderWrapStreamFnContext): ThinkLevel | undefined {
  if (ctx.modelId === "kilo-auto/balanced" || isProxyReasoningUnsupported(ctx.modelId)) {
    return undefined;
  }
  return ctx.thinkingLevel;
}

function createKilocodeStreamWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel?: ThinkLevel,
): ProviderWrapStreamFnContext["streamFn"] {
  if (!baseStreamFn) {
    return undefined;
  }
  const underlying = baseStreamFn;
  return (model, context, options) => {
    const originalOnPayload = options?.onPayload;
    const headers = resolveProviderRequestHeaders({
      provider: typeof model.provider === "string" ? model.provider : "kilocode",
      api: model.api,
      baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
      capability: "llm",
      transport: "stream",
      callerHeaders: options?.headers,
      defaultHeaders: resolveKilocodeAppHeaders(),
      precedence: "defaults-win",
    });
    return underlying(model, context, {
      ...options,
      headers,
      onPayload(payload, payloadModel) {
        const payloadObj = asRecord(payload);
        if (payloadObj) {
          // Keep Kilo thinking defaults overrideable by later caller/config payload hooks.
          normalizeOpenAICompatibleReasoningPayload(payloadObj, thinkingLevel);
        }

        const result = originalOnPayload?.(payload, payloadModel);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          return Promise.resolve(result).then((resolved) =>
            normalizeKilocodeStopAfterCaller(resolved, payloadObj),
          );
        }
        return normalizeKilocodeStopAfterCaller(result, payloadObj);
      },
    });
  };
}

export function wrapKilocodeProviderStream(
  ctx: ProviderWrapStreamFnContext,
): ProviderStreamFn | undefined {
  if (normalizeOptionalLowercaseString(ctx.provider) !== "kilocode") {
    return undefined;
  }
  return createKilocodeStreamWrapper(ctx.streamFn, resolveKilocodeThinkingLevel(ctx));
}

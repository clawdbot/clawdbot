import type { Api, Context, Model } from "@openclaw/llm-core";
import {
  getAiTransportHost,
  type AiBeforeFetchDispatch,
  type AiModelFetchOptions,
  type AiModelFetchResult,
  type AiProviderRequestPolicyInput,
} from "../host.js";

function normalizeLegacyModelFetch(result: unknown): { fetch: typeof fetch } | undefined {
  return typeof result === "function" ? { fetch: result as typeof fetch } : undefined;
}

function normalizeAttestedModelFetch(result: typeof fetch | AiModelFetchResult | undefined):
  | {
      fetch: typeof fetch;
      physicalDispatchAttested: true;
      provenance: "dispatch_attested";
    }
  | undefined {
  if (
    !result ||
    typeof result === "function" ||
    typeof result.fetch !== "function" ||
    result.provenance !== "dispatch_attested"
  ) {
    return undefined;
  }
  return {
    fetch: result.fetch,
    physicalDispatchAttested: true,
    provenance: result.provenance,
  };
}

type GuardedModelFetchResult = {
  fetch: typeof fetch;
  physicalDispatchAttested?: boolean;
  provenance?: AiModelFetchResult["provenance"];
};

export function snapshotProviderEndpointResolver(): (baseUrl?: string) => {
  endpointClass: string;
} {
  const host = getAiTransportHost();
  return (baseUrl) => ({ endpointClass: host.resolveProviderEndpointClass(baseUrl) });
}

class AiTransportDispatchGuardUnavailableError extends Error {
  constructor() {
    super("blocking model fetch dispatch guard is unavailable");
    this.name = "AiTransportDispatchGuardUnavailableError";
  }
}

class AiTransportDispatchAttestationInvalidError extends Error {
  constructor() {
    super("attested model fetch returned an invalid dispatch contract");
    this.name = "AiTransportDispatchAttestationInvalidError";
  }
}

export function buildGuardedModelFetchResult(
  model: Model,
  timeoutMs?: number,
  options?: AiModelFetchOptions & {
    beforeFetchDispatch?: AiBeforeFetchDispatch;
  },
): GuardedModelFetchResult {
  const host = getAiTransportHost();
  if (options?.beforeFetchDispatch) {
    const blockingBuilder = host.buildModelFetchWithBlockingDispatchGuard;
    const result = normalizeAttestedModelFetch(
      typeof blockingBuilder === "function"
        ? blockingBuilder(model, timeoutMs, {
            ...options,
            beforeFetchDispatch: options.beforeFetchDispatch,
          })
        : undefined,
    );
    if (!result) {
      throw new AiTransportDispatchGuardUnavailableError();
    }
    return result;
  }
  if (options !== undefined) {
    const attestedBuilder = host.buildModelFetchWithDispatchAttestation;
    const attestedResult =
      typeof attestedBuilder === "function"
        ? attestedBuilder(model, timeoutMs, options)
        : undefined;
    const result = normalizeAttestedModelFetch(attestedResult);
    if (attestedResult !== undefined && !result) {
      throw new AiTransportDispatchAttestationInvalidError();
    }
    const legacyResult =
      result ?? normalizeLegacyModelFetch(host.buildModelFetch(model, timeoutMs, options));
    if (legacyResult) {
      return legacyResult;
    }
    if (options.onFetchDispatch) {
      return {
        fetch: async (input, init) => {
          const dispatched = globalThis.fetch(input, init);
          try {
            options.onFetchDispatch?.();
          } catch {
            // Accounting is observational and must never alter provider behavior.
          }
          return await dispatched;
        },
        physicalDispatchAttested: false,
      };
    }
    return { fetch: globalThis.fetch };
  }
  if (timeoutMs !== undefined) {
    return (
      normalizeLegacyModelFetch(host.buildModelFetch(model, timeoutMs)) ?? {
        fetch: globalThis.fetch,
      }
    );
  }
  return normalizeLegacyModelFetch(host.buildModelFetch(model)) ?? { fetch: globalThis.fetch };
}

export function buildGuardedModelFetch(
  model: Model,
  timeoutMs?: number,
  options?: AiModelFetchOptions & {
    beforeFetchDispatch?: AiBeforeFetchDispatch;
  },
): typeof fetch {
  return buildGuardedModelFetchResult(model, timeoutMs, options).fetch;
}

export function resolveProviderEndpoint(baseUrl?: string): { endpointClass: string } {
  return { endpointClass: getAiTransportHost().resolveProviderEndpointClass(baseUrl) };
}

export function resolveProviderRequestCapabilities(input: AiProviderRequestPolicyInput) {
  return getAiTransportHost().resolveProviderRequestCapabilities(input);
}

export function resolveProviderRequestPolicyConfig(input: {
  provider?: string;
  api?: string;
  baseUrl?: string;
  capability?: string;
  transport?: string;
  providerHeaders?: Record<string, string>;
  callerHeaders?: Record<string, string>;
  precedence?: "caller-wins" | "defaults-win";
}): { headers?: Record<string, string> } {
  return { headers: getAiTransportHost().resolveProviderRequestHeaders(input) };
}

export function resolveModelRequestTimeoutMs(model: Model, timeoutMs?: number): number | undefined {
  return timeoutMs ?? getAiTransportHost().resolveModelRequestTimeoutMs(model);
}

export function resolveOpenAIStrictToolSetting(
  model: Pick<Model, "provider" | "api" | "baseUrl" | "id"> & { compat?: unknown },
  options?: { transport?: "stream" | "websocket"; supportsStrictMode?: boolean },
): boolean | undefined {
  return getAiTransportHost().resolveOpenAIStrictToolSetting(model, options);
}

export function transformTransportMessages(
  messages: Context["messages"],
  model: Model,
  normalizeToolCallId?: (
    id: string,
    targetModel: Model,
    source: { provider: string; api: Api; model: string },
  ) => string,
  options?: {
    normalizeSameModelToolCallIds?: boolean;
    preserveCrossModelToolCallThoughtSignature?: boolean;
  },
): Context["messages"] {
  return getAiTransportHost().transformTransportMessages(
    messages,
    model,
    normalizeToolCallId,
    options,
  );
}

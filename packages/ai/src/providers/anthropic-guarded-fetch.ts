import type { Model } from "@openclaw/llm-core";
import { getAiTransportHost } from "../host.js";
import {
  buildGuardedModelFetchResult,
  snapshotProviderEndpointResolver,
} from "../transports/host-policy.js";
import { createFetchInvocationCompatibilityObservers } from "../transports/model-transport-accounting-internal.js";
import { isCanonicalAnthropicPublicUrl } from "./anthropic-server-fallback.js";
import {
  createAnthropicEndpointAuthority,
  type AnthropicEndpointAuthoritySnapshot,
} from "./anthropic-stream-terminal.js";
import type { AnthropicTransportAccounting } from "./anthropic-transport-accounting.js";

export function canGuardAnthropicServerFallbackDispatch(): boolean {
  return typeof getAiTransportHost().buildModelFetchWithBlockingDispatchGuard === "function";
}

export function buildAnthropicGuardedFetch(params: {
  model: Model<"anthropic-messages">;
  sanitizeSse?: boolean;
  serverSideFallback: boolean;
  transportAccounting?: Pick<AnthropicTransportAccounting, "onFetchDispatch" | "wrapFetch">;
}): {
  fetch: typeof globalThis.fetch;
  getEndpointAuthority: () => AnthropicEndpointAuthoritySnapshot;
} {
  const resolveProviderEndpoint = snapshotProviderEndpointResolver();
  const endpointAuthority = createAnthropicEndpointAuthority({
    provider: params.model.provider,
    resolveEndpointClass: (url) => resolveProviderEndpoint(url).endpointClass,
  });
  endpointAuthority.observeProvisional(params.model.baseUrl);
  let fetchAuthorityResolved = false;
  let invocationEndpointAttested = false;
  const pendingInvocationUrls: string[] = [];
  const invocationObservers = params.transportAccounting
    ? createFetchInvocationCompatibilityObservers(params.transportAccounting.onFetchDispatch)
    : undefined;
  const guardedFetch = buildGuardedModelFetchResult(params.model, undefined, {
    ...(params.sanitizeSse === undefined ? {} : { sanitizeSse: params.sanitizeSse }),
    ...invocationObservers,
    observeFetchDispatch: ({ url }) => {
      if (!fetchAuthorityResolved) {
        pendingInvocationUrls.push(url);
        return;
      }
      endpointAuthority.observeEndpointInvocation(url, {
        attested: invocationEndpointAttested,
      });
    },
    ...(params.serverSideFallback
      ? {
          beforeFetchDispatch: ({ url }: { url: string }) => {
            if (!isCanonicalAnthropicPublicUrl(url)) {
              throw new Error(
                "Anthropic server fallback cannot redirect outside Anthropic public authority",
              );
            }
          },
        }
      : {}),
  });
  invocationEndpointAttested = guardedFetch.invocationEndpointAttested === true;
  fetchAuthorityResolved = true;
  for (const url of pendingInvocationUrls) {
    endpointAuthority.observeEndpointInvocation(url, {
      attested: invocationEndpointAttested,
    });
  }
  return {
    fetch:
      params.transportAccounting?.wrapFetch(guardedFetch.fetch, guardedFetch.provenance) ??
      guardedFetch.fetch,
    getEndpointAuthority: () => endpointAuthority.snapshot(),
  };
}

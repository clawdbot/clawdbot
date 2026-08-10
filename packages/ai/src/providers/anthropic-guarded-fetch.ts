import type { Model } from "@openclaw/llm-core";
import { getAiTransportHost } from "../host.js";
import {
  buildGuardedModelFetchResult,
  snapshotProviderEndpointResolver,
} from "../transports/host-policy.js";
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
  let physicalDispatchAttested = false;
  const pendingDispatchUrls: string[] = [];
  const guardedFetch = buildGuardedModelFetchResult(params.model, undefined, {
    ...(params.sanitizeSse === undefined ? {} : { sanitizeSse: params.sanitizeSse }),
    ...(params.transportAccounting
      ? { onFetchDispatch: params.transportAccounting.onFetchDispatch }
      : {}),
    observeFetchDispatch: ({ url }) => {
      if (!fetchAuthorityResolved) {
        pendingDispatchUrls.push(url);
        return;
      }
      endpointAuthority.observePhysicalDispatch(url, {
        attested: physicalDispatchAttested,
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
  physicalDispatchAttested = guardedFetch.physicalDispatchAttested === true;
  fetchAuthorityResolved = true;
  for (const url of pendingDispatchUrls) {
    endpointAuthority.observePhysicalDispatch(url, {
      attested: physicalDispatchAttested,
    });
  }
  return {
    fetch:
      params.transportAccounting?.wrapFetch(guardedFetch.fetch, guardedFetch.provenance) ??
      guardedFetch.fetch,
    getEndpointAuthority: () => endpointAuthority.snapshot(),
  };
}

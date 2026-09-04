import { normalizeRouteBasePath } from "@openclaw/uirouter";
import type { AssistantMediaGetResult } from "../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";

const ASSISTANT_MEDIA_RESOLVE_TIMEOUT_MS = 30_000;

export function buildAssistantMediaUrl(
  source: string,
  resourceBasePath = "",
  mediaTicket?: string | null,
): string {
  const params = new URLSearchParams({ source });
  const normalizedMediaTicket = mediaTicket?.trim();
  if (normalizedMediaTicket) {
    params.set("mediaTicket", normalizedMediaTicket);
  }
  return `${normalizeRouteBasePath(resourceBasePath)}/__openclaw__/assistant-media?${params.toString()}`;
}

/** Mint local-media access for a visible transcript through its authenticated Gateway connection. */
export async function resolveAssistantMedia(
  client: GatewayBrowserClient,
  source: string,
  sessionKey: string,
): Promise<AssistantMediaGetResult> {
  return await client.request<AssistantMediaGetResult>(
    "assistant.media.get",
    { source, sessionKey },
    { timeoutMs: ASSISTANT_MEDIA_RESOLVE_TIMEOUT_MS },
  );
}

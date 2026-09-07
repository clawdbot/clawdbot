import { createOneTimeTicketStore } from "openclaw/plugin-sdk/websocket-runtime";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";

export type BrowserScreencastTokenParams = {
  profileName: string;
  targetId: string;
  cdpUrl: string;
  ssrfPolicy?: SsrFPolicy;
  maxWidth: number;
  maxHeight: number;
  quality: number;
  lifecycleGeneration: number;
  lifecycleSignal: AbortSignal;
  requesterSignal?: AbortSignal;
  isRequesterCurrent?: () => boolean;
  assertCurrent: () => void;
  checkNavigationAllowed: (url: string) => Promise<void>;
};

const tokens = createOneTimeTicketStore<BrowserScreencastTokenParams>({ ttlMs: 60_000 });

export function mintBrowserScreencastToken(params: BrowserScreencastTokenParams): {
  token: string;
  expiresAtMs: number;
} {
  return tokens.mint(params, { revokeSignal: params.requesterSignal });
}

export function consumeBrowserScreencastToken(
  token: string,
): BrowserScreencastTokenParams | undefined {
  const params = token === token.trim() ? tokens.consume(token) : undefined;
  return params && !params.requesterSignal?.aborted && params.isRequesterCurrent?.() !== false
    ? params
    : undefined;
}

export function clearBrowserScreencastTokens(): void {
  tokens.clear();
}

import crypto from "node:crypto";
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
  assertCurrent: () => void;
  checkNavigationAllowed: (url: string) => Promise<void>;
};

type TokenEntry = {
  params: BrowserScreencastTokenParams;
  expiresAtMs: number;
  expiryTimer: ReturnType<typeof setTimeout>;
  onRequesterGone: () => void;
};

const TOKEN_TTL_MS = 60_000;
const tokens = new Map<string, TokenEntry>();

function deleteToken(token: string): void {
  const entry = tokens.get(token);
  if (!entry) {
    return;
  }
  clearTimeout(entry.expiryTimer);
  entry.params.requesterSignal?.removeEventListener("abort", entry.onRequesterGone);
  tokens.delete(token);
}

export function mintBrowserScreencastToken(params: BrowserScreencastTokenParams): {
  token: string;
  expiresAtMs: number;
} {
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAtMs = Date.now() + TOKEN_TTL_MS;
  const expiryTimer = setTimeout(() => deleteToken(token), TOKEN_TTL_MS);
  expiryTimer.unref();
  const onRequesterGone = () => deleteToken(token);
  tokens.set(token, { params, expiresAtMs, expiryTimer, onRequesterGone });
  params.requesterSignal?.addEventListener("abort", onRequesterGone, { once: true });
  if (params.requesterSignal?.aborted) {
    deleteToken(token);
  }
  return { token, expiresAtMs };
}

export function consumeBrowserScreencastToken(
  token: string,
): BrowserScreencastTokenParams | undefined {
  if (!/^[a-f0-9]{48}$/u.test(token)) {
    return undefined;
  }
  const entry = tokens.get(token);
  deleteToken(token);
  return entry && entry.expiresAtMs > Date.now() ? entry.params : undefined;
}

export function clearBrowserScreencastTokens(): void {
  for (const token of tokens.keys()) {
    deleteToken(token);
  }
}

import { resolveBlueBubblesAccount } from "./accounts.js";
import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import { blueBubblesFetchWithTimeout, buildBlueBubblesApiUrl } from "./types.js";

export type BlueBubblesChatOpts = {
  serverUrl?: string;
  password?: string;
  accountId?: string;
  timeoutMs?: number;
  cfg?: ClawdbotConfig;
};

function resolveAccount(params: BlueBubblesChatOpts) {
  const account = resolveBlueBubblesAccount({
    cfg: params.cfg ?? {},
    accountId: params.accountId,
  });
  const baseUrl = params.serverUrl?.trim() || account.config.serverUrl?.trim();
  const password = params.password?.trim() || account.config.password?.trim();
  if (!baseUrl) throw new Error("BlueBubbles serverUrl is required");
  if (!password) throw new Error("BlueBubbles password is required");
  return { baseUrl, password };
}

export async function markBlueBubblesChatRead(
  chatGuid: string,
  opts: BlueBubblesChatOpts = {},
): Promise<void> {
  const trimmed = chatGuid.trim();
  if (!trimmed) return;
  const { baseUrl, password } = resolveAccount(opts);
  const url = buildBlueBubblesApiUrl({
    baseUrl,
    path: `/api/v1/chat/${encodeURIComponent(trimmed)}/read`,
    password,
  });
  const res = await blueBubblesFetchWithTimeout(url, { method: "POST" }, opts.timeoutMs);
  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`BlueBubbles read failed (${res.status}): ${errorText || "unknown"}`);
  }
}

export async function sendBlueBubblesTyping(
  chatGuid: string,
  typing: boolean,
  opts: BlueBubblesChatOpts = {},
): Promise<void> {
  const trimmed = chatGuid.trim();
  if (!trimmed) return;
  const { baseUrl, password } = resolveAccount(opts);
  const url = buildBlueBubblesApiUrl({
    baseUrl,
    path: `/api/v1/chat/${encodeURIComponent(trimmed)}/typing`,
    password,
  });
  const res = await blueBubblesFetchWithTimeout(
    url,
    { method: typing ? "POST" : "DELETE" },
    opts.timeoutMs,
  );
  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`BlueBubbles typing failed (${res.status}): ${errorText || "unknown"}`);
  }
}

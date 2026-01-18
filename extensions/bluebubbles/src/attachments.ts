import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import { resolveBlueBubblesAccount } from "./accounts.js";
import {
  blueBubblesFetchWithTimeout,
  buildBlueBubblesApiUrl,
  type BlueBubblesAttachment,
} from "./types.js";

export type BlueBubblesAttachmentOpts = {
  serverUrl?: string;
  password?: string;
  accountId?: string;
  timeoutMs?: number;
  cfg?: ClawdbotConfig;
};

const DEFAULT_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

function resolveAccount(params: BlueBubblesAttachmentOpts) {
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

export async function downloadBlueBubblesAttachment(
  attachment: BlueBubblesAttachment,
  opts: BlueBubblesAttachmentOpts & { maxBytes?: number } = {},
): Promise<{ buffer: Uint8Array; contentType?: string }> {
  const guid = attachment.guid?.trim();
  if (!guid) throw new Error("BlueBubbles attachment guid is required");
  const { baseUrl, password } = resolveAccount(opts);
  const url = buildBlueBubblesApiUrl({
    baseUrl,
    path: `/api/v1/attachment/${encodeURIComponent(guid)}/download`,
    password,
  });
  const res = await blueBubblesFetchWithTimeout(url, { method: "GET" }, opts.timeoutMs);
  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(
      `BlueBubbles attachment download failed (${res.status}): ${errorText || "unknown"}`,
    );
  }
  const contentType = res.headers.get("content-type") ?? undefined;
  const buf = new Uint8Array(await res.arrayBuffer());
  const maxBytes = typeof opts.maxBytes === "number" ? opts.maxBytes : DEFAULT_ATTACHMENT_MAX_BYTES;
  if (buf.byteLength > maxBytes) {
    throw new Error(`BlueBubbles attachment too large (${buf.byteLength} bytes)`);
  }
  return { buffer: buf, contentType: contentType ?? attachment.mimeType ?? undefined };
}

import crypto from "node:crypto";
import { resolveBlueBubblesAccount } from "./accounts.js";
import type { MoltbotConfig } from "clawdbot/plugin-sdk";
import { blueBubblesFetchWithTimeout, buildBlueBubblesApiUrl } from "./types.js";

export type BlueBubblesChatOpts = {
  serverUrl?: string;
  password?: string;
  accountId?: string;
  timeoutMs?: number;
  cfg?: MoltbotConfig;
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

/**
 * Edit a message via BlueBubbles API.
 * Requires macOS 13 (Ventura) or higher with Private API enabled.
 */
export async function editBlueBubblesMessage(
  messageGuid: string,
  newText: string,
  opts: BlueBubblesChatOpts & { partIndex?: number; backwardsCompatMessage?: string } = {},
): Promise<void> {
  const trimmedGuid = messageGuid.trim();
  if (!trimmedGuid) throw new Error("BlueBubbles edit requires messageGuid");
  const trimmedText = newText.trim();
  if (!trimmedText) throw new Error("BlueBubbles edit requires newText");

  const { baseUrl, password } = resolveAccount(opts);
  const url = buildBlueBubblesApiUrl({
    baseUrl,
    path: `/api/v1/message/${encodeURIComponent(trimmedGuid)}/edit`,
    password,
  });

  const payload = {
    editedMessage: trimmedText,
    backwardsCompatibilityMessage: opts.backwardsCompatMessage ?? `Edited to: ${trimmedText}`,
    partIndex: typeof opts.partIndex === "number" ? opts.partIndex : 0,
  };

  const res = await blueBubblesFetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    opts.timeoutMs,
  );

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`BlueBubbles edit failed (${res.status}): ${errorText || "unknown"}`);
  }
}

/**
 * Unsend (retract) a message via BlueBubbles API.
 * Requires macOS 13 (Ventura) or higher with Private API enabled.
 */
export async function unsendBlueBubblesMessage(
  messageGuid: string,
  opts: BlueBubblesChatOpts & { partIndex?: number } = {},
): Promise<void> {
  const trimmedGuid = messageGuid.trim();
  if (!trimmedGuid) throw new Error("BlueBubbles unsend requires messageGuid");

  const { baseUrl, password } = resolveAccount(opts);
  const url = buildBlueBubblesApiUrl({
    baseUrl,
    path: `/api/v1/message/${encodeURIComponent(trimmedGuid)}/unsend`,
    password,
  });

  const payload = {
    partIndex: typeof opts.partIndex === "number" ? opts.partIndex : 0,
  };

  const res = await blueBubblesFetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    opts.timeoutMs,
  );

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`BlueBubbles unsend failed (${res.status}): ${errorText || "unknown"}`);
  }
}

/**
 * Rename a group chat via BlueBubbles API.
 */
export async function renameBlueBubblesChat(
  chatGuid: string,
  displayName: string,
  opts: BlueBubblesChatOpts = {},
): Promise<void> {
  const trimmedGuid = chatGuid.trim();
  if (!trimmedGuid) throw new Error("BlueBubbles rename requires chatGuid");

  const { baseUrl, password } = resolveAccount(opts);
  const url = buildBlueBubblesApiUrl({
    baseUrl,
    path: `/api/v1/chat/${encodeURIComponent(trimmedGuid)}`,
    password,
  });

  const res = await blueBubblesFetchWithTimeout(
    url,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName }),
    },
    opts.timeoutMs,
  );

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`BlueBubbles rename failed (${res.status}): ${errorText || "unknown"}`);
  }
}

/**
 * Add a participant to a group chat via BlueBubbles API.
 */
export async function addBlueBubblesParticipant(
  chatGuid: string,
  address: string,
  opts: BlueBubblesChatOpts = {},
): Promise<void> {
  const trimmedGuid = chatGuid.trim();
  if (!trimmedGuid) throw new Error("BlueBubbles addParticipant requires chatGuid");
  const trimmedAddress = address.trim();
  if (!trimmedAddress) throw new Error("BlueBubbles addParticipant requires address");

  const { baseUrl, password } = resolveAccount(opts);
  const url = buildBlueBubblesApiUrl({
    baseUrl,
    path: `/api/v1/chat/${encodeURIComponent(trimmedGuid)}/participant`,
    password,
  });

  const res = await blueBubblesFetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: trimmedAddress }),
    },
    opts.timeoutMs,
  );

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`BlueBubbles addParticipant failed (${res.status}): ${errorText || "unknown"}`);
  }
}

/**
 * Remove a participant from a group chat via BlueBubbles API.
 */
export async function removeBlueBubblesParticipant(
  chatGuid: string,
  address: string,
  opts: BlueBubblesChatOpts = {},
): Promise<void> {
  const trimmedGuid = chatGuid.trim();
  if (!trimmedGuid) throw new Error("BlueBubbles removeParticipant requires chatGuid");
  const trimmedAddress = address.trim();
  if (!trimmedAddress) throw new Error("BlueBubbles removeParticipant requires address");

  const { baseUrl, password } = resolveAccount(opts);
  const url = buildBlueBubblesApiUrl({
    baseUrl,
    path: `/api/v1/chat/${encodeURIComponent(trimmedGuid)}/participant`,
    password,
  });

  const res = await blueBubblesFetchWithTimeout(
    url,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: trimmedAddress }),
    },
    opts.timeoutMs,
  );

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`BlueBubbles removeParticipant failed (${res.status}): ${errorText || "unknown"}`);
  }
}

/**
 * Leave a group chat via BlueBubbles API.
 */
export async function leaveBlueBubblesChat(
  chatGuid: string,
  opts: BlueBubblesChatOpts = {},
): Promise<void> {
  const trimmedGuid = chatGuid.trim();
  if (!trimmedGuid) throw new Error("BlueBubbles leaveChat requires chatGuid");

  const { baseUrl, password } = resolveAccount(opts);
  const url = buildBlueBubblesApiUrl({
    baseUrl,
    path: `/api/v1/chat/${encodeURIComponent(trimmedGuid)}/leave`,
    password,
  });

  const res = await blueBubblesFetchWithTimeout(
    url,
    { method: "POST" },
    opts.timeoutMs,
  );

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`BlueBubbles leaveChat failed (${res.status}): ${errorText || "unknown"}`);
  }
}

/**
 * Set a group chat's icon/photo via BlueBubbles API.
 * Requires Private API to be enabled.
 */
export async function setGroupIconBlueBubbles(
  chatGuid: string,
  buffer: Uint8Array,
  filename: string,
  opts: BlueBubblesChatOpts & { contentType?: string } = {},
): Promise<void> {
  const trimmedGuid = chatGuid.trim();
  if (!trimmedGuid) throw new Error("BlueBubbles setGroupIcon requires chatGuid");
  if (!buffer || buffer.length === 0) {
    throw new Error("BlueBubbles setGroupIcon requires image buffer");
  }

  const { baseUrl, password } = resolveAccount(opts);
  const url = buildBlueBubblesApiUrl({
    baseUrl,
    path: `/api/v1/chat/${encodeURIComponent(trimmedGuid)}/icon`,
    password,
  });

  // Build multipart form-data
  const boundary = `----BlueBubblesFormBoundary${crypto.randomUUID().replace(/-/g, "")}`;
  const parts: Uint8Array[] = [];
  const encoder = new TextEncoder();

  // Add file field named "icon" as per API spec
  parts.push(encoder.encode(`--${boundary}\r\n`));
  parts.push(
    encoder.encode(
      `Content-Disposition: form-data; name="icon"; filename="${filename}"\r\n`,
    ),
  );
  parts.push(
    encoder.encode(`Content-Type: ${opts.contentType ?? "application/octet-stream"}\r\n\r\n`),
  );
  parts.push(buffer);
  parts.push(encoder.encode("\r\n"));

  // Close multipart body
  parts.push(encoder.encode(`--${boundary}--\r\n`));

  // Combine into single buffer
  const totalLength = parts.reduce((acc, part) => acc + part.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }

  const res = await blueBubblesFetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    },
    opts.timeoutMs ?? 60_000, // longer timeout for file uploads
  );

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`BlueBubbles setGroupIcon failed (${res.status}): ${errorText || "unknown"}`);
  }
}

import crypto from "node:crypto";
import path from "node:path";
import { createBlueBubblesClient, type BlueBubblesClient } from "./client.js";
import { assertMultipartActionOk } from "./multipart.js";
import { getCachedBlueBubblesPrivateApiStatus } from "./probe.js";
import type { OpenClawConfig } from "./runtime-api.js";

export type BlueBubblesChatOpts = {
  serverUrl?: string;
  password?: string;
  accountId?: string;
  timeoutMs?: number;
  cfg?: OpenClawConfig;
};

function clientFromOpts(params: BlueBubblesChatOpts): BlueBubblesClient {
  return createBlueBubblesClient(params);
}

function assertPrivateApiEnabled(accountId: string, feature: string): void {
  if (getCachedBlueBubblesPrivateApiStatus(accountId) === false) {
    throw new Error(
      `BlueBubbles ${feature} requires Private API, but it is disabled on the BlueBubbles server.`,
    );
  }
}

function resolvePartIndex(partIndex: number | undefined): number {
  return typeof partIndex === "number" ? partIndex : 0;
}

async function sendBlueBubblesChatEndpointRequest(params: {
  chatGuid: string;
  opts: BlueBubblesChatOpts;
  endpoint: "read" | "typing";
  method: "POST" | "DELETE";
  action: "read" | "typing";
}): Promise<void> {
  const trimmed = params.chatGuid.trim();
  if (!trimmed) {
    return;
  }
  const client = clientFromOpts(params.opts);
  if (getCachedBlueBubblesPrivateApiStatus(client.accountId) === false) {
    return;
  }
  const res = await client.request({
    method: params.method,
    path: `/api/v1/chat/${encodeURIComponent(trimmed)}/${params.endpoint}`,
    timeoutMs: params.opts.timeoutMs,
  });
  await assertMultipartActionOk(res, params.action);
}

async function sendPrivateApiJsonRequest(params: {
  opts: BlueBubblesChatOpts;
  feature: string;
  action: string;
  path: string;
  method: "POST" | "PUT" | "DELETE";
  payload?: unknown;
}): Promise<void> {
  const client = clientFromOpts(params.opts);
  assertPrivateApiEnabled(client.accountId, params.feature);
  const res = await client.request({
    method: params.method,
    path: params.path,
    body: params.payload,
    timeoutMs: params.opts.timeoutMs,
  });
  await assertMultipartActionOk(res, params.action);
}

export async function markBlueBubblesChatRead(
  chatGuid: string,
  opts: BlueBubblesChatOpts = {},
): Promise<void> {
  await sendBlueBubblesChatEndpointRequest({
    chatGuid,
    opts,
    endpoint: "read",
    method: "POST",
    action: "read",
  });
}

export async function sendBlueBubblesTyping(
  chatGuid: string,
  typing: boolean,
  opts: BlueBubblesChatOpts = {},
): Promise<void> {
  await sendBlueBubblesChatEndpointRequest({
    chatGuid,
    opts,
    endpoint: "typing",
    method: typing ? "POST" : "DELETE",
    action: "typing",
  });
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
  if (!trimmedGuid) {
    throw new Error("BlueBubbles edit requires messageGuid");
  }
  const trimmedText = newText.trim();
  if (!trimmedText) {
    throw new Error("BlueBubbles edit requires newText");
  }

  await sendPrivateApiJsonRequest({
    opts,
    feature: "edit",
    action: "edit",
    method: "POST",
    path: `/api/v1/message/${encodeURIComponent(trimmedGuid)}/edit`,
    payload: {
      editedMessage: trimmedText,
      backwardsCompatibilityMessage: opts.backwardsCompatMessage ?? `Edited to: ${trimmedText}`,
      partIndex: resolvePartIndex(opts.partIndex),
    },
  });
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
  if (!trimmedGuid) {
    throw new Error("BlueBubbles unsend requires messageGuid");
  }

  await sendPrivateApiJsonRequest({
    opts,
    feature: "unsend",
    action: "unsend",
    method: "POST",
    path: `/api/v1/message/${encodeURIComponent(trimmedGuid)}/unsend`,
    payload: { partIndex: resolvePartIndex(opts.partIndex) },
  });
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
  if (!trimmedGuid) {
    throw new Error("BlueBubbles rename requires chatGuid");
  }

  await sendPrivateApiJsonRequest({
    opts,
    feature: "renameGroup",
    action: "rename",
    method: "PUT",
    path: `/api/v1/chat/${encodeURIComponent(trimmedGuid)}`,
    payload: { displayName },
  });
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
  if (!trimmedGuid) {
    throw new Error("BlueBubbles addParticipant requires chatGuid");
  }
  const trimmedAddress = address.trim();
  if (!trimmedAddress) {
    throw new Error("BlueBubbles addParticipant requires address");
  }

  await sendPrivateApiJsonRequest({
    opts,
    feature: "addParticipant",
    action: "addParticipant",
    method: "POST",
    path: `/api/v1/chat/${encodeURIComponent(trimmedGuid)}/participant`,
    payload: { address: trimmedAddress },
  });
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
  if (!trimmedGuid) {
    throw new Error("BlueBubbles removeParticipant requires chatGuid");
  }
  const trimmedAddress = address.trim();
  if (!trimmedAddress) {
    throw new Error("BlueBubbles removeParticipant requires address");
  }

  await sendPrivateApiJsonRequest({
    opts,
    feature: "removeParticipant",
    action: "removeParticipant",
    method: "DELETE",
    path: `/api/v1/chat/${encodeURIComponent(trimmedGuid)}/participant`,
    payload: { address: trimmedAddress },
  });
}

/**
 * Leave a group chat via BlueBubbles API.
 */
export async function leaveBlueBubblesChat(
  chatGuid: string,
  opts: BlueBubblesChatOpts = {},
): Promise<void> {
  const trimmedGuid = chatGuid.trim();
  if (!trimmedGuid) {
    throw new Error("BlueBubbles leaveChat requires chatGuid");
  }

  await sendPrivateApiJsonRequest({
    opts,
    feature: "leaveGroup",
    action: "leaveChat",
    method: "POST",
    path: `/api/v1/chat/${encodeURIComponent(trimmedGuid)}/leave`,
  });
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
  if (!trimmedGuid) {
    throw new Error("BlueBubbles setGroupIcon requires chatGuid");
  }
  if (!buffer || buffer.length === 0) {
    throw new Error("BlueBubbles setGroupIcon requires image buffer");
  }

  const client = clientFromOpts(opts);
  assertPrivateApiEnabled(client.accountId, "setGroupIcon");

  // Build multipart form-data
  const boundary = `----BlueBubblesFormBoundary${crypto.randomUUID().replace(/-/g, "")}`;
  const parts: Uint8Array[] = [];
  const encoder = new TextEncoder();

  // Sanitize filename to prevent multipart header injection (CWE-93)
  const safeFilename = path.basename(filename).replace(/[\r\n"\\]/g, "_") || "icon.png";

  // Add file field named "icon" as per API spec
  parts.push(encoder.encode(`--${boundary}\r\n`));
  parts.push(
    encoder.encode(`Content-Disposition: form-data; name="icon"; filename="${safeFilename}"\r\n`),
  );
  parts.push(
    encoder.encode(`Content-Type: ${opts.contentType ?? "application/octet-stream"}\r\n\r\n`),
  );
  parts.push(buffer);
  parts.push(encoder.encode("\r\n"));

  // Close multipart body
  parts.push(encoder.encode(`--${boundary}--\r\n`));

  const res = await client.requestMultipart({
    path: `/api/v1/chat/${encodeURIComponent(trimmedGuid)}/icon`,
    boundary,
    parts,
    timeoutMs: opts.timeoutMs ?? 60_000, // longer timeout for file uploads
  });

  await assertMultipartActionOk(res, "setGroupIcon");
}

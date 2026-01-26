import { messagingApi } from "@line/bot-sdk";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { resolveLineAccount } from "./accounts.js";

type RichMenuRequest = messagingApi.RichMenuRequest;
type RichMenuResponse = messagingApi.RichMenuResponse;
type RichMenuArea = messagingApi.RichMenuArea;
type Action = messagingApi.Action;

export interface RichMenuSize {
  width: 2500;
  height: 1686 | 843;
}

export interface RichMenuAreaRequest {
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  action: Action;
}

export interface CreateRichMenuParams {
  size: RichMenuSize;
  selected?: boolean;
  name: string;
  chatBarText: string;
  areas: RichMenuAreaRequest[];
}

interface RichMenuOpts {
  channelAccessToken?: string;
  accountId?: string;
  verbose?: boolean;
}

function resolveToken(
  explicit: string | undefined,
  params: { accountId: string; channelAccessToken: string },
): string {
  if (explicit?.trim()) return explicit.trim();
  if (!params.channelAccessToken) {
    throw new Error(
      `LINE channel access token missing for account "${params.accountId}" (set channels.line.channelAccessToken or LINE_CHANNEL_ACCESS_TOKEN).`,
    );
  }
  return params.channelAccessToken.trim();
}

function getClient(opts: RichMenuOpts = {}): messagingApi.MessagingApiClient {
  const cfg = loadConfig();
  const account = resolveLineAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.channelAccessToken, account);

  return new messagingApi.MessagingApiClient({
    channelAccessToken: token,
  });
}

function getBlobClient(opts: RichMenuOpts = {}): messagingApi.MessagingApiBlobClient {
  const cfg = loadConfig();
  const account = resolveLineAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.channelAccessToken, account);

  return new messagingApi.MessagingApiBlobClient({
    channelAccessToken: token,
  });
}

/**
 * Create a new rich menu
 * @returns The rich menu ID
 */
export async function createRichMenu(
  menu: CreateRichMenuParams,
  opts: RichMenuOpts = {},
): Promise<string> {
  const client = getClient(opts);

  const richMenuRequest: RichMenuRequest = {
    size: menu.size,
    selected: menu.selected ?? false,
    name: menu.name.slice(0, 300), // LINE limit
    chatBarText: menu.chatBarText.slice(0, 14), // LINE limit
    areas: menu.areas as RichMenuArea[],
  };

  const response = await client.createRichMenu(richMenuRequest);

  if (opts.verbose) {
    logVerbose(`line: created rich menu ${response.richMenuId}`);
  }

  return response.richMenuId;
}

/**
 * Upload an image for a rich menu
 * Image requirements:
 * - Format: JPEG or PNG
 * - Size: Must match the rich menu size (2500x1686 or 2500x843)
 * - Max file size: 1MB
 */
export async function uploadRichMenuImage(
  richMenuId: string,
  imagePath: string,
  opts: RichMenuOpts = {},
): Promise<void> {
  const blobClient = getBlobClient(opts);

  const imageData = await readFile(imagePath);
  const contentType = imagePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";

  await blobClient.setRichMenuImage(richMenuId, new Blob([imageData], { type: contentType }));

  if (opts.verbose) {
    logVerbose(`line: uploaded image to rich menu ${richMenuId}`);
  }
}

/**
 * Set the default rich menu for all users
 */
export async function setDefaultRichMenu(
  richMenuId: string,
  opts: RichMenuOpts = {},
): Promise<void> {
  const client = getClient(opts);

  await client.setDefaultRichMenu(richMenuId);

  if (opts.verbose) {
    logVerbose(`line: set default rich menu to ${richMenuId}`);
  }
}

/**
 * Cancel the default rich menu
 */
export async function cancelDefaultRichMenu(opts: RichMenuOpts = {}): Promise<void> {
  const client = getClient(opts);

  await client.cancelDefaultRichMenu();

  if (opts.verbose) {
    logVerbose(`line: cancelled default rich menu`);
  }
}

/**
 * Get the default rich menu ID
 */
export async function getDefaultRichMenuId(opts: RichMenuOpts = {}): Promise<string | null> {
  const client = getClient(opts);

  try {
    const response = await client.getDefaultRichMenuId();
    return response.richMenuId ?? null;
  } catch {
    return null;
  }
}

/**
 * Link a rich menu to a specific user
 */
export async function linkRichMenuToUser(
  userId: string,
  richMenuId: string,
  opts: RichMenuOpts = {},
): Promise<void> {
  const client = getClient(opts);

  await client.linkRichMenuIdToUser(userId, richMenuId);

  if (opts.verbose) {
    logVerbose(`line: linked rich menu ${richMenuId} to user ${userId}`);
  }
}

/**
 * Link a rich menu to multiple users (up to 500)
 */
export async function linkRichMenuToUsers(
  userIds: string[],
  richMenuId: string,
  opts: RichMenuOpts = {},
): Promise<void> {
  const client = getClient(opts);

  // LINE allows max 500 users per request
  const batches = [];
  for (let i = 0; i < userIds.length; i += 500) {
    batches.push(userIds.slice(i, i + 500));
  }

  for (const batch of batches) {
    await client.linkRichMenuIdToUsers({
      richMenuId,
      userIds: batch,
    });
  }

  if (opts.verbose) {
    logVerbose(`line: linked rich menu ${richMenuId} to ${userIds.length} users`);
  }
}

/**
 * Unlink a rich menu from a specific user
 */
export async function unlinkRichMenuFromUser(
  userId: string,
  opts: RichMenuOpts = {},
): Promise<void> {
  const client = getClient(opts);

  await client.unlinkRichMenuIdFromUser(userId);

  if (opts.verbose) {
    logVerbose(`line: unlinked rich menu from user ${userId}`);
  }
}

/**
 * Unlink rich menus from multiple users (up to 500)
 */
export async function unlinkRichMenuFromUsers(
  userIds: string[],
  opts: RichMenuOpts = {},
): Promise<void> {
  const client = getClient(opts);

  // LINE allows max 500 users per request
  const batches = [];
  for (let i = 0; i < userIds.length; i += 500) {
    batches.push(userIds.slice(i, i + 500));
  }

  for (const batch of batches) {
    await client.unlinkRichMenuIdFromUsers({
      userIds: batch,
    });
  }

  if (opts.verbose) {
    logVerbose(`line: unlinked rich menu from ${userIds.length} users`);
  }
}

/**
 * Get the rich menu linked to a specific user
 */
export async function getRichMenuIdOfUser(
  userId: string,
  opts: RichMenuOpts = {},
): Promise<string | null> {
  const client = getClient(opts);

  try {
    const response = await client.getRichMenuIdOfUser(userId);
    return response.richMenuId ?? null;
  } catch {
    return null;
  }
}

/**
 * Get a list of all rich menus
 */
export async function getRichMenuList(opts: RichMenuOpts = {}): Promise<RichMenuResponse[]> {
  const client = getClient(opts);

  const response = await client.getRichMenuList();
  return response.richmenus ?? [];
}

/**
 * Get a specific rich menu by ID
 */
export async function getRichMenu(
  richMenuId: string,
  opts: RichMenuOpts = {},
): Promise<RichMenuResponse | null> {
  const client = getClient(opts);

  try {
    return await client.getRichMenu(richMenuId);
  } catch {
    return null;
  }
}

/**
 * Delete a rich menu
 */
export async function deleteRichMenu(richMenuId: string, opts: RichMenuOpts = {}): Promise<void> {
  const client = getClient(opts);

  await client.deleteRichMenu(richMenuId);

  if (opts.verbose) {
    logVerbose(`line: deleted rich menu ${richMenuId}`);
  }
}

/**
 * Create a rich menu alias
 */
export async function createRichMenuAlias(
  richMenuId: string,
  aliasId: string,
  opts: RichMenuOpts = {},
): Promise<void> {
  const client = getClient(opts);

  await client.createRichMenuAlias({
    richMenuId,
    richMenuAliasId: aliasId,
  });

  if (opts.verbose) {
    logVerbose(`line: created alias ${aliasId} for rich menu ${richMenuId}`);
  }
}

/**
 * Delete a rich menu alias
 */
export async function deleteRichMenuAlias(aliasId: string, opts: RichMenuOpts = {}): Promise<void> {
  const client = getClient(opts);

  await client.deleteRichMenuAlias(aliasId);

  if (opts.verbose) {
    logVerbose(`line: deleted alias ${aliasId}`);
  }
}

// ============================================================================
// Default Menu Template Helpers
// ============================================================================

/**
 * Create a standard 2x3 grid layout for rich menu areas
 * Returns 6 areas in a 2-row, 3-column layout
 */
export function createGridLayout(
  height: 1686 | 843,
  actions: [Action, Action, Action, Action, Action, Action],
): RichMenuAreaRequest[] {
  const colWidth = Math.floor(2500 / 3);
  const rowHeight = Math.floor(height / 2);

  return [
    // Top row
    { bounds: { x: 0, y: 0, width: colWidth, height: rowHeight }, action: actions[0] },
    { bounds: { x: colWidth, y: 0, width: colWidth, height: rowHeight }, action: actions[1] },
    { bounds: { x: colWidth * 2, y: 0, width: colWidth, height: rowHeight }, action: actions[2] },
    // Bottom row
    { bounds: { x: 0, y: rowHeight, width: colWidth, height: rowHeight }, action: actions[3] },
    {
      bounds: { x: colWidth, y: rowHeight, width: colWidth, height: rowHeight },
      action: actions[4],
    },
    {
      bounds: { x: colWidth * 2, y: rowHeight, width: colWidth, height: rowHeight },
      action: actions[5],
    },
  ];
}

/**
 * Create a message action (sends text when tapped)
 */
export function messageAction(label: string, text?: string): Action {
  return {
    type: "message",
    label: label.slice(0, 20),
    text: text ?? label,
  };
}

/**
 * Create a URI action (opens a URL when tapped)
 */
export function uriAction(label: string, uri: string): Action {
  return {
    type: "uri",
    label: label.slice(0, 20),
    uri,
  };
}

/**
 * Create a postback action (sends data to webhook when tapped)
 */
export function postbackAction(label: string, data: string, displayText?: string): Action {
  return {
    type: "postback",
    label: label.slice(0, 20),
    data: data.slice(0, 300),
    displayText: displayText?.slice(0, 300),
  };
}

/**
 * Create a datetime picker action
 */
export function datetimePickerAction(
  label: string,
  data: string,
  mode: "date" | "time" | "datetime",
  options?: {
    initial?: string;
    max?: string;
    min?: string;
  },
): Action {
  return {
    type: "datetimepicker",
    label: label.slice(0, 20),
    data: data.slice(0, 300),
    mode,
    initial: options?.initial,
    max: options?.max,
    min: options?.min,
  };
}

/**
 * Create a default help/status/settings menu
 * This is a convenience function to quickly set up a standard menu
 */
export function createDefaultMenuConfig(): CreateRichMenuParams {
  return {
    size: { width: 2500, height: 843 },
    selected: false,
    name: "Default Menu",
    chatBarText: "Menu",
    areas: createGridLayout(843, [
      messageAction("Help", "/help"),
      messageAction("Status", "/status"),
      messageAction("Settings", "/settings"),
      messageAction("About", "/about"),
      messageAction("Feedback", "/feedback"),
      messageAction("Contact", "/contact"),
    ]),
  };
}

// Re-export types
export type { RichMenuRequest, RichMenuResponse, RichMenuArea, Action };

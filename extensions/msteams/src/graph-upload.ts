/**
 * OneDrive/SharePoint upload utilities for MS Teams file sending.
 *
 * For group chats and channels, files are uploaded to SharePoint and shared via a link.
 * This module provides utilities for:
 * - Uploading files to OneDrive (personal scope - now deprecated for bot use)
 * - Uploading files to SharePoint (group/channel scope)
 * - Creating sharing links (organization-wide or per-user)
 * - Getting chat members for per-user sharing
 */

import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";
import { buildUserAgent } from "./user-agent.js";

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const GRAPH_BETA = "https://graph.microsoft.com/beta";
const GRAPH_SCOPE = "https://graph.microsoft.com";

export interface OneDriveUploadResult {
  id: string;
  webUrl: string;
  name: string;
}

/**
 * Upload a file to the user's OneDrive root folder.
 * For larger files, this uses the simple upload endpoint (up to 4MB).
 */
export async function uploadToOneDrive(params: {
  buffer: Buffer;
  filename: string;
  contentType?: string;
  tokenProvider: MSTeamsAccessTokenProvider;
  fetchFn?: typeof fetch;
}): Promise<OneDriveUploadResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const token = await params.tokenProvider.getAccessToken(GRAPH_SCOPE);

  // Use "OpenClawShared" folder to organize bot-uploaded files
  const uploadPath = `/OpenClawShared/${encodeURIComponent(params.filename)}`;

  const res = await fetchFn(`${GRAPH_ROOT}/me/drive/root:${uploadPath}:/content`, {
    method: "PUT",
    headers: {
      "User-Agent": buildUserAgent(),
      Authorization: `Bearer ${token}`,
      "Content-Type": params.contentType ?? "application/octet-stream",
    },
    body: new Uint8Array(params.buffer),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OneDrive upload failed: ${res.status} ${res.statusText} - ${body}`);
  }

  const data = (await res.json()) as {
    id?: string;
    webUrl?: string;
    name?: string;
  };

  if (!data.id || !data.webUrl || !data.name) {
    throw new Error("OneDrive upload response missing required fields");
  }

  return {
    id: data.id,
    webUrl: data.webUrl,
    name: data.name,
  };
}

export interface OneDriveSharingLink {
  webUrl: string;
}

/**
 * Create a sharing link for a OneDrive file.
 * The link allows organization members to view the file.
 */
export async function createSharingLink(params: {
  itemId: string;
  tokenProvider: MSTeamsAccessTokenProvider;
  /** Sharing scope: "organization" (default) or "anonymous" */
  scope?: "organization" | "anonymous";
  fetchFn?: typeof fetch;
}): Promise<OneDriveSharingLink> {
  const fetchFn = params.fetchFn ?? fetch;
  const token = await params.tokenProvider.getAccessToken(GRAPH_SCOPE);

  const res = await fetchFn(`${GRAPH_ROOT}/me/drive/items/${params.itemId}/createLink`, {
    method: "POST",
    headers: {
      "User-Agent": buildUserAgent(),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "view",
      scope: params.scope ?? "organization",
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Create sharing link failed: ${res.status} ${res.statusText} - ${body}`);
  }

  const data = (await res.json()) as {
    link?: { webUrl?: string };
  };

  if (!data.link?.webUrl) {
    throw new Error("Create sharing link response missing webUrl");
  }

  return {
    webUrl: data.link.webUrl,
  };
}

/**
 * Upload a file to OneDrive and create a sharing link.
 * Convenience function for the common case.
 */
export async function uploadAndShareOneDrive(params: {
  buffer: Buffer;
  filename: string;
  contentType?: string;
  tokenProvider: MSTeamsAccessTokenProvider;
  scope?: "organization" | "anonymous";
  fetchFn?: typeof fetch;
}): Promise<{
  itemId: string;
  webUrl: string;
  shareUrl: string;
  name: string;
}> {
  const uploaded = await uploadToOneDrive({
    buffer: params.buffer,
    filename: params.filename,
    contentType: params.contentType,
    tokenProvider: params.tokenProvider,
    fetchFn: params.fetchFn,
  });

  const shareLink = await createSharingLink({
    itemId: uploaded.id,
    tokenProvider: params.tokenProvider,
    scope: params.scope,
    fetchFn: params.fetchFn,
  });

  return {
    itemId: uploaded.id,
    webUrl: uploaded.webUrl,
    shareUrl: shareLink.webUrl,
    name: uploaded.name,
  };
}

// ============================================================================
// SharePoint upload functions for group chats and channels
// ============================================================================

/**
 * Upload a file to a SharePoint site.
 * This is used for group chats and channels where /me/drive doesn't work for bots.
 *
 * @param params.siteId - SharePoint site ID (e.g., "contoso.sharepoint.com,guid1,guid2")
 */
export async function uploadToSharePoint(params: {
  buffer: Buffer;
  filename: string;
  contentType?: string;
  tokenProvider: MSTeamsAccessTokenProvider;
  siteId: string;
  fetchFn?: typeof fetch;
}): Promise<OneDriveUploadResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const token = await params.tokenProvider.getAccessToken(GRAPH_SCOPE);

  // Use "OpenClawShared" folder to organize bot-uploaded files
  const uploadPath = `/OpenClawShared/${encodeURIComponent(params.filename)}`;

  const res = await fetchFn(
    `${GRAPH_ROOT}/sites/${params.siteId}/drive/root:${uploadPath}:/content`,
    {
      method: "PUT",
      headers: {
        "User-Agent": buildUserAgent(),
        Authorization: `Bearer ${token}`,
        "Content-Type": params.contentType ?? "application/octet-stream",
      },
      body: new Uint8Array(params.buffer),
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`SharePoint upload failed: ${res.status} ${res.statusText} - ${body}`);
  }

  const data = (await res.json()) as {
    id?: string;
    webUrl?: string;
    name?: string;
  };

  if (!data.id || !data.webUrl || !data.name) {
    throw new Error("SharePoint upload response missing required fields");
  }

  return {
    id: data.id,
    webUrl: data.webUrl,
    name: data.name,
  };
}

export interface ChatMember {
  aadObjectId: string;
  displayName?: string;
}

/**
 * Properties needed for native Teams file card attachments.
 * The eTag is used as the attachment ID and webDavUrl as the contentUrl.
 */
export interface DriveItemProperties {
  /** The eTag of the driveItem (used as attachment ID) */
  eTag: string;
  /** The WebDAV URL of the driveItem (used as contentUrl for reference attachment) */
  webDavUrl: string;
  /** The filename */
  name: string;
}

/**
 * Get driveItem properties needed for native Teams file card attachments.
 * This fetches the eTag and webDavUrl which are required for "reference" type attachments.
 *
 * @param params.siteId - SharePoint site ID
 * @param params.itemId - The driveItem ID (returned from upload)
 */
export async function getDriveItemProperties(params: {
  siteId: string;
  itemId: string;
  tokenProvider: MSTeamsAccessTokenProvider;
  fetchFn?: typeof fetch;
}): Promise<DriveItemProperties> {
  const fetchFn = params.fetchFn ?? fetch;
  const token = await params.tokenProvider.getAccessToken(GRAPH_SCOPE);

  const res = await fetchFn(
    `${GRAPH_ROOT}/sites/${params.siteId}/drive/items/${params.itemId}?$select=eTag,webDavUrl,name`,
    { headers: { "User-Agent": buildUserAgent(), Authorization: `Bearer ${token}` } },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Get driveItem properties failed: ${res.status} ${res.statusText} - ${body}`);
  }

  const data = (await res.json()) as {
    eTag?: string;
    webDavUrl?: string;
    name?: string;
  };

  if (!data.eTag || !data.webDavUrl || !data.name) {
    throw new Error("DriveItem response missing required properties (eTag, webDavUrl, or name)");
  }

  return {
    eTag: data.eTag,
    webDavUrl: data.webDavUrl,
    name: data.name,
  };
}

/**
 * Resolve the Graph API-native chat ID from a Bot Framework conversation ID.
 *
 * Bot Framework personal DM conversation IDs use formats like `a:1xxx@unq.gbl.spaces`
 * or `8:orgid:xxx` that the Graph API does not accept. Graph API requires the
 * `19:xxx@thread.tacv2` or `19:xxx@unq.gbl.spaces` format.
 *
 * This function looks up the matching Graph chat by querying the bot's chats filtered
 * by the target user's AAD object ID.
 */
export async function resolveGraphChatId(params: {
  /** Bot Framework conversation ID (may be in non-Graph format for personal DMs) */
  botFrameworkConversationId: string;
  /** AAD object ID of the user in the conversation (used for filtering chats) */
  userAadObjectId?: string;
  tokenProvider: MSTeamsAccessTokenProvider;
  fetchFn?: typeof fetch;
}): Promise<string | null> {
  const { botFrameworkConversationId, userAadObjectId, tokenProvider } = params;
  const fetchFn = params.fetchFn ?? fetch;

  // If the conversation ID already looks like a valid Graph chat ID, return it directly.
  // Graph chat IDs start with "19:" — Bot Framework group chat IDs already use this format.
  if (botFrameworkConversationId.startsWith("19:")) {
    return botFrameworkConversationId;
  }

  // For personal DMs with non-Graph conversation IDs (e.g. `a:1xxx` or `8:orgid:xxx`),
  // query the bot's chats to find the matching one.
  const token = await tokenProvider.getAccessToken(GRAPH_SCOPE);

  // Build filter: if we have the user's AAD object ID, narrow the search to 1:1 chats
  // with that member. Otherwise, fall back to listing all 1:1 chats.
  let path: string;
  if (userAadObjectId) {
    const encoded = encodeURIComponent(
      `chatType eq 'oneOnOne' and members/any(m:m/microsoft.graph.aadUserConversationMember/userId eq '${userAadObjectId}')`,
    );
    path = `/me/chats?$filter=${encoded}&$select=id`;
  } else {
    // Fallback: list all 1:1 chats when no user ID is available.
    // Only safe when the bot has exactly one 1:1 chat; returns null otherwise to
    // avoid sending to the wrong person's chat.
    path = `/me/chats?$filter=${encodeURIComponent("chatType eq 'oneOnOne'")}&$select=id`;
  }

  const res = await fetchFn(`${GRAPH_ROOT}${path}`, {
    headers: { "User-Agent": buildUserAgent(), Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    return null;
  }

  const data = (await res.json()) as {
    value?: Array<{ id?: string }>;
  };

  const chats = data.value ?? [];

  // When filtered by userAadObjectId, any non-empty result is the right 1:1 chat.
  if (userAadObjectId && chats.length > 0 && chats[0]?.id) {
    return chats[0].id;
  }

  // Without a user ID we can only be certain when exactly one chat is returned;
  // multiple results would be ambiguous and could route to the wrong person.
  if (!userAadObjectId && chats.length === 1 && chats[0]?.id) {
    return chats[0].id;
  }

  return null;
}

/**
 * Get members of a Teams chat for per-user sharing.
 * Used to create sharing links scoped to only the chat participants.
 */
export async function getChatMembers(params: {
  chatId: string;
  tokenProvider: MSTeamsAccessTokenProvider;
  fetchFn?: typeof fetch;
}): Promise<ChatMember[]> {
  const fetchFn = params.fetchFn ?? fetch;
  const token = await params.tokenProvider.getAccessToken(GRAPH_SCOPE);

  const res = await fetchFn(`${GRAPH_ROOT}/chats/${params.chatId}/members`, {
    headers: { "User-Agent": buildUserAgent(), Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Get chat members failed: ${res.status} ${res.statusText} - ${body}`);
  }

  const data = (await res.json()) as {
    value?: Array<{
      userId?: string;
      displayName?: string;
    }>;
  };

  return (data.value ?? [])
    .map((m) => ({
      aadObjectId: m.userId ?? "",
      displayName: m.displayName,
    }))
    .filter((m) => m.aadObjectId);
}

/**
 * Create a sharing link for a SharePoint drive item.
 * For organization scope (default), uses v1.0 API.
 * For per-user scope, uses beta API with recipients.
 */
export async function createSharePointSharingLink(params: {
  siteId: string;
  itemId: string;
  tokenProvider: MSTeamsAccessTokenProvider;
  /** Sharing scope: "organization" (default) or "users" (per-user with recipients) */
  scope?: "organization" | "users";
  /** Required when scope is "users": AAD object IDs of recipients */
  recipientObjectIds?: string[];
  fetchFn?: typeof fetch;
}): Promise<OneDriveSharingLink> {
  const fetchFn = params.fetchFn ?? fetch;
  const token = await params.tokenProvider.getAccessToken(GRAPH_SCOPE);
  const scope = params.scope ?? "organization";

  // Per-user sharing requires beta API
  const apiRoot = scope === "users" ? GRAPH_BETA : GRAPH_ROOT;

  const body: Record<string, unknown> = {
    type: "view",
    scope: scope === "users" ? "users" : "organization",
  };

  // Add recipients for per-user sharing
  if (scope === "users" && params.recipientObjectIds?.length) {
    body.recipients = params.recipientObjectIds.map((id) => ({ objectId: id }));
  }

  const res = await fetchFn(
    `${apiRoot}/sites/${params.siteId}/drive/items/${params.itemId}/createLink`,
    {
      method: "POST",
      headers: {
        "User-Agent": buildUserAgent(),
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const respBody = await res.text().catch(() => "");
    throw new Error(
      `Create SharePoint sharing link failed: ${res.status} ${res.statusText} - ${respBody}`,
    );
  }

  const data = (await res.json()) as {
    link?: { webUrl?: string };
  };

  if (!data.link?.webUrl) {
    throw new Error("Create SharePoint sharing link response missing webUrl");
  }

  return {
    webUrl: data.link.webUrl,
  };
}

/**
 * Upload a file to SharePoint and create a sharing link.
 *
 * For group chats, this creates a per-user sharing link scoped to chat members.
 * For channels, this creates an organization-wide sharing link.
 *
 * @param params.siteId - SharePoint site ID
 * @param params.chatId - Optional chat ID for per-user sharing (group chats)
 * @param params.usePerUserSharing - Whether to use per-user sharing (requires beta API + Chat.Read.All)
 */
export async function uploadAndShareSharePoint(params: {
  buffer: Buffer;
  filename: string;
  contentType?: string;
  tokenProvider: MSTeamsAccessTokenProvider;
  siteId: string;
  chatId?: string;
  usePerUserSharing?: boolean;
  fetchFn?: typeof fetch;
}): Promise<{
  itemId: string;
  webUrl: string;
  shareUrl: string;
  name: string;
}> {
  // 1. Upload file to SharePoint
  const uploaded = await uploadToSharePoint({
    buffer: params.buffer,
    filename: params.filename,
    contentType: params.contentType,
    tokenProvider: params.tokenProvider,
    siteId: params.siteId,
    fetchFn: params.fetchFn,
  });

  // 2. Determine sharing scope
  let scope: "organization" | "users" = "organization";
  let recipientObjectIds: string[] | undefined;

  if (params.usePerUserSharing && params.chatId) {
    try {
      const members = await getChatMembers({
        chatId: params.chatId,
        tokenProvider: params.tokenProvider,
        fetchFn: params.fetchFn,
      });

      if (members.length > 0) {
        scope = "users";
        recipientObjectIds = members.map((m) => m.aadObjectId);
      }
    } catch {
      // Fall back to organization scope if we can't get chat members
      // (e.g., missing Chat.Read.All permission)
    }
  }

  // 3. Create sharing link
  const shareLink = await createSharePointSharingLink({
    siteId: params.siteId,
    itemId: uploaded.id,
    tokenProvider: params.tokenProvider,
    scope,
    recipientObjectIds,
    fetchFn: params.fetchFn,
  });

  return {
    itemId: uploaded.id,
    webUrl: uploaded.webUrl,
    shareUrl: shareLink.webUrl,
    name: uploaded.name,
  };
}

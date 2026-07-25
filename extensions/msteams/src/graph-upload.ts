/**
 * SharePoint upload utilities for MS Teams file sending.
 *
 * For group chats and channels, files are uploaded to SharePoint and shared via a link.
 * This module provides utilities for:
 * - Uploading files to SharePoint (group/channel scope)
 * - Creating sharing links (organization-wide or per-user)
 * - Getting chat members for per-user sharing
 */

import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";
import { createMSTeamsHttpError } from "./http-error.js";
import {
  resolveMSTeamsSharePointUploadTimeoutMs,
  withMSTeamsAbortableRequestTimeout,
  withMSTeamsRequestDeadline,
} from "./request-timeout.js";
import { buildUserAgent } from "./user-agent.js";

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const GRAPH_BETA = "https://graph.microsoft.com/beta";
const GRAPH_SCOPE = "https://graph.microsoft.com";

export function requireMSTeamsSharePointSiteId(siteId?: string): string {
  const normalized = siteId?.trim();
  if (!normalized) {
    throw new Error(
      "channels.msteams.sharePointSiteId is required to send files to group chats or channels",
    );
  }
  return normalized;
}

interface DriveUploadResult {
  id: string;
  webUrl: string;
  name: string;
}

interface SharingLinkResult {
  webUrl: string;
}

const SHAREPOINT_REQUEST_TIMEOUT_LABEL = "MS Teams SharePoint request";
const SHAREPOINT_UPLOAD_TIMEOUT_LABEL = "MS Teams SharePoint upload";
const GRAPH_TOKEN_TIMEOUT_LABEL = "MS Teams Graph token acquisition";

async function getGraphAccessToken(tokenProvider: MSTeamsAccessTokenProvider): Promise<string> {
  return await withMSTeamsRequestDeadline({
    label: GRAPH_TOKEN_TIMEOUT_LABEL,
    work: async () => await tokenProvider.getAccessToken(GRAPH_SCOPE),
  });
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
async function uploadToSharePoint(params: {
  buffer: Buffer;
  filename: string;
  contentType?: string;
  tokenProvider: MSTeamsAccessTokenProvider;
  siteId: string;
  fetchFn?: typeof fetch;
}): Promise<DriveUploadResult> {
  const fetchFn = params.fetchFn ?? fetch;

  // Use "OpenClawShared" folder to organize bot-uploaded files
  const uploadPath = `/OpenClawShared/${encodeURIComponent(params.filename)}`;

  const data = await withMSTeamsAbortableRequestTimeout({
    label: SHAREPOINT_UPLOAD_TIMEOUT_LABEL,
    timeoutMs: resolveMSTeamsSharePointUploadTimeoutMs(params.buffer.length),
    work: async (signal) => {
      const token = await getGraphAccessToken(params.tokenProvider);
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
          signal,
        },
      );

      if (!res.ok) {
        throw await createMSTeamsHttpError(res, "SharePoint upload failed");
      }

      return await readProviderJsonResponse<{
        id?: string;
        webUrl?: string;
        name?: string;
      }>(res, "msteams.graph-upload.uploadSharePointFile");
    },
  });

  if (!data.id || !data.webUrl || !data.name) {
    throw new Error("SharePoint upload response missing required fields");
  }

  return {
    id: data.id,
    webUrl: data.webUrl,
    name: data.name,
  };
}

interface ChatMember {
  aadObjectId: string;
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

  const data = await withMSTeamsAbortableRequestTimeout({
    label: SHAREPOINT_REQUEST_TIMEOUT_LABEL,
    work: async (signal) => {
      const token = await getGraphAccessToken(params.tokenProvider);
      const res = await fetchFn(
        `${GRAPH_ROOT}/sites/${params.siteId}/drive/items/${params.itemId}?$select=eTag,webDavUrl,name`,
        {
          headers: { "User-Agent": buildUserAgent(), Authorization: `Bearer ${token}` },
          signal,
        },
      );

      if (!res.ok) {
        throw await createMSTeamsHttpError(res, "Get driveItem properties failed");
      }

      return await readProviderJsonResponse<{
        eTag?: string;
        webDavUrl?: string;
        name?: string;
      }>(res, "msteams.graph-upload.getDriveItemProperties");
    },
  });

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
 * Get members of a Teams chat for per-user sharing.
 * Used to create sharing links scoped to only the chat participants.
 */
async function getChatMembers(params: {
  chatId: string;
  tokenProvider: MSTeamsAccessTokenProvider;
  fetchFn?: typeof fetch;
}): Promise<ChatMember[]> {
  const fetchFn = params.fetchFn ?? fetch;

  return await withMSTeamsAbortableRequestTimeout({
    label: SHAREPOINT_REQUEST_TIMEOUT_LABEL,
    work: async (signal) => {
      const token = await getGraphAccessToken(params.tokenProvider);
      const res = await fetchFn(`${GRAPH_ROOT}/chats/${params.chatId}/members`, {
        headers: { "User-Agent": buildUserAgent(), Authorization: `Bearer ${token}` },
        signal,
      });

      if (!res.ok) {
        // Graph 403 covers permissions, licensing, and conditional access. RSC
        // grants are not token roles, so no local signal can safely widen access.
        const message =
          res.status === 403
            ? "Get chat members failed; verify Graph chat-member permissions and tenant access policies"
            : "Get chat members failed";
        throw await createMSTeamsHttpError(res, message);
      }

      const data = await readProviderJsonResponse<{
        value?: Array<{ userId?: string }>;
      }>(res, "msteams.graph-upload.getChatMembers");
      const members = (data.value ?? [])
        .map((member) => ({ aadObjectId: member.userId ?? "" }))
        .filter((member) => member.aadObjectId);
      return members;
    },
  });
}

/**
 * Create a sharing link for a SharePoint drive item.
 * For organization scope (default), uses v1.0 API.
 * For per-user scope, uses beta API with recipients.
 */
async function createSharePointSharingLink(params: {
  siteId: string;
  itemId: string;
  tokenProvider: MSTeamsAccessTokenProvider;
  /** Sharing scope: "organization" (default) or "users" (per-user with recipients) */
  scope?: "organization" | "users";
  /** Required when scope is "users": AAD object IDs of recipients */
  recipientObjectIds?: string[];
  fetchFn?: typeof fetch;
}): Promise<SharingLinkResult> {
  const fetchFn = params.fetchFn ?? fetch;
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

  const data = await withMSTeamsAbortableRequestTimeout({
    label: SHAREPOINT_REQUEST_TIMEOUT_LABEL,
    work: async (signal) => {
      const token = await getGraphAccessToken(params.tokenProvider);
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
          signal,
        },
      );

      if (!res.ok) {
        throw await createMSTeamsHttpError(res, "Create SharePoint sharing link failed");
      }

      return await readProviderJsonResponse<{
        link?: { webUrl?: string };
      }>(res, "msteams.graph-upload.createSharePointSharingLink");
    },
  });

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
 * @param params.usePerUserSharing - Whether to use per-user sharing (requires beta API + chat-member read access)
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
    const members = await getChatMembers({
      chatId: params.chatId,
      tokenProvider: params.tokenProvider,
      fetchFn: params.fetchFn,
    });
    if (members.length === 0) {
      throw new Error("MS Teams chat member lookup returned no recipients");
    }
    scope = "users";
    recipientObjectIds = members.map((member) => member.aadObjectId);
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

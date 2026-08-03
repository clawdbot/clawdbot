/**
 * Centralized API route templates for the QQ Open Platform.
 *
 * Eliminates C2C/Group path duplication by parameterizing on `ChatScope`.
 * Inspired by `bot-node-sdk/src/openapi/v1/resource.ts`.
 */

import type { ChatScope } from "../types.js";

/**
 * Build the message-send path for C2C or Group.
 *
 * - C2C:   `/v2/users/{id}/messages`
 * - Group: `/v2/groups/{id}/messages`
 */
export function messagePath(scope: ChatScope, targetId: string): string {
  return scope === "c2c" ? `/v2/users/${targetId}/messages` : `/v2/groups/${targetId}/messages`;
}

/** Channel message path. */
export function channelMessagePath(channelId: string): string {
  return `/channels/${channelId}/messages`;
}

/** DM (direct message inside a guild) path. */
export function dmMessagePath(guildId: string): string {
  return `/dms/${guildId}/messages`;
}

/**
 * Build the media upload (small-file) path for C2C or Group.
 *
 * - C2C:   `/v2/users/{id}/files`
 * - Group: `/v2/groups/{id}/files`
 */
export function mediaUploadPath(scope: ChatScope, targetId: string): string {
  return scope === "c2c" ? `/v2/users/${targetId}/files` : `/v2/groups/${targetId}/files`;
}

/**
 * Build the upload_prepare path for C2C or Group.
 *
 * - C2C:   `/v2/users/{id}/upload_prepare`
 * - Group: `/v2/groups/{id}/upload_prepare`
 */
export function uploadPreparePath(scope: ChatScope, targetId: string): string {
  return scope === "c2c"
    ? `/v2/users/${targetId}/upload_prepare`
    : `/v2/groups/${targetId}/upload_prepare`;
}

/**
 * Build the upload_part_finish path for C2C or Group.
 */
export function uploadPartFinishPath(scope: ChatScope, targetId: string): string {
  return scope === "c2c"
    ? `/v2/users/${targetId}/upload_part_finish`
    : `/v2/groups/${targetId}/upload_part_finish`;
}

/**
 * Build the complete-upload (files) path for C2C or Group.
 * (Same as mediaUploadPath — the complete endpoint reuses the files path.)
 */
export function uploadCompletePath(scope: ChatScope, targetId: string): string {
  return mediaUploadPath(scope, targetId);
}

/** Stream message path (C2C only). */
export function streamMessagePath(openid: string): string {
  return `/v2/users/${openid}/stream_messages`;
}

/** Gateway URL path. */
export function gatewayPath(): string {
  return "/gateway";
}

/** Interaction acknowledgement path. */
export function interactionPath(interactionId: string): string {
  return `/interactions/${interactionId}`;
}

// ============ Shared Helpers ============

/**
 * Generate a message sequence number in the 0..65535 range.
 *
 * Used by both `messages.ts` and `media.ts` to avoid duplicate definitions.
 */
export function getNextMsgSeq(_msgId: string): number {
  const timePart = Date.now() % 100_000_000;
  const random = Math.floor(Math.random() * 65536);
  return (timePart ^ random) % 65536;
}

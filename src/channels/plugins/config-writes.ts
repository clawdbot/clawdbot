/**
 * Channel config-write policy facade.
 *
 * Applies shared config write authorization to concrete OpenClaw channel config.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  authorizeConfigWriteShared,
  canBypassConfigWritePolicyShared,
  formatConfigWriteDeniedMessageShared,
  resolveConfigWriteTargetFromPathShared,
  resolveExplicitConfigWriteTargetShared,
  type ConfigWriteAuthorizationResultLike,
  type ConfigWriteScopeLike,
  type ConfigWriteTargetLike,
} from "./config-write-policy-shared.js";
import type { ChannelId } from "./types.core.js";

/**
 * Channel/account scope used by channel config write checks.
 */
type ConfigWriteScope = ConfigWriteScopeLike;

/**
 * Target affected by a channel config write.
 */
export type ConfigWriteTarget = ConfigWriteTargetLike;

/**
 * Authorization result for a channel config write.
 */
type ConfigWriteAuthorizationResult = ConfigWriteAuthorizationResultLike;

function isInternalConfigWriteMessageChannel(channel?: string | null): boolean {
  return normalizeLowercaseStringOrEmpty(channel) === "webchat";
}

/**
 * Authorizes a channel config write under origin and target policy.
 */
export function authorizeConfigWrite(params: {
  cfg: OpenClawConfig;
  origin?: ConfigWriteScope;
  target?: ConfigWriteTarget;
  allowBypass?: boolean;
}): ConfigWriteAuthorizationResult {
  return authorizeConfigWriteShared(params);
}

/**
 * Resolves an explicit channel/account scope into a config write target.
 */
export function resolveExplicitConfigWriteTarget(scope: ConfigWriteScope): ConfigWriteTarget {
  return resolveExplicitConfigWriteTargetShared(scope);
}

/**
 * Infers the channel config write target from a config path.
 */
export function resolveConfigWriteTargetFromPath(path: string[]): ConfigWriteTarget {
  return resolveConfigWriteTargetFromPathShared({
    path,
    normalizeChannelId: (raw) => normalizeLowercaseStringOrEmpty(raw) as ChannelId,
  });
}

/**
 * Checks whether a gateway client can bypass channel config write policy.
 */
export function canBypassConfigWritePolicy(params: {
  channel?: string | null;
  gatewayClientScopes?: string[] | null;
}): boolean {
  return canBypassConfigWritePolicyShared({
    ...params,
    isInternalMessageChannel: isInternalConfigWriteMessageChannel,
  });
}

/**
 * Formats the user-facing denial message for a blocked channel config write.
 */
export function formatConfigWriteDeniedMessage(params: {
  result: Exclude<ConfigWriteAuthorizationResult, { allowed: true }>;
  fallbackChannelId?: ChannelId | null;
}): string {
  return formatConfigWriteDeniedMessageShared(params);
}

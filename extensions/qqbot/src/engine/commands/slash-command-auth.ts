/**
 * Pre-dispatch authorization for requireAuth slash commands.
 *
 * Unlike the access-stage's `resolveCommandAuthorized` (which permits
 * `dm_policy_open` senders — i.e. anyone), this function requires the
 * sender to appear in an **explicit non-wildcard** allowFrom list.
 *
 * Rationale: sensitive operations (log export, file deletion, approval
 * config changes) must be gated behind a deliberate operator decision.
 * A wide-open DM policy means "anyone can chat", not "anyone can run
 * admin commands".
 */

import { createQQBotSenderMatcher, normalizeQQBotAllowFrom } from "../access/index.js";

type SlashCommandAuthEntry = string | number;

function isSlashCommandAuthEntry(value: unknown): value is SlashCommandAuthEntry {
  return typeof value === "string" || typeof value === "number";
}

function readSlashCommandAuthList(value: unknown): SlashCommandAuthEntry[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter(isSlashCommandAuthEntry);
}

/**
 * Resolve the command-specific QQBot allowlist from the root OpenClaw config.
 *
 * `commands.allowFrom.qqbot` takes precedence over the global
 * `commands.allowFrom["*"]`, matching the framework command authorization
 * contract used by registered plugin commands.
 */
export function resolveQQBotCommandsAllowFrom(cfg: unknown): SlashCommandAuthEntry[] | undefined {
  if (!cfg || typeof cfg !== "object") {
    return undefined;
  }
  const commands = (cfg as { commands?: unknown }).commands;
  if (!commands || typeof commands !== "object") {
    return undefined;
  }
  const allowFrom = (commands as { allowFrom?: unknown }).allowFrom;
  if (!allowFrom || typeof allowFrom !== "object" || Array.isArray(allowFrom)) {
    return undefined;
  }
  const byProvider = allowFrom as Record<string, unknown>;
  return readSlashCommandAuthList(byProvider.qqbot) ?? readSlashCommandAuthList(byProvider["*"]);
}

/**
 * Determine whether `senderId` is authorized to execute `requireAuth`
 * slash commands for the given account configuration.
 *
 * Authorization rules:
 * - `commands.allowFrom.qqbot` / `commands.allowFrom["*"]` configured →
 *   use that command-specific list instead of channel allowFrom
 * - `allowFrom` not configured / empty / only `["*"]` → **false**
 *   (wildcard means "open to everyone", not explicit authorization)
 * - `allowFrom` contains at least one concrete entry AND sender
 *   matches a concrete entry → **true**
 * - Group messages use `groupAllowFrom` when present, falling back
 *   to `allowFrom`.
 */
export function resolveSlashCommandAuth(params: {
  senderId: string;
  isGroup: boolean;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  commandsAllowFrom?: Array<string | number>;
}): boolean {
  const rawList =
    params.commandsAllowFrom ??
    (params.isGroup && params.groupAllowFrom && params.groupAllowFrom.length > 0
      ? params.groupAllowFrom
      : params.allowFrom);

  const normalized = normalizeQQBotAllowFrom(rawList);

  // Require and match only explicit (non-wildcard) entries.
  const explicitEntries = normalized.filter((entry) => entry !== "*");
  if (explicitEntries.length === 0) {
    return false;
  }

  return createQQBotSenderMatcher(params.senderId)(explicitEntries);
}

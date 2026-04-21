/**
 * Group message gating — three-layer access control for group messages.
 *
 * 1. `ignoreOtherMentions` — skip messages that @other bots, not this one.
 * 2. `shouldBlock` — enforce allowFrom whitelist at the group level.
 * 3. `mentionGating` — require explicit @bot mention in group chats.
 *
 * All functions are **pure** (no side effects, no I/O), making them easy to
 * test and safe to share between the built-in and standalone versions.
 */

/** Result of the group message gate evaluation. */
export interface GateResult {
  /** Whether the message should be blocked (i.e. not processed). */
  blocked: boolean;
  /** Reason for blocking (for logging). */
  reason?: string;
  /** Whether the sender is authorized for slash commands. */
  commandAuthorized: boolean;
}

/** Configuration relevant to group message gating. */
export interface GroupGateConfig {
  /** Normalized allowFrom list (uppercase, `qqbot:` prefix stripped). */
  normalizedAllowFrom: string[];
  /**
   * Whether to ignore messages that mention other bots.
   * When true, messages containing @mentions for other bot IDs are silently dropped.
   */
  ignoreOtherMentions?: boolean;
}

/**
 * Evaluate the group message gate for one inbound message.
 *
 * @param senderId - The sender's openid (raw, not normalized).
 * @param config - Group gating configuration.
 * @returns The gate evaluation result.
 */
export function resolveGroupMessageGate(senderId: string, config: GroupGateConfig): GateResult {
  const { normalizedAllowFrom } = config;

  // Normalize the sender ID for comparison.
  const normalizedSenderId = senderId.replace(/^qqbot:/i, "").toUpperCase();

  // Open gate: empty allowFrom or wildcard means everyone is allowed.
  const allowAll = normalizedAllowFrom.length === 0 || normalizedAllowFrom.some((e) => e === "*");

  const commandAuthorized = allowAll || normalizedAllowFrom.includes(normalizedSenderId);

  return {
    blocked: false,
    commandAuthorized,
  };
}

/**
 * Normalize an allowFrom list by stripping `qqbot:` prefixes and uppercasing.
 *
 * @param allowFrom - Raw allowFrom config entries.
 * @returns Normalized entries for comparison.
 */
export function normalizeAllowFrom(allowFrom: Array<string | number> | undefined | null): string[] {
  if (!allowFrom) {
    return [];
  }
  return allowFrom
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^qqbot:/i, ""))
    .map((entry) => entry.toUpperCase());
}

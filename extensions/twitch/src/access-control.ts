import type { TwitchAccountConfig, TwitchChatMessage } from "./types.js";

/**
 * Result of checking access control for a Twitch message
 */
export type TwitchAccessControlResult = {
  allowed: boolean;
  reason?: string;
  matchKey?: string;
  matchSource?: string;
};

/**
 * Check if a Twitch message should be allowed based on account configuration
 *
 * This function implements the access control logic for incoming Twitch messages,
 * checking allowlists, role-based restrictions, and mention requirements.
 *
 * Priority order:
 * 1. If `requireMention` is true, message must mention the bot
 * 2. If `allowFrom` is set, sender must be in the allowlist (by user ID)
 * 3. If `allowedRoles` is set, sender must have at least one of the specified roles
 *
 * Note: You can combine `allowFrom` with `allowedRoles`. If a user is in `allowFrom`,
 * they bypass role checks. This is useful for allowing specific users regardless of role.
 *
 * Available roles:
 * - "moderator": Moderators
 * - "owner": Channel owner/broadcaster
 * - "vip": VIPs
 * - "subscriber": Subscribers
 * - "all": Anyone in the chat
 */
export function checkTwitchAccessControl(params: {
  message: TwitchChatMessage;
  account: TwitchAccountConfig;
  botUsername: string;
}): TwitchAccessControlResult {
  const { message, account, botUsername } = params;

  if (account.requireMention ?? true) {
    const mentions = extractMentions(message.message);
    if (!mentions.includes(botUsername.toLowerCase())) {
      return {
        allowed: false,
        reason: "message does not mention the bot (requireMention is enabled)",
      };
    }
  }

  if (account.allowFrom && account.allowFrom.length > 0) {
    const allowFrom = account.allowFrom;
    const senderId = message.userId;

    if (!senderId) {
      return {
        allowed: false,
        reason: "sender user ID not available for allowlist check",
      };
    }

    if (allowFrom.includes(senderId)) {
      return {
        allowed: true,
        matchKey: senderId,
        matchSource: "allowlist",
      };
    }
  }

  if (account.allowedRoles && account.allowedRoles.length > 0) {
    const allowedRoles = account.allowedRoles;

    // "all" grants access to everyone
    if (allowedRoles.includes("all")) {
      return {
        allowed: true,
        matchKey: "all",
        matchSource: "role",
      };
    }

    const hasAllowedRole = checkSenderRoles({
      message,
      allowedRoles,
    });

    if (!hasAllowedRole) {
      return {
        allowed: false,
        reason: `sender does not have any of the required roles: ${allowedRoles.join(", ")}`,
      };
    }

    return {
      allowed: true,
      matchKey: allowedRoles.join(","),
      matchSource: "role",
    };
  }

  return {
    allowed: true,
  };
}

/**
 * Check if the sender has any of the allowed roles
 */
function checkSenderRoles(params: { message: TwitchChatMessage; allowedRoles: string[] }): boolean {
  const { message, allowedRoles } = params;
  const { isMod, isOwner, isVip, isSub } = message;

  for (const role of allowedRoles) {
    switch (role) {
      case "moderator":
        if (isMod) return true;
        break;
      case "owner":
        if (isOwner) return true;
        break;
      case "vip":
        if (isVip) return true;
        break;
      case "subscriber":
        if (isSub) return true;
        break;
    }
  }

  return false;
}

/**
 * Extract @mentions from a Twitch chat message
 *
 * Returns a list of lowercase usernames that were mentioned in the message.
 * Twitch mentions are in the format @username.
 */
export function extractMentions(message: string): string[] {
  const mentionRegex = /@(\w+)/g;
  const mentions: string[] = [];
  let match: RegExpExecArray | null;

  // biome-ignore lint/suspicious/noAssignInExpressions: Standard regex iteration pattern
  while ((match = mentionRegex.exec(message)) !== null) {
    const username = match[1];
    if (username) {
      mentions.push(username.toLowerCase());
    }
  }

  return mentions;
}

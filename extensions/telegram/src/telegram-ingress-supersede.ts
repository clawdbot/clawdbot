import type {
  ChannelIngressQueueClaim,
  ChannelIngressQueueRecord,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  maybeResolveTextAlias,
  normalizeCommandBody,
} from "openclaw/plugin-sdk/command-auth-native";
import {
  isAbortRequestText,
  isBtwRequestText,
} from "openclaw/plugin-sdk/command-primitives-runtime";
// Telegram plugin module owns pre-adoption supersede policy for durable ingress.
import { isTelegramReadOnlyControlLaneText } from "./sequential-key.js";
import type { TelegramSpooledUpdatePayload } from "./telegram-ingress-spool.payload.js";
import {
  isTelegramAmbientSpooledUpdate,
  isTelegramSpooledUpdateSenderAuthorized,
  type TelegramSupersedeAuthContext,
} from "./telegram-ingress-supersede-auth.js";

function isRecognizedTelegramTextCommand(rawText: string, botUsername?: string): boolean {
  return (
    maybeResolveTextAlias(
      normalizeCommandBody(rawText, botUsername ? { botUsername } : undefined),
    ) != null
  );
}

/**
 * Whether a bot_command entity (or slash token) targets this bot.
 * Same target rule as normalizeCommandBody: untargeted commands match any bot;
 * @OtherBot is ignored when our identity is known.
 */
function isTelegramCommandTargetedAtBot(commandText: string, botUsername?: string): boolean {
  const trimmed = commandText.trim();
  if (!trimmed.startsWith("/")) {
    return false;
  }
  // normalizeCommandBody only strips @bot when the target equals botUsername.
  // A non-matching @target leaves the body as `/cmd@other`, which is not ours.
  const normalized = normalizeCommandBody(
    trimmed,
    botUsername ? { botUsername } : undefined,
  ).trim();
  if (!normalized.startsWith("/")) {
    return false;
  }
  // Untargeted, or successfully stripped for this bot.
  if (!/^\/[^\s@]+@/u.test(normalized)) {
    return true;
  }
  // Identity unknown: keep untargeted-permissive behavior for pre-getMe drains.
  return !botUsername?.trim();
}

/** True when the update carries a bot_command entity addressed to this bot. */
function updateHasBotCommandEntityForBot(update: unknown, botUsername?: string): boolean {
  if (!update || typeof update !== "object") {
    return false;
  }
  const root = update as Record<string, unknown>;
  for (const key of ["message", "edited_message", "channel_post", "edited_channel_post"] as const) {
    const msg = root[key];
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const message = msg as {
      text?: unknown;
      caption?: unknown;
      entities?: unknown;
      caption_entities?: unknown;
    };
    const body =
      typeof message.text === "string"
        ? message.text
        : typeof message.caption === "string"
          ? message.caption
          : "";
    for (const entities of [message.entities, message.caption_entities]) {
      if (!Array.isArray(entities)) {
        continue;
      }
      for (const entity of entities) {
        if (!entity || typeof entity !== "object") {
          continue;
        }
        const ent = entity as { type?: unknown; offset?: unknown; length?: unknown };
        if (ent.type !== "bot_command") {
          continue;
        }
        if (typeof ent.offset !== "number" || typeof ent.length !== "number") {
          continue;
        }
        const commandText = body.slice(ent.offset, ent.offset + ent.length);
        if (isTelegramCommandTargetedAtBot(commandText, botUsername)) {
          return true;
        }
      }
    }
  }
  return false;
}

function extractUpdateText(update: unknown): string {
  if (!update || typeof update !== "object") {
    return "";
  }
  const root = update as Record<string, unknown>;
  for (const key of ["message", "edited_message", "channel_post", "edited_channel_post"] as const) {
    const msg = root[key];
    if (msg && typeof msg === "object") {
      const text = (msg as { text?: unknown; caption?: unknown }).text;
      if (typeof text === "string") {
        return text;
      }
      const caption = (msg as { caption?: unknown }).caption;
      if (typeof caption === "string") {
        return caption;
      }
    }
  }
  const callback = root.callback_query;
  if (callback && typeof callback === "object") {
    const data = (callback as { data?: unknown }).data;
    if (typeof data === "string") {
      return data;
    }
  }
  return "";
}

/**
 * Drain-level supersede predicate over raw spooled payloads.
 * Authorization is resolved from the new event's numeric sender via the same
 * ingress command gate as the old fence (CommandAuthorized).
 */
export function createShouldSupersedeTelegramSpooledPending(
  auth: TelegramSupersedeAuthContext,
): (
  newEvent: ChannelIngressQueueRecord<TelegramSpooledUpdatePayload>,
  pendingEvent: ChannelIngressQueueClaim<TelegramSpooledUpdatePayload>,
) => boolean | Promise<boolean> {
  return async (newEvent, pendingEvent) => {
    const pendingUpdate = pendingEvent.payload.update;
    const newUpdate = newEvent.payload.update;
    // Ambient pending supersede still requires an authorized sender — same as the
    // old fence (post-auth). Unauthorized strangers cannot cancel pre-adoption work.
    if (
      isTelegramAmbientSpooledUpdate(pendingUpdate) &&
      !isTelegramAmbientSpooledUpdate(newUpdate)
    ) {
      return await isTelegramSpooledUpdateSenderAuthorized(newUpdate, auth);
    }
    const text = extractUpdateText(newUpdate);
    if (!text) {
      return false;
    }
    const commandOptions = auth.botUsername ? { botUsername: auth.botUsername } : undefined;
    if (
      isBtwRequestText(text, commandOptions) ||
      isTelegramReadOnlyControlLaneText({
        rawText: text,
        ...(auth.botUsername ? { botUsername: auth.botUsername } : {}),
      })
    ) {
      return false;
    }
    // Abort, static text alias, or native bot_command entity (incl. skill commands)
    // addressed to this bot. Never bare `/` prefixes without a bot_command entity.
    const isAbort = isAbortRequestText(text, commandOptions);
    const isCommand =
      isRecognizedTelegramTextCommand(text, auth.botUsername) ||
      updateHasBotCommandEntityForBot(newUpdate, auth.botUsername);
    if (!isAbort && !isCommand) {
      return false;
    }
    return await isTelegramSpooledUpdateSenderAuthorized(newUpdate, auth);
  };
}

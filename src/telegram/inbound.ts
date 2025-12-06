import type { TelegramClient } from "telegram";
import { Api } from "telegram";
import type { NewMessageEvent } from "telegram/events/NewMessage.js";
import { NewMessage } from "telegram/events/NewMessage.js";
import type {
  MessageHandler,
  ProviderMedia,
  ProviderMessage,
} from "../providers/base/types.js";
import { normalizeAllowFromEntry } from "../utils.js";

/**
 * Convert Telegram message to ProviderMessage format.
 */
export async function convertTelegramMessage(
  event: NewMessageEvent,
): Promise<ProviderMessage | null> {
  const msg = event.message;

  // Only process incoming messages (not outgoing)
  if (msg.out) {
    return null;
  }

  // Extract sender info
  const sender = await event.message.getSender();
  if (!sender) {
    return null;
  }

  const from = extractSenderIdentifier(sender as any);
  const displayName = extractDisplayName(sender as any);

  // Extract message body
  const body = msg.message || "";

  // Extract media if present
  const media: ProviderMedia[] = [];
  if (msg.media && event.client) {
    const mediaItem = await extractMedia(msg.media, event.client);
    if (mediaItem) {
      media.push(mediaItem);
    }
  }

  return {
    id: msg.id.toString(),
    from,
    to: "me", // Always "me" for personal account
    body,
    timestamp: msg.date ? msg.date * 1000 : Date.now(),
    displayName,
    media: media.length > 0 ? media : undefined,
    raw: msg,
    provider: "telegram",
  };
}

/**
 * Extract sender identifier with telegram: prefix to prevent session ID collisions.
 *
 * Returns:
 * - telegram:@username (if username available)
 * - telegram:+phone (if phone available)
 * - telegram:id (numeric Telegram ID as fallback)
 */
function extractSenderIdentifier(sender: Api.User | Api.Chat): string {
  if ("username" in sender && sender.username) {
    return `telegram:@${sender.username}`;
  }
  if ("phone" in sender && sender.phone) {
    return `telegram:${sender.phone}`;
  }
  if ("id" in sender && sender.id) {
    return `telegram:${sender.id.toString()}`;
  }
  return "telegram:unknown";
}

/**
 * Extract display name from sender.
 */
function extractDisplayName(sender: Api.User | Api.Chat): string {
  if ("firstName" in sender && sender.firstName) {
    const lastName =
      "lastName" in sender && sender.lastName ? ` ${sender.lastName}` : "";
    return `${sender.firstName}${lastName}`;
  }
  if ("title" in sender && sender.title) {
    return sender.title;
  }
  return "Unknown";
}

/**
 * Extract media from Telegram message.
 */
async function extractMedia(
  media: Api.TypeMessageMedia,
  client: TelegramClient,
): Promise<ProviderMedia | null> {
  try {
    // Check for photo media (by instanceof or className for test compatibility)
    const isPhoto =
      media instanceof Api.MessageMediaPhoto ||
      (media as any).className === "MessageMediaPhoto";
    if (isPhoto && (media as any).photo) {
      const buffer = await client.downloadMedia(media, {
        outputFile: undefined,
      });
      if (buffer instanceof Buffer) {
        return {
          type: "image",
          buffer,
          mimeType: "image/jpeg",
        };
      }
    }

    // Check for document media (by instanceof or className for test compatibility)
    const isDocument =
      media instanceof Api.MessageMediaDocument ||
      (media as any).className === "MessageMediaDocument";
    if (isDocument && (media as any).document) {
      const doc = (media as any).document as Api.Document;
      const buffer = await client.downloadMedia(media, {
        outputFile: undefined,
      });

      if (buffer instanceof Buffer) {
        // Detect media type from attributes
        const attrs = doc.attributes || [];

        // Helper to check attribute type safely (handles test env where Api classes may not exist)
        const isAttrType = (a: any, className: string) => {
          try {
            switch (className) {
              case "DocumentAttributeVideo":
                return (
                  a instanceof Api.DocumentAttributeVideo ||
                  a.className === className
                );
              case "DocumentAttributeAudio":
                return (
                  a instanceof Api.DocumentAttributeAudio ||
                  a.className === className
                );
              case "DocumentAttributeFilename":
                return (
                  a instanceof Api.DocumentAttributeFilename ||
                  a.className === className
                );
              default:
                return a.className === className;
            }
          } catch {
            // If instanceof fails (test env), fallback to className
            return a.className === className;
          }
        };

        const isVideo = attrs.some((a: any) =>
          isAttrType(a, "DocumentAttributeVideo"),
        );
        const isAudio = attrs.some((a: any) =>
          isAttrType(a, "DocumentAttributeAudio"),
        );

        // Check if it's a voice message by mime type (e.g., audio/ogg with opus codec)
        const isVoice =
          doc.mimeType === "audio/ogg" || doc.mimeType === "audio/opus";

        let type: ProviderMedia["type"] = "document";
        if (isVoice) type = "voice";
        else if (isVideo) type = "video";
        else if (isAudio) type = "audio";
        else if (doc.mimeType?.startsWith("image/")) type = "image";

        const fileName = attrs
          .filter((a: any) => isAttrType(a, "DocumentAttributeFilename"))
          .map((a: any) => a.fileName)[0];

        return {
          type,
          buffer,
          mimeType: doc.mimeType || "application/octet-stream",
          fileName,
          size: Number(doc.size),
        };
      }
    }
  } catch (err) {
    console.warn(`Failed to download media: ${String(err)}`);
  }

  return null;
}

/**
 * Check if message sender is in allowFrom whitelist.
 */
export function isAllowedSender(
  message: ProviderMessage,
  allowFrom?: string[],
): boolean {
  if (!allowFrom || allowFrom.length === 0) {
    return true; // No whitelist = allow all
  }

  const normalizedFrom = normalizeAllowFromEntry(message.from, "telegram");
  const normalizedAllowList = allowFrom.map((e) =>
    normalizeAllowFromEntry(e, "telegram"),
  );
  return normalizedAllowList.includes(normalizedFrom);
}

/**
 * Start listening for inbound messages with allowFrom filtering.
 */
export async function startMessageListener(
  client: TelegramClient,
  handler: MessageHandler,
  allowFrom?: string[],
): Promise<() => void> {
  const eventHandler = async (event: NewMessageEvent) => {
    try {
      const message = await convertTelegramMessage(event);
      if (!message) {
        return; // Outgoing or invalid message
      }

      // Check allowFrom whitelist
      if (!isAllowedSender(message, allowFrom)) {
        console.log(
          `Ignored message from ${message.from} (not in allowFrom list)`,
        );
        return;
      }

      // Call handler
      await handler(message);
    } catch (err) {
      console.error(`Error handling Telegram message: ${String(err)}`);
    }
  };

  // Create event filter instance and reuse for both add and remove
  const eventFilter = new NewMessage({});
  client.addEventHandler(eventHandler, eventFilter);

  // Return cleanup function
  return () => {
    client.removeEventHandler(eventHandler, eventFilter);
  };
}

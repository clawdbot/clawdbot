import { type chat_v1, google } from "googleapis";
import type { ResolvedGoogleChatAccount } from "./accounts.js";

const chatClients: Map<string, chat_v1.Chat> = new Map();

async function getChatClient(
  account: ResolvedGoogleChatAccount,
): Promise<chat_v1.Chat> {
  const cacheKey = `${account.accountId}:${account.credentialsPath ?? "default"}`;
  const cached = chatClients.get(cacheKey);
  if (cached) return cached;

  const auth = new google.auth.GoogleAuth({
    keyFile: account.credentialsPath,
    scopes: ["https://www.googleapis.com/auth/chat.bot"],
  });

  const client = google.chat({
    version: "v1",
    auth,
  });

  chatClients.set(cacheKey, client);
  return client;
}

export type SendGoogleChatResult = {
  messageId: string;
  spaceName: string;
};

export async function sendGoogleChatText(
  to: string,
  text: string,
  options: {
    account: ResolvedGoogleChatAccount;
    threadKey?: string;
  },
): Promise<SendGoogleChatResult> {
  const client = await getChatClient(options.account);

  const spaceName = to.startsWith("spaces/") ? to : `spaces/${to}`;

  const prefix = options.account.config.messagePrefix;
  const formattedText = prefix ? `${prefix} ${text}` : text;

  const requestBody: chat_v1.Schema$Message = {
    text: formattedText,
  };

  if (options.threadKey) {
    requestBody.thread = { name: options.threadKey };
  }

  const response = await client.spaces.messages.create({
    parent: spaceName,
    requestBody,
  });

  return {
    messageId: response.data.name ?? "",
    spaceName,
  };
}

export async function sendGoogleChatMedia(
  to: string,
  mediaUrl: string,
  options: {
    account: ResolvedGoogleChatAccount;
    caption?: string;
    threadKey?: string;
  },
): Promise<SendGoogleChatResult> {
  const client = await getChatClient(options.account);

  const spaceName = to.startsWith("spaces/") ? to : `spaces/${to}`;

  // Google Chat doesn't have direct media upload like WhatsApp
  // Embed media URL as a link in the message text
  const caption = options.caption ?? "";
  const text = caption
    ? `${caption}\n\n${mediaUrl}`
    : mediaUrl;

  const requestBody: chat_v1.Schema$Message = {
    text,
  };

  if (options.threadKey) {
    requestBody.thread = { name: options.threadKey };
  }

  const response = await client.spaces.messages.create({
    parent: spaceName,
    requestBody,
  });

  return {
    messageId: response.data.name ?? "",
    spaceName,
  };
}

export function chunkGoogleChatText(text: string, chunkLimit: number): string[] {
  if (text.length <= chunkLimit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= chunkLimit) {
      chunks.push(remaining);
      break;
    }

    // Try to split at newline
    const chunk = remaining.substring(0, chunkLimit);
    const lastNewline = chunk.lastIndexOf("\n");

    if (lastNewline > chunkLimit * 0.5) {
      chunks.push(remaining.substring(0, lastNewline));
      remaining = remaining.substring(lastNewline + 1);
    } else {
      // No good newline, split at space
      const lastSpace = chunk.lastIndexOf(" ");
      if (lastSpace > chunkLimit * 0.5) {
        chunks.push(remaining.substring(0, lastSpace));
        remaining = remaining.substring(lastSpace + 1);
      } else {
        // No good space, hard split
        chunks.push(chunk);
        remaining = remaining.substring(chunkLimit);
      }
    }
  }

  return chunks;
}

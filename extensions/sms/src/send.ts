import { chunkTextForOutbound, stripMarkdown } from "openclaw/plugin-sdk/text-chunking";
import { sendSmsViaTwilio } from "./twilio.js";
import type { ResolvedSmsAccount, SmsSendResult } from "./types.js";

export function toSmsPlainText(text: string): string {
  const withoutFencedCodeMarkers = text.replace(
    /```[^\n]*\n?([\s\S]*?)```/g,
    (_match, body: string) => body.trim(),
  );
  const withReadableLinks = withoutFencedCodeMarkers.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_match, label: string, url: string) => {
      const cleanLabel = label.trim();
      const cleanUrl = url.trim();
      return cleanLabel && cleanLabel !== cleanUrl ? `${cleanLabel} (${cleanUrl})` : cleanUrl;
    },
  );
  return stripMarkdown(withReadableLinks)
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function sendSmsTextChunks(params: {
  account: ResolvedSmsAccount;
  to: string;
  text: string;
}): Promise<SmsSendResult[]> {
  const text = toSmsPlainText(params.text);
  if (!text) {
    throw new Error("SMS send requires non-empty text.");
  }
  const chunks = chunkTextForOutbound(text, params.account.textChunkLimit).filter(Boolean);
  const sendChunks = chunks.length ? chunks : [text];
  const results: SmsSendResult[] = [];
  for (const textLocal of sendChunks) {
    results.push(
      await sendSmsViaTwilio({
        account: params.account,
        to: params.to,
        text: textLocal,
      }),
    );
  }
  return results;
}

// Sms plugin module implements send behavior.
import {
  type MarkdownIR,
  renderMarkdownIRChunksWithinLimit,
  sanitizeAssistantVisibleText,
  stripMarkdown,
} from "openclaw/plugin-sdk/text-chunking";
import { sendSmsViaTwilio } from "./twilio.js";
import type { ResolvedSmsAccount, SmsSendResult } from "./types.js";

const SMS_ASSISTANT_TRANSCRIPT_ROLE_PREFIX = "[assistant-authored transcript] ";

export function toSmsPlainText(text: string): string {
  const visibleText = sanitizeAssistantVisibleText(text);
  return stripMarkdown(visibleText, {
    assistantTranscriptRoleHeaders: true,
    assistantTranscriptRolePrefix: SMS_ASSISTANT_TRANSCRIPT_ROLE_PREFIX,
    linkStyle: "label-and-url",
  })
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function chunkSmsPlainText(text: string, limit: number): string[] {
  const ir: MarkdownIR = { text, styles: [], links: [] };
  return renderMarkdownIRChunksWithinLimit({
    ir,
    limit,
    assistantTranscriptRoleMessageBoundaries: true,
    // A soft split can promote mid-line prose to a new SMS boundary. Re-run
    // the semantic annotation while measuring so the marker stays in-budget.
    renderChunk: (chunk) =>
      chunk.annotations?.some((annotation) => annotation.type === "assistant_transcript_role")
        ? `${SMS_ASSISTANT_TRANSCRIPT_ROLE_PREFIX}${chunk.text}`
        : chunk.text,
    measureRendered: (rendered) => rendered.length,
  })
    .map(({ rendered }) => rendered)
    .filter(Boolean);
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
  const chunks = chunkSmsPlainText(text, params.account.textChunkLimit);
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

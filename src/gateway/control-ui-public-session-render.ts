import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import MarkdownIt from "markdown-it";
import { isHeartbeatOkResponse, isHeartbeatUserMessage } from "../auto-reply/heartbeat-filter.js";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import {
  stripInternalMetadataForDisplay,
  stripUserEnvelopeForDisplay,
} from "../auto-reply/reply/display-text-sanitize.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { splitMediaFromOutput } from "../media/parse.js";
import { INTER_SESSION_PROMPT_PREFIX_BASE } from "../sessions/input-provenance.js";
import { extractAssistantPhaseText } from "../shared/chat-message-content.js";
import { escapeHtml } from "../shared/html-escape.js";
import { sanitizeAssistantVisibleTextWithProfile } from "../shared/text/assistant-visible-text.js";
import { stripSuppressedControlReplyToken } from "./control-reply-text.js";

const MAX_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 32_768;
const MAX_DOCUMENT_CHARS = 262_144;

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
markdown.validateLink = (value) => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
};
// Images must not contact third parties or load authenticated session media.
markdown.renderer.rules.image = () => '<span class="omitted">[Image omitted]</span>';
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index]?.attrSet("rel", "noreferrer noopener nofollow");
  return renderer.renderToken(tokens, index, options);
};

function publicMessageText(
  message: unknown,
): { role: "user" | "assistant"; text: string } | undefined {
  const entry = asOptionalRecord(message);
  if (
    !entry ||
    (entry.role !== "user" && entry.role !== "assistant") ||
    entry.display === false ||
    entry.customType !== undefined ||
    entry.senderSession !== undefined ||
    entry.toolCallId !== undefined ||
    entry.tool_call_id !== undefined
  ) {
    return undefined;
  }
  const provenance = asOptionalRecord(entry.provenance);
  // A user role can also carry private runtime and cross-session input.
  // Unknown explicit provenance is not an external user's publication grant.
  if (entry.provenance !== undefined && provenance?.kind !== "external_user") {
    return undefined;
  }
  let text: string | undefined;
  if (entry.role === "assistant") {
    if (entry.phase !== undefined && entry.phase !== "final_answer") {
      return undefined;
    }
    text = extractAssistantPhaseText(entry);
  } else if (typeof entry.content === "string") {
    text = entry.content;
  } else if (Array.isArray(entry.content)) {
    text = entry.content
      .flatMap((value) => {
        const block = asOptionalRecord(value);
        return (block?.type === "text" || block?.type === "input_text") &&
          typeof block.text === "string"
          ? [block.text]
          : [];
      })
      .join("\n\n");
  } else if (typeof entry.text === "string") {
    text = entry.text;
  }
  if (!text || text.includes(INTER_SESSION_PROMPT_PREFIX_BASE)) {
    return undefined;
  }
  text =
    entry.role === "user"
      ? stripUserEnvelopeForDisplay(text)
      : stripInternalMetadataForDisplay(text);
  if (entry.role === "assistant") {
    // Live transcripts can end mid-tag. Never recover unfinished reasoning as public prose.
    text = sanitizeAssistantVisibleTextWithProfile(text, "history", true);
  }
  const roleContent = { role: entry.role, content: text };
  if (isHeartbeatUserMessage(roleContent, HEARTBEAT_PROMPT) || isHeartbeatOkResponse(roleContent)) {
    return undefined;
  }
  if (entry.role === "assistant") {
    text = stripSuppressedControlReplyToken(text);
  }
  // The canonical parser removes attachment directives while preserving fenced examples.
  text = splitMediaFromOutput(text, {
    extractAudioDirectives: false,
    extractMarkdownImages: false,
  }).text;
  text = redactToolPayloadText(text).trim();
  return text ? { role: entry.role, text } : undefined;
}

export function renderPublicSessionDocument(params: {
  messages: unknown[];
  title: string;
  truncated: boolean;
  latestUrl: string;
  canonicalUrl?: string;
  cardUrl: string;
  olderUrl?: string;
  isLatest?: boolean;
}): string {
  const isLatest = params.isLatest !== false;
  const title = escapeHtml(
    redactToolPayloadText(stripInternalMetadataForDisplay(params.title)).slice(0, 200).trim() ||
      "Shared conversation",
  );
  let truncated = params.truncated || params.messages.length > MAX_MESSAGES;
  let remaining = MAX_DOCUMENT_CHARS;
  const rows: string[] = [];
  // Budget newest messages first, then restore conversational order.
  for (const value of params.messages.slice(-MAX_MESSAGES).toReversed()) {
    const message = publicMessageText(value);
    if (!message) {
      continue;
    }
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const text = message.text.slice(0, Math.min(MAX_MESSAGE_CHARS, remaining));
    const clipped = text.length < message.text.length;
    truncated ||= clipped;
    remaining -= text.length;
    rows.push(
      `<article class="message ${message.role}" aria-label="${message.role === "user" ? "User" : "Assistant"} message"><h2>${message.role === "user" ? "User" : "OpenClaw"}</h2><div class="content">${markdown.render(text)}${clipped ? '<p class="omitted">Message shortened for this public view.</p>' : ""}</div></article>`,
    );
  }
  const description = "A public, read-only OpenClaw conversation. No login required.";
  const canonicalMetadata = params.canonicalUrl
    ? `<link rel="canonical" href="${escapeHtml(params.canonicalUrl)}">
<meta property="og:url" content="${escapeHtml(params.canonicalUrl)}">`
    : "";
  const navigation = params.olderUrl
    ? `<nav class="pagination" aria-label="Conversation pages"><a href="${escapeHtml(params.olderUrl)}" rel="prev">← Older messages</a></nav>`
    : "";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex, nofollow">
${isLatest ? '<meta http-equiv="refresh" content="15">' : ""}
<title>${title} · OpenClaw</title>${canonicalMetadata}
<meta property="og:type" content="website"><meta property="og:site_name" content="OpenClaw">
<meta property="og:title" content="${title}"><meta property="og:description" content="${description}">
<meta property="og:image" content="${escapeHtml(params.cardUrl)}">
<meta name="twitter:card" content="summary_large_image">
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b1016;color:#edf1f5;font-synthesis:none}
*{box-sizing:border-box}body{margin:0;border-top:3px solid #ff6257}a{color:#91c9ff;text-underline-offset:3px}a:focus-visible{outline:2px solid #ff8b81;outline-offset:4px}
main{width:min(820px,calc(100% - 40px));margin:0 auto;padding:44px 0 60px}.brand{font-weight:750;letter-spacing:-.03em;font-size:19px;color:#edf1f5}.brand span{color:#ff786b;margin-right:9px}.masthead{display:flex;align-items:center;justify-content:space-between;gap:16px}.badge{border:1px solid #345044;background:#14281f;border-radius:99px;padding:6px 11px;color:#a3ddba;font-size:12px;font-weight:650;white-space:nowrap}.badge::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:#91d6ab;margin-right:7px}
h1{font-size:clamp(28px,5vw,42px);line-height:1.15;letter-spacing:-.045em;margin:40px 0 16px;overflow-wrap:anywhere}.intro{color:#a6b3c0;font-size:14px;line-height:1.7;margin:0 0 30px;max-width:660px}.intro strong{color:#d6dee6;font-weight:550}.notice{padding:14px 18px;border:1px solid #554735;background:#261f16;color:#d7c4a7;font-size:13px;line-height:1.6;border-radius:10px;margin-bottom:28px}
.pagination{display:flex;justify-content:space-between;gap:18px;margin:24px 0;font-size:13px}.pagination a{padding:9px 0}.transcript{border-top:1px solid #26313b}.message{padding:27px 0;display:grid;grid-template-columns:90px minmax(0,1fr);gap:18px;border-bottom:1px solid #202b35}.message h2{margin:3px 0 0;font-size:12px;letter-spacing:.02em;font-weight:650;color:#99a9ba}.assistant h2{color:#ff958b}.content{min-width:0;font-size:15px;line-height:1.75;overflow-wrap:anywhere}.content>:first-child{margin-top:0}.content>:last-child{margin-bottom:0}.content p{margin:0 0 16px}.content h1,.content h2,.content h3,.content h4{color:#edf1f5;font-size:18px;line-height:1.4;letter-spacing:-.02em;margin:24px 0 12px}.content li{padding-left:3px;margin:5px 0}.content ul,.content ol{padding-left:24px}.content blockquote{margin:20px 0;border-left:3px solid #465b6d;padding:0 18px;color:#b1bfcb}.content pre{overflow:auto;max-width:100%;padding:16px 18px;border:1px solid #283541;border-radius:10px;background:#080d12;font-size:12px;line-height:1.7}.content code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.88em}.content :not(pre)>code{background:#1a2631;padding:2px 5px;border-radius:4px}.content table{display:block;max-width:100%;overflow:auto;border-collapse:collapse;font-size:13px}.content th,.content td{border:1px solid #34414d;text-align:left;padding:8px 12px}.content hr{border:0;border-top:1px solid #34414d;margin:24px 0}.omitted,.empty{color:#8c9dad;font-size:13px}.empty{padding:36px 0;line-height:1.7}footer{display:flex;justify-content:space-between;gap:20px;color:#80909f;font-size:12px;line-height:1.6;margin-top:30px}footer a{color:#a6b3c0}
@media(max-width:560px){main{width:calc(100% - 32px);padding-top:26px}.message{display:block;padding:23px 0}.message h2{margin:0 0 10px}.content h2{margin:24px 0 12px}.badge{font-size:11px}h1{margin-top:32px}footer{display:block}footer a{display:inline-block;margin-top:10px}}
</style></head><body><main>
<header><div class="masthead"><div class="brand"><span aria-hidden="true">✳</span>OpenClaw</div><span class="badge">Public · Read-only</span></div>
<h1>${title}</h1><p class="intro"><strong>Shared with everyone, no login required.</strong> This ${isLatest ? "live view" : "page"} includes conversation text. Tool output, files, images, reasoning, and interactive content are omitted.</p></header>
${!isLatest ? `<p class="page-label">Earlier conversation · <a href="${escapeHtml(params.latestUrl)}">Back to latest</a></p>` : ""}
${truncated ? '<aside class="notice">Some messages or long text are omitted to keep this public page within its size limit.</aside>' : ""}
${navigation}
<section class="transcript" aria-label="Conversation">${rows.length ? rows.toReversed().join("\n") : `<p class="empty">${isLatest ? "No public conversation text yet. New messages will appear here as the conversation continues." : "No public conversation text on this page. Use the page links to continue reading."}</p>`}</section>
${navigation}
<footer><span>${isLatest ? "Live view · Refreshes every 15 seconds" : "Earlier conversation · Updates when you reload"}<br>Public access can be revoked by the session owner.</span><a href="${escapeHtml(params.latestUrl)}">${isLatest ? "Refresh now" : "Back to latest"}</a></footer>
</main></body></html>`;
}

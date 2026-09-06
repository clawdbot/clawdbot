// QA Lab mock provider prompt directives and tool declarations.
import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  type ResponsesInputItem,
  QA_A2A_MESSAGE_TOOL_MIRROR_PROMPT_RE,
  QA_TOOL_SEARCH_PROMPT_RE,
  QA_TOOL_SEARCH_FAILURE_PROMPT_RE,
} from "./mock-openai-contracts.js";
import { extractInstructionsText } from "./mock-openai-input.js";
function extractLastCapture(text: string, pattern: RegExp) {
  let lastMatch: RegExpExecArray | null = null;
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  for (let match = globalPattern.exec(text); match; match = globalPattern.exec(text)) {
    lastMatch = match;
  }
  return lastMatch?.[1]?.trim() || null;
}

function extractCaptures(text: string, pattern: RegExp) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  return Array.from(text.matchAll(globalPattern), (match) => match[1]?.trim()).filter(Boolean);
}

export function extractExactReplyDirective(text: string) {
  const backtickedMatch = extractLastCapture(text, /reply(?: with)? exactly\s+`([^`]+)`/i);
  if (backtickedMatch) {
    return backtickedMatch;
  }
  return (
    extractLastCapture(text, /reply(?: with)? exactly:\s*([^\n]+)/i) ??
    extractLastCapture(text, /reply(?: with)? exactly\s+(?!with\b)([^\s`.,;:!?]+)/i)
  );
}

export function extractFinishExactlyDirective(text: string) {
  const backtickedMatch = extractLastCapture(text, /finish with exactly\s+`([^`]+)`/i);
  if (backtickedMatch) {
    return backtickedMatch;
  }
  return extractLastCapture(text, /finish with exactly\s+([^\s`.,;:!?]+)/i);
}

export function extractExactMarkerDirective(text: string) {
  const backtickedMatch = extractLastCapture(text, /exact marker\b[^:\n]{0,120}:\s*`([^`]+)`/i);
  if (backtickedMatch) {
    return backtickedMatch;
  }
  return extractLastCapture(
    text,
    /exact marker\b[^:\n]{0,120}:\s*([^\s`.,;:!?]+(?:-[^\s`.,;:!?]+)*)/i,
  );
}

export const QA_SLACK_PROGRESS_COMMENTARY_MARKER_RE =
  /\bSLACK-QA-COMMENTARY-(?!DONE-)[A-F0-9]{8}\b/u;

export function extractSlackProgressCommentaryDirectives(text: string) {
  const commentaryMarker = extractLastCapture(
    text,
    /\b(SLACK-QA-COMMENTARY-(?!DONE-)[A-F0-9]{8})\b/u,
  );
  const toolMarker = extractLastCapture(text, /\b(SLACK-QA-TOOL-[A-F0-9]{8})\b/u);
  const finalMarker = extractLastCapture(text, /\b(SLACK-QA-COMMENTARY-DONE-[A-F0-9]{8})\b/u);
  if (!commentaryMarker || !toolMarker || !finalMarker) {
    return null;
  }
  const suffix = commentaryMarker.slice("SLACK-QA-COMMENTARY-".length);
  const execCommand = `grep 'SLACK-QA-TOOL-${suffix}' /dev/null || sleep 5`;
  const commandDirective = extractLastCapture(
    text,
    /\b(grep 'SLACK-QA-TOOL-[A-F0-9]{8}' \/dev\/null \|\| sleep 5)(?=[.`\s]|$)/u,
  );
  if (
    toolMarker !== `SLACK-QA-TOOL-${suffix}` ||
    finalMarker !== `SLACK-QA-COMMENTARY-DONE-${suffix}` ||
    commandDirective !== execCommand
  ) {
    return null;
  }
  return { commentaryMarker, execCommand, finalMarker, toolMarker };
}

export function extractWhatsAppLocationMarkerDirective(text: string) {
  return extractLastCapture(
    text,
    /WhatsApp location marker:\s*([^\s`.,;:!?]+(?:-[^\s`.,;:!?]+)*)/i,
  );
}

export function extractWhatsAppContactMarkerDirective(text: string) {
  return extractLastCapture(text, /WhatsApp contact marker:\s*([^\s`.,;:!?]+(?:-[^\s`.,;:!?]+)*)/i);
}

export function extractWhatsAppStickerMarkerDirective(text: string) {
  return extractLastCapture(text, /WhatsApp sticker marker:\s*([^\s`.,;:!?]+(?:-[^\s`.,;:!?]+)*)/i);
}

const QA_TIMESTAMPED_MESSAGE_PREFIX_RE =
  /^\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?(?: [^\]\r\n]+)?\]\s*/u;
const QA_WHATSAPP_ENVELOPE_PREFIX_RE = /^\[WhatsApp(?: [^\]\r\n]+)?\]\s*/iu;
const QA_WHATSAPP_SENDER_PREFIX_RE = /^(?:\(self\)|[^:\r\n]+):\s*/u;

function hasWhatsAppStructuredMessageBody(prompt: string, bodyPattern: RegExp) {
  return prompt.split(/\r?\n/u).some((rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      return false;
    }

    const timestampedBody = line.replace(QA_TIMESTAMPED_MESSAGE_PREFIX_RE, "");
    const envelopeBody = timestampedBody.replace(QA_WHATSAPP_ENVELOPE_PREFIX_RE, "");
    if (bodyPattern.test(envelopeBody)) {
      return true;
    }
    // Sender attribution is structural only inside a WhatsApp envelope. Treating every colon as
    // attribution would misclassify ordinary timestamped prose such as "Contact note: <contact>".
    if (envelopeBody === timestampedBody) {
      return false;
    }
    return bodyPattern.test(envelopeBody.replace(QA_WHATSAPP_SENDER_PREFIX_RE, ""));
  });
}

export function shouldUseWhatsAppLocationMarker(prompt: string) {
  return hasWhatsAppStructuredMessageBody(prompt, /^📍\s*37\.774900,\s*-122\.419400\b/u);
}

export function shouldUseWhatsAppContactMarker(prompt: string) {
  return hasWhatsAppStructuredMessageBody(prompt, /^<contacts?(?::|>)/iu);
}

export function shouldUseWhatsAppStickerMarker(prompt: string) {
  const label = "WhatsApp media:";
  let searchFrom = 0;
  for (;;) {
    const labelIndex = prompt.indexOf(label, searchFrom);
    if (labelIndex < 0) {
      return false;
    }
    const fenceStart = prompt.indexOf("```json", labelIndex + label.length);
    const fenceEnd = fenceStart >= 0 ? prompt.indexOf("```", fenceStart + 7) : -1;
    if (fenceStart >= 0 && fenceEnd >= 0) {
      try {
        const value = JSON.parse(prompt.slice(fenceStart + 7, fenceEnd)) as {
          payload?: { kind?: unknown };
        };
        if (value.payload?.kind === "sticker") {
          return true;
        }
      } catch {
        // Ignore malformed metadata and continue to the next matching block.
      }
      searchFrom = fenceEnd + 3;
      continue;
    }
    searchFrom = labelIndex + label.length;
  }
}

function extractLabeledMarkerDirective(text: string, label: string) {
  const escapedLabel = escapeRegExp(label);
  const backtickedMatch = extractLastCapture(
    text,
    new RegExp(`${escapedLabel}:\\s*\`([^\\\`]+)\``, "i"),
  );
  if (backtickedMatch) {
    return backtickedMatch;
  }
  return extractLastCapture(
    text,
    new RegExp(`${escapedLabel}:\\s*([^\\s\\\`.,;:!?]+(?:-[^\\s\\\`.,;:!?]+)*)`, "i"),
  );
}

export function extractBlockStreamingMarkerDirectives(text: string) {
  const firstLabeledMarker = extractLabeledMarkerDirective(text, "first exact marker");
  const secondLabeledMarker = extractLabeledMarkerDirective(text, "second exact marker");
  if (firstLabeledMarker && secondLabeledMarker) {
    return {
      first: firstLabeledMarker,
      second: secondLabeledMarker,
    };
  }

  const markers = extractCaptures(text, /exact marker\b[^:\n]{0,120}:\s*`([^`]+)`/i);
  if (markers.length < 2) {
    return null;
  }
  const [first, second] = markers.slice(-2);
  return first && second
    ? {
        first,
        second,
      }
    : null;
}

function extractQuotedToolArg(text: string, name: string) {
  const escapedName = escapeRegExp(name);
  return extractLastCapture(text, new RegExp(`\\b${escapedName}\\s*=\\s*"([^"]+)"`, "i"));
}

function extractBareToolArg(text: string, name: string) {
  const escapedName = escapeRegExp(name);
  return extractLastCapture(text, new RegExp(`\\b${escapedName}\\s*=\\s*([^\\s\\\`.,;:!?]+)`, "i"));
}

export function hasDeclaredTool(body: Record<string, unknown>, name: string) {
  return (
    hasToolDefinition(body, name) ||
    instructionTextMentionsToolName(extractInstructionsText(body), name)
  );
}

export function hasToolDefinition(body: Record<string, unknown>, name: string) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const dynamicTools = Array.isArray(body.dynamicTools) ? body.dynamicTools : [];
  return [...tools, ...dynamicTools].some((tool) => toolDefinitionMentionsName(tool, name));
}

function toolDefinitionMentionsName(value: unknown, name: string, depth = 0): boolean {
  if (depth > 6 || !value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => toolDefinitionMentionsName(item, name, depth + 1));
  }
  const record = value as Record<string, unknown>;
  for (const key of ["name", "tool", "functionName"]) {
    if (record[key] === name) {
      return true;
    }
  }
  return Object.values(record).some((item) => toolDefinitionMentionsName(item, name, depth + 1));
}

function instructionTextMentionsToolName(text: string, name: string) {
  if (!text) {
    return false;
  }
  const escapedName = escapeRegExp(name);
  return new RegExp(`(^|[^A-Za-z0-9_])${escapedName}([^A-Za-z0-9_]|$)`).test(text);
}

export function isQaToolSearchFixture(text: string) {
  return QA_TOOL_SEARCH_PROMPT_RE.test(text) || QA_TOOL_SEARCH_FAILURE_PROMPT_RE.test(text);
}

// Per-turn send-budget fixture: keep emitting `message`/`conversations_send` to one
// target across continuation rounds until `count` sends have been planned this turn,
// then finalize with plain text. Lets an e2e prove the per-turn send ledger (nudge +
// hard cap) at the real delivery boundary, since the ledger keys on the agent run.
// Marker `QA-PTSB-SEND` is unique to that fixture, so this never affects other prompts.
//
// Optional `outcomes=` maps each planned send (1-based) to a delivery shape: `ok`
// sends a visible `${marker}-${sequence}` payload; `suppress` sends an empty message
// so real core delivery returns deliveryStatus "suppressed" (no_visible_payload). This
// lets an e2e prove a delivered-nothing send does not charge the budget at the real
// boundary. Absent `outcomes`, every planned send is `ok`.
export function extractPerTurnSendBudgetDirective(text: string): {
  tool: "message" | "conversations_send";
  count: number;
  marker: string;
  ref?: string;
  outcomes?: ("ok" | "suppress")[];
} | null {
  const match =
    /QA-PTSB-SEND\s+tool=(message|conversations_send)\s+count=(\d+)\s+marker=([A-Za-z0-9._-]+)(?:\s+ref=(conv_[a-f0-9]{32}))?(?:\s+outcomes=([a-z,]+))?/u.exec(
      text,
    );
  if (!match) {
    return null;
  }
  const count = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(count) || count < 1) {
    return null;
  }
  // Capture group 1 is the alternation `(message|conversations_send)`; narrow by comparison instead of an unsound cast.
  const tool = match[1] === "conversations_send" ? "conversations_send" : "message";
  // conversations_send cannot be planned without a concrete conversationRef to target.
  if (tool === "conversations_send" && !match[4]) {
    return null;
  }
  const outcomes = match[5]
    ?.split(",")
    .map((token) => token.trim())
    .filter((token): token is "ok" | "suppress" => token === "ok" || token === "suppress");
  return {
    tool,
    count,
    marker: match[3] ?? "QA-PTSB",
    ...(match[4] ? { ref: match[4] } : {}),
    ...(outcomes && outcomes.length > 0 ? { outcomes } : {}),
  };
}

// Per-turn send-budget REPEAT fixture: unlike QA-PTSB-SEND (one send per
// continuation round), this makes the model emit the SAME `message` send TWICE
// inside ONE response — byte-identical arguments, but each copy carrying a
// distinct call_id and item id (the Responses transport rejects a repeated
// tool-call identity, so identical ids would throw before dispatch). Because the
// message-tool idempotency key folds in the tool-call id, the two copies derive
// DIFFERENT idempotency keys despite the identical payload and run as two distinct
// sends; under a per-turn cap the second is cap-blocked
// ("turn_send_budget_exhausted"), not admitted as an idempotent replay. Lets an
// e2e prove the cap-block path (not idempotent admission) at the real delivery
// boundary. Marker `QA-PTSB-REPEAT` is unique to this fixture.
export function extractPerTurnSendBudgetRepeatDirective(text: string): { marker: string } | null {
  const match = /QA-PTSB-REPEAT\s+tool=message\s+marker=([A-Za-z0-9._-]+)/u.exec(text);
  if (!match) {
    return null;
  }
  return { marker: match[1] ?? "QA-PTSB-REPEAT" };
}

export function buildExplicitSessionsSpawnArgs(text: string): Record<string, unknown> | null {
  if (!/\bsessions_spawn\b/i.test(text)) {
    return null;
  }
  const task = extractQuotedToolArg(text, "task");
  if (!task) {
    return null;
  }
  const label = extractQuotedToolArg(text, "label") ?? extractBareToolArg(text, "label");
  const mode = extractBareToolArg(text, "mode")?.toLowerCase();
  const context = extractBareToolArg(text, "context")?.toLowerCase();
  return {
    task,
    ...(label ? { label } : {}),
    ...(extractBareToolArg(text, "thread")?.toLowerCase() === "true" ? { thread: true } : {}),
    ...(mode === "session" || mode === "run" ? { mode } : {}),
    ...(context === "fork" || context === "isolated" ? { context } : {}),
  };
}

export function buildQaA2aMessageToolMirrorSessionsSendArgs(
  text: string,
): Record<string, unknown> | null {
  if (!QA_A2A_MESSAGE_TOOL_MIRROR_PROMPT_RE.test(text)) {
    return null;
  }
  const sessionKey =
    extractQuotedToolArg(text, "sessionKey") ?? extractBareToolArg(text, "sessionKey");
  if (!sessionKey) {
    return null;
  }
  const marker =
    extractExactMarkerDirective(text) ??
    extractExactReplyDirective(text) ??
    "QA-A2A-MESSAGE-TOOL-MIRROR-OK";
  return {
    sessionKey,
    message: `qa group visible reply tool check. Use the visible room reply path. exact marker: \`${marker}\``,
    timeoutSeconds: 0,
  };
}

export function extractToolErrorForNamedCall(params: {
  input: ResponsesInputItem[];
  name: string;
  toolJson: Record<string, unknown> | null;
}) {
  const error = typeof params.toolJson?.error === "string" ? params.toolJson.error.trim() : "";
  if (!error) {
    return undefined;
  }
  const namedFunctionCall = params.input.some(
    (item) => item.type === "function_call" && item.name === params.name,
  );
  if (namedFunctionCall) {
    return error;
  }
  return undefined;
}

export function hasToolErrorOutput(toolJson: Record<string, unknown> | null, toolOutput: string) {
  if (typeof toolJson?.error === "string" && toolJson.error.trim()) {
    return true;
  }
  if (
    typeof toolJson?.status === "string" &&
    /\b(?:error|failed|failure)\b/i.test(toolJson.status)
  ) {
    return true;
  }
  return /\b(?:error|failed|failure|not found|no such file|enoent)\b/i.test(toolOutput);
}

export function extractSessionStatusSessionKey(
  toolJson: Record<string, unknown> | null,
  toolOutput: string,
) {
  const details = toolJson?.details;
  if (details && typeof details === "object") {
    const sessionKey = (details as { sessionKey?: unknown }).sessionKey;
    if (typeof sessionKey === "string" && sessionKey.trim()) {
      return sessionKey.trim();
    }
  }
  const topLevelSessionKey = toolJson?.sessionKey;
  if (typeof topLevelSessionKey === "string" && topLevelSessionKey.trim()) {
    return topLevelSessionKey.trim();
  }
  const statusLineSessionKey = /(?:^|\n)[^\n]*Session:\s*([^\s•\n]+)/u.exec(toolOutput)?.[1];
  if (statusLineSessionKey?.trim()) {
    return statusLineSessionKey.trim();
  }
  return /"sessionKey"\s*:\s*"([^"]+)"/.exec(toolOutput)?.[1]?.trim() ?? "";
}

export function resolveHeartbeatPromptReply(text: string): "HEARTBEAT_OK" | "NO_REPLY" | undefined {
  const trimmed = text.trim();
  if (!trimmed || /remember this fact/i.test(trimmed)) {
    return undefined;
  }
  if (/(?:^|\n)Read HEARTBEAT\.md if it exists\b/i.test(trimmed)) {
    return "HEARTBEAT_OK";
  }
  return /(?:^|[.\n]\s*)If nothing needs attention, reply NO_REPLY\b/i.test(trimmed)
    ? "NO_REPLY"
    : undefined;
}

export function readFirstMediaPath(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const media = value as {
    mediaUrl?: unknown;
    mediaUrls?: unknown;
    path?: unknown;
    filePath?: unknown;
    attachments?: unknown;
  };
  for (const candidate of [media.mediaUrl, media.path, media.filePath]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  if (Array.isArray(media.mediaUrls)) {
    const mediaUrl = media.mediaUrls.find(
      (candidate) => typeof candidate === "string" && candidate.trim(),
    );
    if (typeof mediaUrl === "string" && mediaUrl.trim()) {
      return mediaUrl.trim();
    }
  }
  if (Array.isArray(media.attachments)) {
    for (const attachment of media.attachments) {
      const mediaPath = readFirstMediaPath(attachment);
      if (mediaPath) {
        return mediaPath;
      }
    }
  }
  return "";
}

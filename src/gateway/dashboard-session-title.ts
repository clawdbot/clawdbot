import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
// Dashboard session titles use the shared utility-model completion path.
import { generateConversationLabel } from "../auto-reply/reply/conversation-label-generator.js";
import { updateSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";

const DASHBOARD_SESSION_TITLE_MAX_CHARS = 60;
const DASHBOARD_SESSION_TITLE_SOURCE_MAX_CHARS = 1_000;
const DASHBOARD_SESSION_TITLE_PROMPT =
  "Generate a concise session title (3-6 words, max 60 characters) from the user's first message. Use the same language as the message. No emoji. Return only the title.";

// One title request per first turn. Concurrent sends cannot race duplicate model
// calls or metadata writes while the initial agent run advances session state.
const dashboardTitleRequests = new Set<string>();

function hasExplicitSessionName(entry: SessionEntry | undefined): boolean {
  return Boolean(
    entry?.label?.trim() ||
    entry?.displayName?.trim() ||
    entry?.subject?.trim() ||
    entry?.origin?.label?.trim(),
  );
}

function isDashboardSessionKey(sessionKey: string): boolean {
  return parseAgentSessionKey(sessionKey)?.rest.startsWith("dashboard:") === true;
}

export function isDashboardSessionTitleCandidate(params: {
  sessionKey: string;
  userMessage: string;
}): boolean {
  const sourceText = params.userMessage.trim();
  return Boolean(
    sourceText && !sourceText.startsWith("/") && isDashboardSessionKey(params.sessionKey),
  );
}

function normalizeDashboardSessionTitle(raw: string): string | null {
  const firstLine = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("```"));
  if (!firstLine) {
    return null;
  }
  const unwrapped = firstLine.replace(/^\s*(?:title\s*:\s*)?/i, "").replace(/^["'`]+|["'`]+$/g, "");
  const normalized = unwrapped.replace(/\s+/g, " ").trim();
  return normalized ? truncateUtf16Safe(normalized, DASHBOARD_SESSION_TITLE_MAX_CHARS) : null;
}

export async function maybeGenerateDashboardSessionTitle(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry: SessionEntry | undefined;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  userMessage: string;
}): Promise<boolean> {
  const sourceText = params.userMessage.trim();
  if (
    !isDashboardSessionTitleCandidate({
      sessionKey: params.sessionKey,
      userMessage: sourceText,
    }) ||
    hasExplicitSessionName(params.entry) ||
    params.entry?.systemSent === true ||
    params.entry?.sessionId !== params.sessionId
  ) {
    return false;
  }

  const requestKey = `${params.storePath}\0${params.sessionKey}\0${params.sessionId}`;
  if (dashboardTitleRequests.has(requestKey)) {
    return false;
  }
  dashboardTitleRequests.add(requestKey);
  try {
    const generated = await generateConversationLabel({
      userMessage: truncateUtf16Safe(sourceText, DASHBOARD_SESSION_TITLE_SOURCE_MAX_CHARS),
      prompt: DASHBOARD_SESSION_TITLE_PROMPT,
      cfg: params.cfg,
      agentId: params.agentId,
      maxLength: DASHBOARD_SESSION_TITLE_MAX_CHARS,
    });
    const displayName = generated ? normalizeDashboardSessionTitle(generated) : null;
    if (!displayName) {
      return false;
    }

    let persisted = false;
    await updateSessionEntry(
      {
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
      (current) => {
        if (current.sessionId !== params.sessionId || hasExplicitSessionName(current)) {
          return null;
        }
        persisted = true;
        return { displayName };
      },
      { requireWriteSuccess: true },
    );
    return persisted;
  } finally {
    dashboardTitleRequests.delete(requestKey);
  }
}

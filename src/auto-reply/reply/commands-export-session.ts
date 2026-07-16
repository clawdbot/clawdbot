// Builds export bundles for a session transcript and runtime context.
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readAcpSessionMetaForEntry } from "../../acp/runtime/session-meta.js";
import {
  migrateSessionEntries,
  type FileEntry as SessionFileEntry,
  type SessionEntry as AgentSessionEntry,
  type SessionHeader,
  type SessionMessageEntry,
} from "../../agents/sessions/session-manager.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { scanSessionTranscriptTree } from "../../config/sessions/transcript-tree.js";
import type { SessionEntry as StoredSessionEntry } from "../../config/sessions/types.js";
import { FsSafeError } from "../../infra/fs-safe.js";
import type { ReplyPayload } from "../types.js";
import {
  isReplyPayload,
  parseExportCommandOutputPath,
  resolveExportCommandSessionTarget,
} from "./commands-export-common.js";
import { writeSessionExportFile } from "./commands-export-session-file.js";
import { resolveCommandsSystemPromptBundle } from "./commands-system-prompt.js";
import type { HandleCommandsParams } from "./commands-types.js";

// Export HTML templates are bundled with this module
const EXPORT_HTML_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "export-html");

interface SessionData {
  header: SessionHeader | null;
  entries: AgentSessionEntry[];
  leafId: string | null;
  hasLeafControl: boolean;
  systemPrompt?: string;
  tools?: Array<{ name: string; description?: string; parameters?: unknown }>;
  warning?: string;
}

const BACKEND_DELEGATED_WARNING =
  "This session was handled by a backend runtime (e.g. CLI/ACP). Assistant replies, tool calls, and usage data are stored in the backend transcript and are not included in this export.";

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasBackendSession(entry: StoredSessionEntry, hasStoredAcpSession: boolean): boolean {
  return (
    hasStoredAcpSession ||
    hasNonEmptyString(entry.claudeCliSessionId) ||
    Object.values(entry.cliSessionBindings ?? {}).some((binding) =>
      hasNonEmptyString(binding?.sessionId),
    ) ||
    Object.values(entry.cliSessionIds ?? {}).some(hasNonEmptyString)
  );
}

function hasPersistedAcpSession(params: {
  sessionKey: string;
  entry: StoredSessionEntry;
}): boolean {
  if (params.entry.acp) {
    return true;
  }
  try {
    return Boolean(readAcpSessionMetaForEntry(params));
  } catch {
    return false;
  }
}

function isBackendDelegatedSession(
  entry: StoredSessionEntry,
  entries: AgentSessionEntry[],
  hasStoredAcpSession: boolean,
): boolean {
  if (!hasBackendSession(entry, hasStoredAcpSession)) {
    return false;
  }
  if (entries.length === 0) {
    return false;
  }
  const messages = entries.filter(
    (transcriptEntry): transcriptEntry is SessionMessageEntry => transcriptEntry.type === "message",
  );
  return (
    messages.length > 0 &&
    messages.every((transcriptEntry) => transcriptEntry.message.role === "user")
  );
}

type SessionExportEventWarning = {
  code: "invalid-session-row";
  row: number;
};

type SessionExportWarningSummary = {
  code: "invalid-session-json" | "invalid-session-row";
  count: number;
  rows: number[];
};

async function loadTemplate(fileName: string): Promise<string> {
  return await fsp.readFile(path.join(EXPORT_HTML_DIR, fileName), "utf-8");
}

function replaceHtmlPlaceholder(template: string, name: string, value: string): string {
  let replaced = false;
  const placeholder = new RegExp(
    `(<(?:script|style)\\b(?=[^>]*\\bdata-openclaw-export-placeholder="${name}")[^>]*>)(</(?:script|style)>)`,
  );
  const next = template.replace(
    placeholder,
    (_match: string, openTag: string, closeTag: string) => {
      replaced = true;
      const finalOpenTag = openTag.replace(/\sdata-openclaw-export-placeholder="[^"]*"/, "");
      return `${finalOpenTag}${value}${closeTag}`;
    },
  );
  if (!replaced) {
    throw new Error(`Export HTML template missing ${name} placeholder`);
  }
  return next;
}

async function generateHtml(sessionData: SessionData): Promise<string> {
  const [template, templateCss, templateJs, markedJs, hljsJs] = await Promise.all([
    loadTemplate("template.html"),
    loadTemplate("template.css"),
    loadTemplate("template.js"),
    loadTemplate(path.join("vendor", "marked.min.js")),
    loadTemplate(path.join("vendor", "highlight.min.js")),
  ]);

  // Use the bundled dark session-export palette
  const themeVars = `
    --cyan: #00d7ff;
    --blue: #5f87ff;
    --green: #b5bd68;
    --red: #cc6666;
    --yellow: #ffff00;
    --gray: #808080;
    --dimGray: #666666;
    --darkGray: #505050;
    --accent: #8abeb7;
    --selectedBg: #3a3a4a;
    --userMsgBg: #343541;
    --toolPendingBg: #282832;
    --toolSuccessBg: #283228;
    --toolErrorBg: #3c2828;
    --customMsgBg: #2d2838;
    --text: #e0e0e0;
    --dim: #666666;
    --muted: #808080;
    --border: #5f87ff;
    --borderAccent: #00d7ff;
    --borderMuted: #505050;
    --success: #b5bd68;
    --error: #cc6666;
    --warning: #ffff00;
    --thinkingText: #808080;
    --userMessageBg: #343541;
    --userMessageText: #e0e0e0;
    --customMessageBg: #2d2838;
    --customMessageText: #e0e0e0;
    --customMessageLabel: #9575cd;
    --toolTitle: #e0e0e0;
    --toolOutput: #808080;
    --mdHeading: #f0c674;
    --mdLink: #81a2be;
    --mdLinkUrl: #666666;
    --mdCode: #8abeb7;
    --mdCodeBlock: #b5bd68;
  `;
  const bodyBg = "#1e1e28";
  const containerBg = "#282832";
  const infoBg = "#343541";

  // Base64 encode session data
  const sessionDataBase64 = Buffer.from(JSON.stringify(sessionData)).toString("base64");

  // Build CSS with theme variables
  const css = templateCss
    .replace("/* {{THEME_VARS}} */", themeVars.trim())
    .replace("/* {{BODY_BG_DECL}} */", `--body-bg: ${bodyBg};`)
    .replace("/* {{CONTAINER_BG_DECL}} */", `--container-bg: ${containerBg};`)
    .replace("/* {{INFO_BG_DECL}} */", `--info-bg: ${infoBg};`);

  return [
    ["CSS", css],
    ["SESSION_DATA", sessionDataBase64],
    ["MARKED_JS", markedJs],
    ["HIGHLIGHT_JS", hljsJs],
    ["JS", templateJs],
  ].reduce(
    (html, [name, value]) =>
      replaceHtmlPlaceholder(
        html,
        expectDefined(name, "commands export session name"),
        expectDefined(value, "commands export session value"),
      ),
    template,
  );
}

function isSessionFileEntry(value: unknown): value is SessionFileEntry {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }
  if (value.type !== "message") {
    return true;
  }
  const message = value.message;
  return isRecord(message) && typeof message.role === "string";
}

function filterSessionEntriesWithWarnings(events: unknown[]): {
  entries: SessionFileEntry[];
  warnings: SessionExportEventWarning[];
} {
  const entries: SessionFileEntry[] = [];
  const warnings: SessionExportEventWarning[] = [];
  for (const [index, event] of events.entries()) {
    if (isSessionFileEntry(event)) {
      entries.push(event);
      continue;
    }
    warnings.push({ code: "invalid-session-row", row: index + 1 });
  }
  return { entries, warnings };
}

function summarizeSessionExportWarnings(
  warnings: SessionExportEventWarning[],
): SessionExportWarningSummary[] {
  const summaries = new Map<SessionExportEventWarning["code"], SessionExportWarningSummary>();
  for (const warning of warnings) {
    const summary = summaries.get(warning.code);
    if (summary) {
      summary.count += 1;
      if (summary.rows.length < 20) {
        summary.rows.push(warning.row);
      }
      continue;
    }
    summaries.set(warning.code, {
      code: warning.code,
      count: 1,
      rows: [warning.row],
    });
  }
  return [...summaries.values()];
}

function formatSkippedRows(count: number): string {
  return `${count.toLocaleString()} malformed transcript ${count === 1 ? "row" : "rows"}`;
}

function formatSessionExportWarning(summary: SessionExportWarningSummary): string {
  const rows = summary.rows.length > 0 ? ` rows ${summary.rows.join(", ")}` : "";
  const verb = summary.count === 1 ? "was" : "were";
  switch (summary.code) {
    case "invalid-session-json":
      return `⚠️ Skipped ${formatSkippedRows(summary.count)} that ${verb} not valid JSON.${rows}`;
    case "invalid-session-row":
      return summary.count === 1
        ? `⚠️ Skipped ${formatSkippedRows(summary.count)} that was not a session entry.${rows}`
        : `⚠️ Skipped ${formatSkippedRows(summary.count)} that were not session entries.${rows}`;
  }
  const unreachable: never = summary.code;
  return unreachable;
}

async function readSessionDataFromIdentity(params: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<{
  header: SessionHeader | null;
  entries: AgentSessionEntry[];
  leafId: string | null;
  hasLeafControl: boolean;
  warnings: SessionExportWarningSummary[];
}> {
  const events = await loadTranscriptEvents(params);
  const { entries, warnings } = filterSessionEntriesWithWarnings(events);
  return readSessionDataFromEntries(entries, summarizeSessionExportWarnings(warnings));
}

function readSessionDataFromEntries(
  fileEntries: SessionFileEntry[],
  warnings: SessionExportWarningSummary[],
): {
  header: SessionHeader | null;
  entries: AgentSessionEntry[];
  leafId: string | null;
  hasLeafControl: boolean;
  warnings: SessionExportWarningSummary[];
} {
  migrateSessionEntries(fileEntries);
  const header =
    fileEntries.find((entry): entry is SessionHeader => entry.type === "session") ?? null;
  const rawEntries = fileEntries.filter(
    (entry): entry is AgentSessionEntry => entry.type !== "session",
  );
  const tree = scanSessionTranscriptTree(rawEntries);
  const hasLeafControl = tree.hasLeafControl;
  const entries = hasLeafControl
    ? rawEntries.map((entry) => {
        const node = tree.byId.get(entry.id);
        return node && entry.parentId !== node.parentId
          ? ({ ...entry, parentId: node.parentId } as AgentSessionEntry)
          : entry;
      })
    : rawEntries;
  return {
    header,
    entries,
    leafId: tree.leafId,
    hasLeafControl,
    warnings,
  };
}

export async function buildExportSessionReply(params: HandleCommandsParams): Promise<ReplyPayload> {
  const args = parseExportCommandOutputPath(params.command.commandBodyNormalized, [
    "export-session",
    "export",
  ]);
  if (args.error) {
    return { text: args.error };
  }
  const sessionTarget = resolveExportCommandSessionTarget(params);
  if (isReplyPayload(sessionTarget)) {
    return sessionTarget;
  }
  const { entry } = sessionTarget;

  // Active exports run after startup migration, so SQLite rows are canonical.
  // Do not read sessionFile here; a SQLite marker is an identifier, not a path.
  const { entries, header, leafId, hasLeafControl, warnings } = await readSessionDataFromIdentity({
    agentId: sessionTarget.agentId,
    sessionId: sessionTarget.sessionId,
    sessionKey: sessionTarget.sessionKey,
    storePath: sessionTarget.storePath,
  });

  // 3. Build full system prompt
  const { systemPrompt, tools } = await resolveCommandsSystemPromptBundle({
    ...params,
    sessionEntry: entry as HandleCommandsParams["sessionEntry"],
  });

  // 4. Prepare session data
  const hasStoredAcpSession = hasPersistedAcpSession({
    sessionKey: params.sessionKey,
    entry,
  });
  const backendWarning = isBackendDelegatedSession(entry, entries, hasStoredAcpSession)
    ? BACKEND_DELEGATED_WARNING
    : undefined;
  const sessionData: SessionData = {
    header,
    entries,
    leafId,
    hasLeafControl,
    systemPrompt,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
    warning: backendWarning,
  };

  // 5. Generate HTML
  const html = await generateHtml(sessionData);

  // 6. Determine output path
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const defaultFileName = `openclaw-session-${entry.sessionId.slice(0, 8)}-${timestamp}.html`;
  let displayPath: string;
  try {
    const written = await writeSessionExportFile({
      workspaceDir: params.workspaceDir,
      requestedPath: args.outputPath,
      defaultFileName,
      contents: html,
    });
    displayPath = written.displayPath;
  } catch (error) {
    if (error instanceof FsSafeError && error.category === "policy") {
      return { text: "❌ Output path must be a regular file inside the workspace." };
    }
    throw error;
  }

  return {
    text: [
      "✅ Session exported!",
      "",
      `📄 File: ${displayPath}`,
      `📊 Entries: ${entries.length}`,
      ...warnings.map(formatSessionExportWarning),
      ...(backendWarning ? [`⚠️ ${backendWarning}`] : []),
      `🧠 System prompt: ${systemPrompt.length.toLocaleString()} chars`,
      `🔧 Tools: ${tools.length}`,
    ].join("\n"),
  };
}

import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  migrateSessionEntries,
  type FileEntry as PiSessionFileEntry,
  type SessionEntry as PiSessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { pathExists } from "../../infra/fs-safe.js";
import type { ReplyPayload } from "../types.js";
import {
  isReplyPayload,
  parseExportCommandOutputPath,
  resolveExportCommandSessionTarget,
} from "./commands-export-common.js";
import { resolveCommandsSystemPromptBundle } from "./commands-system-prompt.js";
import type { HandleCommandsParams } from "./commands-types.js";

// Export HTML templates are bundled with this module
const EXPORT_HTML_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "export-html");

interface SessionData {
  header: SessionHeader | null;
  entries: PiSessionEntry[];
  leafId: string | null;
  systemPrompt?: string;
  tools?: Array<{ name: string; description?: string; parameters?: unknown }>;
}

type SessionExportJsonlWarning = {
  code: "invalid-session-json" | "invalid-session-row";
  row: number;
};

type SessionExportWarningSummary = {
  code: SessionExportJsonlWarning["code"];
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

  // Use pi-mono dark theme colors (matching their theme/dark.json)
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
  ].reduce((html, [name, value]) => replaceHtmlPlaceholder(html, name, value), template);
}

function addCollisionSuffix(filePath: string, suffix: number): string {
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);
  return path.join(path.dirname(filePath), `${baseName}-${suffix}${ext}`);
}

async function writeNewDefaultExportFile(filePath: string, html: string): Promise<string> {
  for (let suffix = 1; suffix <= 100; suffix++) {
    const candidate = suffix === 1 ? filePath : addCollisionSuffix(filePath, suffix);
    try {
      await fsp.writeFile(candidate, html, { encoding: "utf-8", flag: "wx" });
      return candidate;
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && error.code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Could not find an unused export filename near ${filePath}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSessionFileEntry(value: unknown): value is PiSessionFileEntry {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }
  if (value.type !== "message") {
    return true;
  }
  const message = value.message;
  return isRecord(message) && typeof message.role === "string";
}

function parseSessionEntriesWithWarnings(content: string): {
  entries: PiSessionFileEntry[];
  warnings: SessionExportJsonlWarning[];
} {
  const entries: PiSessionFileEntry[] = [];
  const warnings: SessionExportJsonlWarning[] = [];
  const rows = content.split(/\r?\n/u);
  for (const [index, rawLine] of rows.entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isSessionFileEntry(parsed)) {
        warnings.push({ code: "invalid-session-row", row: index + 1 });
        continue;
      }
      entries.push(parsed);
    } catch {
      warnings.push({ code: "invalid-session-json", row: index + 1 });
    }
  }
  return { entries, warnings };
}

function summarizeSessionExportWarnings(
  warnings: SessionExportJsonlWarning[],
): SessionExportWarningSummary[] {
  const summaries = new Map<SessionExportJsonlWarning["code"], SessionExportWarningSummary>();
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

async function readSessionDataFromTranscript(sessionFile: string): Promise<{
  header: SessionHeader | null;
  entries: PiSessionEntry[];
  leafId: string | null;
  warnings: SessionExportWarningSummary[];
}> {
  const raw = await fsp.readFile(sessionFile, "utf-8");
  const { entries: fileEntries, warnings } = parseSessionEntriesWithWarnings(raw);
  migrateSessionEntries(fileEntries);
  const header =
    fileEntries.find((entry): entry is SessionHeader => entry.type === "session") ?? null;
  const entries = fileEntries.filter((entry): entry is PiSessionEntry => entry.type !== "session");
  const lastEntry = entries.at(-1);
  const leafId = typeof lastEntry?.id === "string" ? lastEntry.id : null;
  return { header, entries, leafId, warnings: summarizeSessionExportWarnings(warnings) };
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
  const { entry, sessionFile } = sessionTarget;

  if (!(await pathExists(sessionFile))) {
    return { text: `❌ Session file not found: ${sessionFile}` };
  }

  // 2. Load session entries
  const { entries, header, leafId, warnings } = await readSessionDataFromTranscript(sessionFile);

  // 3. Build full system prompt
  const { systemPrompt, tools } = await resolveCommandsSystemPromptBundle({
    ...params,
    sessionEntry: entry as HandleCommandsParams["sessionEntry"],
  });

  // 4. Prepare session data
  const sessionData: SessionData = {
    header,
    entries,
    leafId,
    systemPrompt,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  };

  // 5. Generate HTML
  const html = await generateHtml(sessionData);

  // 6. Determine output path
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const defaultFileName = `openclaw-session-${entry.sessionId.slice(0, 8)}-${timestamp}.html`;
  let outputPath = args.outputPath
    ? path.resolve(
        args.outputPath.startsWith("~")
          ? args.outputPath.replace("~", process.env.HOME ?? "")
          : args.outputPath,
      )
    : path.join(params.workspaceDir, defaultFileName);

  // Ensure directory exists
  const outputDir = path.dirname(outputPath);
  await fsp.mkdir(outputDir, { recursive: true });

  // 7. Write file
  if (args.outputPath) {
    await fsp.writeFile(outputPath, html, "utf-8");
  } else {
    outputPath = await writeNewDefaultExportFile(outputPath, html);
  }

  const relativePath = path.relative(params.workspaceDir, outputPath);
  const displayPath = relativePath.startsWith("..") ? outputPath : relativePath;

  return {
    text: [
      "✅ Session exported!",
      "",
      `📄 File: ${displayPath}`,
      `📊 Entries: ${entries.length}`,
      ...warnings.map(formatSessionExportWarning),
      `🧠 System prompt: ${systemPrompt.length.toLocaleString()} chars`,
      `🔧 Tools: ${tools.length}`,
    ].join("\n"),
  };
}

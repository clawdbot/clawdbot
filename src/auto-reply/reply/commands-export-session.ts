import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEntry as PiSessionEntry, SessionHeader } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
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

function loadTemplate(fileName: string): string {
  return fs.readFileSync(path.join(EXPORT_HTML_DIR, fileName), "utf-8");
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

function generateHtml(sessionData: SessionData): string {
  const template = loadTemplate("template.html");
  const templateCss = loadTemplate("template.css");
  const templateJs = loadTemplate("template.js");
  const markedJs = loadTemplate(path.join("vendor", "marked.min.js"));
  const hljsJs = loadTemplate(path.join("vendor", "highlight.min.js"));

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

  if (!fs.existsSync(sessionFile)) {
    return { text: `❌ Session file not found: ${sessionFile}` };
  }

  // 2. Load session entries
  const sessionManager = SessionManager.open(sessionFile);
  const entries = sessionManager.getEntries();
  const header = sessionManager.getHeader();
  const leafId = sessionManager.getLeafId();

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
  const html = generateHtml(sessionData);

  // 6. Determine output path
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const defaultFileName = `openclaw-session-${entry.sessionId.slice(0, 8)}-${timestamp}.html`;
  const outputPath = args.outputPath
    ? path.resolve(
        args.outputPath.startsWith("~")
          ? args.outputPath.replace("~", process.env.HOME ?? "")
          : args.outputPath,
      )
    : path.join(params.workspaceDir, defaultFileName);

  // Ensure directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // 7. Write file
  fs.writeFileSync(outputPath, html, "utf-8");

  const relativePath = path.relative(params.workspaceDir, outputPath);
  const displayPath = relativePath.startsWith("..") ? outputPath : relativePath;

  return {
    text: [
      "✅ Session exported!",
      "",
      `📄 File: ${displayPath}`,
      `📊 Entries: ${entries.length}`,
      `🧠 System prompt: ${systemPrompt.length.toLocaleString()} chars`,
      `🔧 Tools: ${tools.length}`,
    ].join("\n"),
  };
}

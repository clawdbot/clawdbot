// Tool execution component renders tool call status and output in the TUI.
import { Box, Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatToolDetail, resolveToolDisplay } from "../../agents/tool-display.js";
import { markdownTheme, tuiTheme as theme } from "../theme/theme.js";
import * as tuiFormatters from "../tui-formatters.js";
import { HyperlinkMarkdown } from "./hyperlink-markdown.js";

// Rendering model for live tool calls in the chat log.
type ToolResultContent = {
  type?: string;
  text?: string;
  mimeType?: string;
  bytes?: number;
  omitted?: boolean;
};

type ToolResult = {
  content?: ToolResultContent[];
  details?: Record<string, unknown>;
};

const PREVIEW_LINES = 12;
const MAX_PREVIEW_CHARS = PREVIEW_LINES * 256;

// Bound the actual wrapped Markdown, not just source newlines: a single long
// tool-output line can otherwise produce thousands of rows and stall the TUI.
class ToolOutputComponent extends HyperlinkMarkdown {
  private sourceText = "";
  private renderedSource: string | undefined;
  private expanded = false;

  override setText(text: string): void {
    const sourceText = tuiFormatters.sanitizeMarkdownSource(text);
    if (this.sourceText === sourceText) {
      return;
    }
    this.sourceText = sourceText;
    this.renderedSource = undefined;
    super.invalidate();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) {
      return;
    }
    this.expanded = expanded;
    this.renderedSource = undefined;
    super.invalidate();
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const previewBudget = Math.min(MAX_PREVIEW_CHARS, PREVIEW_LINES * Math.max(1, safeWidth));
    const text = this.expanded
      ? this.sourceText
      : truncateUtf16Safe(this.sourceText, previewBudget);

    if (this.renderedSource !== text) {
      super.setText(text);
      this.renderedSource = text;
    }

    const lines = super.render(safeWidth);
    if (
      this.expanded ||
      (text.length === this.sourceText.length && lines.length <= PREVIEW_LINES)
    ) {
      return lines;
    }
    return [...lines.slice(0, PREVIEW_LINES - 1), truncateToWidth("…", safeWidth, "")];
  }
}

// Prefer curated display summaries, then fall back to sanitized JSON args.
function formatArgs(detail: string | undefined, args: unknown): string {
  if (detail) {
    return tuiFormatters.sanitizeRenderableText(detail);
  }
  if (!args || typeof args !== "object") {
    return "";
  }
  try {
    return tuiFormatters.sanitizeRenderableText(JSON.stringify(args));
  } catch {
    return "";
  }
}

// Extracts visible text and compact media placeholders from tool result payloads.
function extractText(result?: ToolResult): string {
  if (!result?.content) {
    return "";
  }
  const lines: string[] = [];
  for (const entry of result.content) {
    if (entry.type === "text" && entry.text) {
      lines.push(entry.text);
    } else if (entry.type === "image") {
      const mime = entry.mimeType ?? "image";
      const size = entry.bytes ? ` ${Math.round(entry.bytes / 1024)}kb` : "";
      const omitted = entry.omitted ? " (omitted)" : "";
      lines.push(`[${mime}${size}${omitted}]`);
    }
  }
  return lines.join("\n");
}

/** Displays a running or completed tool call with optional expandable output. */
export class ToolExecutionComponent extends Container {
  private box: Box;
  private header: Text;
  private argsLine: Text;
  private output: ToolOutputComponent;
  private toolName: string;
  private title = "";
  private isPartial = true;

  constructor(toolName: string, args: unknown) {
    super();
    this.toolName = toolName;
    this.box = new Box(1, 1, theme.toolPendingBg);
    this.header = new Text("", 0, 0);
    this.argsLine = new Text("", 0, 0);
    this.output = new ToolOutputComponent("", 0, 0, markdownTheme, {
      color: (line) => theme.toolOutput(line),
    });
    this.addChild(new Spacer(1));
    this.addChild(this.box);
    this.box.addChild(this.header);
    this.box.addChild(this.argsLine);
    this.box.addChild(this.output);
    this.setArgs(args);
    this.setPartialResult(undefined);
  }

  /** Re-renders tool arguments when streaming tool call input changes. */
  setArgs(args: unknown) {
    const display = resolveToolDisplay({ name: this.toolName, args });
    this.title = `${display.emoji} ${display.label}`;
    this.refreshTitle();
    const argLine = formatArgs(formatToolDetail(display), args);
    this.argsLine.setText(argLine ? theme.dim(argLine) : theme.dim(" "));
  }

  /** Toggles preview/full output rendering for long tool results. */
  setExpanded(expanded: boolean) {
    this.output.setExpanded(expanded);
  }

  /** Marks the tool call complete and renders final output. */
  setResult(result: ToolResult | undefined, opts?: { isError?: boolean }) {
    this.updateResult(result, false, Boolean(opts?.isError));
  }

  /** Renders partial output while the tool call is still running. */
  setPartialResult(result: ToolResult | undefined) {
    this.updateResult(result, true);
  }

  private refreshTitle() {
    const title = tuiFormatters.sanitizeRenderableLine(
      `${this.title}${this.isPartial ? " (running)" : ""}`,
    );
    this.header.setText(theme.toolTitle(theme.bold(title)));
  }

  private updateResult(result: ToolResult | undefined, isPartial: boolean, isError = false) {
    if (this.isPartial !== isPartial) {
      this.isPartial = isPartial;
      this.refreshTitle();
    }
    this.box.setBgFn(
      isPartial ? theme.toolPendingBg : isError ? theme.toolErrorBg : theme.toolSuccessBg,
    );
    const raw = extractText(result);
    this.output.setText(raw.trim() ? raw : isPartial ? "…" : "");
  }
}

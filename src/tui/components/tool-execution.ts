// Tool execution component renders tool call status and output in the TUI.
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { formatToolDetail, resolveToolDisplay } from "../../agents/tool-display.js";
import { markdownTheme, theme } from "../theme/theme.js";
import { sanitizeRenderableText } from "../tui-formatters.js";

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

// Prefer curated display summaries, then fall back to sanitized JSON args.
function formatArgs(toolName: string, args: unknown): string {
  const display = resolveToolDisplay({ name: toolName, args });
  const detail = formatToolDetail(display);
  if (detail) {
    return sanitizeRenderableText(detail);
  }
  if (!args || typeof args !== "object") {
    return "";
  }
  try {
    return sanitizeRenderableText(JSON.stringify(args));
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
      lines.push(sanitizeRenderableText(entry.text));
    } else if (entry.type === "image") {
      const mime = entry.mimeType ?? "image";
      const size = entry.bytes ? ` ${Math.round(entry.bytes / 1024)}kb` : "";
      const omitted = entry.omitted ? " (omitted)" : "";
      lines.push(`[${mime}${size}${omitted}]`);
    }
  }
  return lines.join("\n").trim();
}

/** Displays a running or completed tool call with optional expandable output. */
export class ToolExecutionComponent extends Container {
  private box: Box;
  private header: Text;
  private argsLine: Text;
  private output: Markdown;
  private toolName: string;
  private args: unknown;
  private result?: ToolResult;
  private expanded = false;
  private isError = false;
  private isPartial = true;

  constructor(toolName: string, args: unknown) {
    super();
    this.toolName = toolName;
    this.args = args;
    this.box = new Box(1, 1, (line) => theme.toolPendingBg(line));
    this.header = new Text("", 0, 0);
    this.argsLine = new Text("", 0, 0);
    this.output = new Markdown("", 0, 0, markdownTheme, {
      color: (line) => theme.toolOutput(line),
    });
    this.addChild(new Spacer(1));
    this.addChild(this.box);
    this.box.addChild(this.header);
    this.box.addChild(this.argsLine);
    this.box.addChild(this.output);
    this.refresh();
  }

  /** Re-renders tool arguments when streaming tool call input changes. */
  setArgs(args: unknown) {
    this.args = args;
    this.refresh();
  }

  /** Toggles preview/full output rendering for long tool results. */
  setExpanded(expanded: boolean) {
    this.expanded = expanded;
    this.refresh();
  }

  /** Marks the tool call complete and renders final output. */
  setResult(result: ToolResult | undefined, opts?: { isError?: boolean }) {
    this.result = result;
    this.isPartial = false;
    this.isError = Boolean(opts?.isError);
    this.refresh();
  }

  /** Renders partial output while the tool call is still running. */
  setPartialResult(result: ToolResult | undefined) {
    this.result = result;
    this.isPartial = true;
    this.refresh();
  }

  private refresh() {
    const bg = this.isPartial
      ? theme.toolPendingBg
      : this.isError
        ? theme.toolErrorBg
        : theme.toolSuccessBg;
    this.box.setBgFn((line) => bg(line));

    const display = resolveToolDisplay({
      name: this.toolName,
      args: this.args,
    });
    const title = `${display.emoji} ${display.label}${this.isPartial ? " (running)" : ""}`;
    this.header.setText(theme.toolTitle(theme.bold(title)));

    const argLine = formatArgs(this.toolName, this.args);
    this.argsLine.setText(argLine ? theme.dim(argLine) : theme.dim(" "));

    const raw = extractText(this.result);
    const text = raw || (this.isPartial ? "…" : "");
    if (!this.expanded && text) {
      const lines = text.split("\n");
      const preview =
        lines.length > PREVIEW_LINES ? `${lines.slice(0, PREVIEW_LINES).join("\n")}\n…` : text;
      this.output.setText(preview);
    } else {
      this.output.setText(text);
    }
  }
}

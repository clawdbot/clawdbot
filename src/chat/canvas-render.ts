// Renders chat canvas payloads into text and metadata for transcript output.
import { expectDefined, safeParseJson } from "@openclaw/normalization-core";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { parseFenceSpans } from "../../packages/markdown-core/src/fences.js";

// Extracts assistant-message canvas previews from tool JSON or markdown embed
// shortcodes. The returned text strips consumed shortcodes for channel delivery.
type CanvasSurface = "assistant_message";
type CanvasSandbox = "strict" | "scripts";

type McpAppPreviewDescriptor = {
  viewId: string;
  serverName?: string;
  toolName?: string;
  uiResourceUri?: string;
  toolCallId?: string;
  resultMetaState?: "unavailable";
};

type CanvasPreview = {
  kind: "canvas";
  surface: CanvasSurface;
  render: "url";
  title?: string;
  preferredHeight?: number;
  url?: string;
  viewId?: string;
  className?: string;
  style?: string;
  sandbox?: CanvasSandbox;
  mcpApp?: McpAppPreviewDescriptor;
};

function getRecordStringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getRecordNumberField(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return asFiniteNumber(value);
}

function getNestedRecord(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key];
  return asOptionalRecord(value);
}

function coerceMcpAppDescriptor(
  record: Record<string, unknown> | undefined,
): McpAppPreviewDescriptor | undefined {
  const viewId = getRecordStringField(record, "viewId");
  if (!viewId || viewId.length > 128) {
    return undefined;
  }
  const serverName = getRecordStringField(record, "serverName");
  const toolName = getRecordStringField(record, "toolName");
  const uiResourceUri = getRecordStringField(record, "uiResourceUri");
  const toolCallId = getRecordStringField(record, "toolCallId");
  const resultMetaState = record?.resultMetaState === "unavailable" ? "unavailable" : undefined;
  const hasCompleteDescriptor = Boolean(
    serverName &&
    serverName.length <= 256 &&
    toolName &&
    toolName.length <= 256 &&
    uiResourceUri?.startsWith("ui://") &&
    uiResourceUri.length <= 2048 &&
    toolCallId &&
    toolCallId.length <= 512,
  );
  return hasCompleteDescriptor
    ? {
        viewId,
        serverName,
        toolName,
        uiResourceUri,
        toolCallId,
        ...(resultMetaState ? { resultMetaState } : {}),
      }
    : { viewId };
}

function normalizeSurface(value: string | undefined): CanvasSurface | undefined {
  return value === "assistant_message" ? value : undefined;
}

function normalizeSandbox(value: string | undefined): CanvasSandbox | undefined {
  return value === "strict" || value === "scripts" ? value : undefined;
}

function normalizePreferredHeight(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 160
    ? Math.min(Math.trunc(value), 1200)
    : undefined;
}

function coerceCanvasPreview(
  record: Record<string, unknown> | undefined,
): CanvasPreview | undefined {
  if (!record) {
    return undefined;
  }
  const kind = getRecordStringField(record, "kind")?.trim().toLowerCase();
  if (kind !== "canvas") {
    return undefined;
  }
  const presentation = getNestedRecord(record, "presentation");
  const view = getNestedRecord(record, "view");
  const source = getNestedRecord(record, "source");
  const mcpAppRecord = getNestedRecord(record, "mcpApp");
  const mcpApp = coerceMcpAppDescriptor(mcpAppRecord);
  const mcpAppViewId = mcpApp?.viewId;
  const requestedSurface =
    getRecordStringField(presentation, "target") ?? getRecordStringField(record, "target");
  const surface = requestedSurface ? normalizeSurface(requestedSurface) : "assistant_message";
  if (!surface) {
    return undefined;
  }
  const title = getRecordStringField(presentation, "title") ?? getRecordStringField(view, "title");
  const preferredHeight = normalizePreferredHeight(
    getRecordNumberField(presentation, "preferred_height") ??
      getRecordNumberField(presentation, "preferredHeight") ??
      getRecordNumberField(view, "preferred_height") ??
      getRecordNumberField(view, "preferredHeight"),
  );
  const className =
    getRecordStringField(presentation, "class_name") ??
    getRecordStringField(presentation, "className");
  const style = getRecordStringField(presentation, "style");
  const sandbox = normalizeSandbox(getRecordStringField(presentation, "sandbox"));
  const viewUrl = getRecordStringField(view, "url") ?? getRecordStringField(view, "entryUrl");
  const viewId = getRecordStringField(view, "id") ?? getRecordStringField(view, "docId");
  if (mcpAppViewId && viewId === mcpAppViewId) {
    return {
      kind: "canvas",
      surface,
      render: "url",
      viewId,
      ...(title ? { title } : {}),
      ...(preferredHeight ? { preferredHeight } : {}),
      ...(sandbox ? { sandbox } : {}),
      mcpApp,
    };
  }
  if (viewUrl) {
    return {
      kind: "canvas",
      surface,
      render: "url",
      url: viewUrl,
      ...(viewId ? { viewId } : {}),
      ...(title ? { title } : {}),
      ...(preferredHeight ? { preferredHeight } : {}),
      ...(className ? { className } : {}),
      ...(style ? { style } : {}),
      ...(sandbox ? { sandbox } : {}),
      ...(mcpApp ? { mcpApp } : {}),
    };
  }
  const sourceType = getRecordStringField(source, "type")?.trim().toLowerCase();
  if (sourceType === "url") {
    const url = getRecordStringField(source, "url");
    if (!url) {
      return undefined;
    }
    return {
      kind: "canvas",
      surface,
      render: "url",
      url,
      ...(title ? { title } : {}),
      ...(preferredHeight ? { preferredHeight } : {}),
      ...(className ? { className } : {}),
      ...(style ? { style } : {}),
      ...(sandbox ? { sandbox } : {}),
      ...(mcpApp ? { mcpApp } : {}),
    };
  }
  return undefined;
}

/** Extracts an MCP App Canvas preview from sanitized tool-result details. */
export function extractCanvasFromDetails(value: unknown): CanvasPreview | undefined {
  const details = asOptionalRecord(value);
  return coerceCanvasPreview(asOptionalRecord(details?.mcpAppPreview));
}

function parseCanvasAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const key = match[1]?.trim().toLowerCase();
    const value = (match[2] ?? match[3] ?? "").trim();
    if (key && value) {
      attrs[key] = value;
    }
  }
  return attrs;
}

function defaultCanvasEntryUrl(ref: string): string {
  const encoded = encodeURIComponent(ref.trim());
  return `/__openclaw__/canvas/documents/${encoded}/index.html`;
}

function previewFromShortcode(attrs: Record<string, string>): CanvasPreview | undefined {
  if (attrs.target && normalizeSurface(attrs.target) !== "assistant_message") {
    return undefined;
  }
  const surface = "assistant_message";
  const title = attrs.title?.trim() || undefined;
  const preferredHeight =
    attrs.height && Number.isFinite(Number(attrs.height))
      ? normalizePreferredHeight(Number(attrs.height))
      : undefined;
  const className = attrs.class?.trim() || attrs.class_name?.trim() || undefined;
  const style = attrs.style?.trim() || undefined;
  const ref = attrs.ref?.trim();
  const url = attrs.url?.trim();
  if (url || ref) {
    return {
      kind: "canvas",
      surface,
      render: "url",
      url: url ?? defaultCanvasEntryUrl(expectDefined(ref, "canvas reference")),
      ...(ref ? { viewId: ref } : {}),
      ...(title ? { title } : {}),
      ...(preferredHeight ? { preferredHeight } : {}),
      ...(className ? { className } : {}),
      ...(style ? { style } : {}),
    };
  }
  return undefined;
}

/** Extracts a canvas preview from a JSON-shaped tool or assistant payload. */
export function extractCanvasFromText(
  outputText: string | undefined,
  _toolName?: string,
): CanvasPreview | undefined {
  const parsed = outputText ? asOptionalRecord(safeParseJson(outputText)) : undefined;
  return coerceCanvasPreview(parsed);
}

/** Extracts [embed ...] shortcodes outside code fences and returns stripped text. */
export function extractCanvasShortcodes(text: string | undefined): {
  text: string;
  previews: CanvasPreview[];
} {
  if (!text?.trim() || !text.toLowerCase().includes("[embed")) {
    return { text: text ?? "", previews: [] };
  }
  const fenceSpans = parseFenceSpans(text);
  const matches: Array<{
    start: number;
    end: number;
    attrs: Record<string, string>;
    body?: string;
  }> = [];
  // Exclude a self-closing open tag ("[embed ... /]") from starting a block
  // match by requiring the attrs group not to end with a slash; otherwise the
  // block regex greedily swallows visible text up to a later stray [/embed].
  const blockRe = /\[embed\s+([^\]]*?[^\]/]|)\]([\s\S]*?)\[\/embed\]/gi;
  const selfClosingRe = /\[embed\s+([^\]]*?)\/\]/gi;
  for (const re of [blockRe, selfClosingRe]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      const start = match.index ?? 0;
      if (fenceSpans.some((span) => start >= span.start && start < span.end)) {
        // Literal embed examples in code blocks must remain visible text.
        continue;
      }
      matches.push({
        start,
        end: start + match[0].length,
        attrs: parseCanvasAttributes(match[1] ?? ""),
        ...(match[2] !== undefined ? { body: match[2] } : {}),
      });
    }
  }
  if (matches.length === 0) {
    return { text, previews: [] };
  }
  matches.sort((a, b) => a.start - b.start);
  const previews: CanvasPreview[] = [];
  let cursor = 0;
  let stripped = "";
  for (const match of matches) {
    if (match.start < cursor) {
      // Prefer the first non-overlapping shortcode so nested/overlapping input
      // cannot strip arbitrary text outside the matched span.
      continue;
    }
    stripped += text.slice(cursor, match.start);
    const preview = previewFromShortcode(match.attrs);
    if (!preview) {
      stripped += text.slice(match.start, match.end);
    } else {
      previews.push(preview);
    }
    cursor = match.end;
  }
  stripped += text.slice(cursor);
  return {
    text: stripped.replace(/\n{3,}/g, "\n\n").trim(),
    previews,
  };
}

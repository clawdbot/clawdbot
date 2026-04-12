import { parseFenceSpans } from "../markdown/fences.js";

export type CanvasSurface = "assistant_message";

export type CanvasPreview = {
  kind: "canvas";
  surface: CanvasSurface;
  render: "url";
  title?: string;
  preferredHeight?: number;
  url?: string;
  viewId?: string;
  className?: string;
  style?: string;
};

function tryParseJsonRecord(value: string | undefined): Record<string, unknown> | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

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
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getNestedRecord(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeSurface(value: string | undefined): CanvasSurface | undefined {
  return value === "assistant_message" ? value : undefined;
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
  const viewUrl = getRecordStringField(view, "url") ?? getRecordStringField(view, "entryUrl");
  const viewId = getRecordStringField(view, "id") ?? getRecordStringField(view, "docId");
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
    };
  }
  return undefined;
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
      url: url ?? defaultCanvasEntryUrl(ref),
      ...(ref ? { viewId: ref } : {}),
      ...(title ? { title } : {}),
      ...(preferredHeight ? { preferredHeight } : {}),
      ...(className ? { className } : {}),
      ...(style ? { style } : {}),
    };
  }
  return undefined;
}

export function extractCanvasFromText(
  outputText: string | undefined,
  _toolName?: string,
): CanvasPreview | undefined {
  const parsed = tryParseJsonRecord(outputText);
  return coerceCanvasPreview(parsed);
}

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
  const blockRe = /\[embed\s+([^\]]*?)\]([\s\S]*?)\[\/embed\]/gi;
  const selfClosingRe = /\[embed\s+([^\]]*?)\/\]/gi;
  for (const re of [blockRe, selfClosingRe]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      const start = match.index ?? 0;
      if (fenceSpans.some((span) => start >= span.start && start < span.end)) {
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

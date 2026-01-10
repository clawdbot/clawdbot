import { visibleWidth } from "./ansi.js";

type Align = "left" | "right" | "center";

export type TableColumn = {
  key: string;
  header: string;
  align?: Align;
  minWidth?: number;
  maxWidth?: number;
  flex?: boolean;
};

export type RenderTableOptions = {
  columns: TableColumn[];
  rows: Array<Record<string, string>>;
  width?: number;
  padding?: number;
  border?: "unicode" | "ascii" | "none";
};

function repeat(ch: string, n: number): string {
  if (n <= 0) return "";
  return ch.repeat(n);
}

function padCell(text: string, width: number, align: Align): string {
  const w = visibleWidth(text);
  if (w >= width) return text;
  const pad = width - w;
  if (align === "right") return `${repeat(" ", pad)}${text}`;
  if (align === "center") {
    const left = Math.floor(pad / 2);
    const right = pad - left;
    return `${repeat(" ", left)}${text}${repeat(" ", right)}`;
  }
  return `${text}${repeat(" ", pad)}`;
}

function wrapLine(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const words = text.split(/(\s+)/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  const push = (value: string) => lines.push(value.replace(/\s+$/, ""));

  const flush = () => {
    if (current.trim().length === 0) return;
    push(current);
    current = "";
    currentWidth = 0;
  };

  const breakLong = (word: string) => {
    const parts: string[] = [];
    let buf = "";
    let lastBreakAt = 0;
    const isBreakChar = (ch: string) =>
      ch === "/" || ch === "-" || ch === "_" || ch === ".";
    for (const ch of Array.from(word)) {
      const next = buf + ch;
      if (visibleWidth(next) > width && buf) {
        if (lastBreakAt > 0) {
          parts.push(buf.slice(0, lastBreakAt));
          buf = `${buf.slice(lastBreakAt)}${ch}`;
          lastBreakAt = 0;
          for (let i = 0; i < buf.length; i += 1) {
            const c = buf[i];
            if (c && isBreakChar(c)) lastBreakAt = i + 1;
          }
        } else {
          parts.push(buf);
          buf = ch;
        }
      } else {
        buf = next;
        if (isBreakChar(ch)) lastBreakAt = buf.length;
      }
    }
    if (buf) parts.push(buf);
    return parts;
  };

  for (const token of words) {
    const tokenWidth = visibleWidth(token);
    const isSpace = /^\s+$/.test(token);

    if (tokenWidth > width && !isSpace) {
      flush();
      for (const part of breakLong(token.replace(/^\s+/, ""))) {
        push(part);
      }
      continue;
    }

    if (
      currentWidth + tokenWidth > width &&
      current.trim().length > 0 &&
      !isSpace
    ) {
      flush();
    }

    current += token;
    currentWidth = visibleWidth(current);
  }

  flush();
  return lines.length ? lines : [""];
}

function normalizeWidth(n: number | undefined): number | undefined {
  if (n == null) return undefined;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

export function renderTable(opts: RenderTableOptions): string {
  const border = opts.border ?? "unicode";
  if (border === "none") {
    const columns = opts.columns;
    const header = columns.map((c) => c.header).join(" | ");
    const lines = [
      header,
      ...opts.rows.map((r) => columns.map((c) => r[c.key] ?? "").join(" | ")),
    ];
    return `${lines.join("\n")}\n`;
  }

  const padding = Math.max(0, opts.padding ?? 1);
  const columns = opts.columns;

  const metrics = columns.map((c) => {
    const headerW = visibleWidth(c.header);
    const cellW = Math.max(
      0,
      ...opts.rows.map((r) => visibleWidth(r[c.key] ?? "")),
    );
    return { headerW, cellW };
  });

  const widths = columns.map((c, i) => {
    const m = metrics[i];
    const base = Math.max(m?.headerW ?? 0, m?.cellW ?? 0) + padding * 2;
    const capped = c.maxWidth ? Math.min(base, c.maxWidth) : base;
    return Math.max(c.minWidth ?? 3, capped);
  });

  const maxWidth = normalizeWidth(opts.width);
  const sepCount = columns.length + 1;
  const total = widths.reduce((a, b) => a + b, 0) + sepCount;

  const preferredMinWidths = columns.map((c, i) =>
    Math.max(c.minWidth ?? 3, (metrics[i]?.headerW ?? 0) + padding * 2, 3),
  );
  const absoluteMinWidths = columns.map((_c, i) =>
    Math.max((metrics[i]?.headerW ?? 0) + padding * 2, 3),
  );

  if (maxWidth && total > maxWidth) {
    let over = total - maxWidth;

    const flexOrder = columns
      .map((_c, i) => ({ i, w: widths[i] ?? 0 }))
      .filter(({ i }) => Boolean(columns[i]?.flex))
      .sort((a, b) => b.w - a.w)
      .map((x) => x.i);

    const nonFlexOrder = columns
      .map((_c, i) => ({ i, w: widths[i] ?? 0 }))
      .filter(({ i }) => !columns[i]?.flex)
      .sort((a, b) => b.w - a.w)
      .map((x) => x.i);

    const shrink = (order: number[], minWidths: number[]) => {
      while (over > 0) {
        let progressed = false;
        for (const i of order) {
          if ((widths[i] ?? 0) <= (minWidths[i] ?? 0)) continue;
          widths[i] = (widths[i] ?? 0) - 1;
          over -= 1;
          progressed = true;
          if (over <= 0) break;
        }
        if (!progressed) break;
      }
    };

    // Prefer shrinking flex columns; only shrink non-flex if necessary.
    // If required to fit, allow flex columns to shrink below user minWidth
    // down to their absolute minimum (header + padding).
    shrink(flexOrder, preferredMinWidths);
    shrink(flexOrder, absoluteMinWidths);
    shrink(nonFlexOrder, preferredMinWidths);
    shrink(nonFlexOrder, absoluteMinWidths);
  }

  // If we have room and any flex columns, expand them to fill the available width.
  // This keeps tables from looking "clipped" and reduces wrapping in wide terminals.
  if (maxWidth) {
    const sepCount = columns.length + 1;
    const currentTotal = widths.reduce((a, b) => a + b, 0) + sepCount;
    let extra = maxWidth - currentTotal;
    if (extra > 0) {
      const flexCols = columns
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => Boolean(c.flex))
        .map(({ i }) => i);
      if (flexCols.length > 0) {
        const caps = columns.map((c) =>
          typeof c.maxWidth === "number" && c.maxWidth > 0
            ? Math.floor(c.maxWidth)
            : Number.POSITIVE_INFINITY,
        );
        while (extra > 0) {
          let progressed = false;
          for (const i of flexCols) {
            if ((widths[i] ?? 0) >= (caps[i] ?? Number.POSITIVE_INFINITY))
              continue;
            widths[i] = (widths[i] ?? 0) + 1;
            extra -= 1;
            progressed = true;
            if (extra <= 0) break;
          }
          if (!progressed) break;
        }
      }
    }
  }

  const box =
    border === "ascii"
      ? {
          tl: "+",
          tr: "+",
          bl: "+",
          br: "+",
          h: "-",
          v: "|",
          t: "+",
          ml: "+",
          m: "+",
          mr: "+",
          b: "+",
        }
      : {
          tl: "┌",
          tr: "┐",
          bl: "└",
          br: "┘",
          h: "─",
          v: "│",
          t: "┬",
          ml: "├",
          m: "┼",
          mr: "┤",
          b: "┴",
        };

  const hLine = (left: string, mid: string, right: string) =>
    `${left}${widths.map((w) => repeat(box.h, w)).join(mid)}${right}`;

  const contentWidthFor = (i: number) => Math.max(1, widths[i] - padding * 2);
  const padStr = repeat(" ", padding);

  const renderRow = (record: Record<string, string>, isHeader = false) => {
    const cells = columns.map((c) =>
      isHeader ? c.header : (record[c.key] ?? ""),
    );
    const wrapped = cells.map((cell, i) => wrapLine(cell, contentWidthFor(i)));
    const height = Math.max(...wrapped.map((w) => w.length));
    const out: string[] = [];
    for (let li = 0; li < height; li += 1) {
      const parts = wrapped.map((lines, i) => {
        const raw = lines[li] ?? "";
        const aligned = padCell(
          raw,
          contentWidthFor(i),
          columns[i]?.align ?? "left",
        );
        return `${padStr}${aligned}${padStr}`;
      });
      out.push(`${box.v}${parts.join(box.v)}${box.v}`);
    }
    return out;
  };

  const lines: string[] = [];
  lines.push(hLine(box.tl, box.t, box.tr));
  lines.push(...renderRow({}, true));
  lines.push(hLine(box.ml, box.m, box.mr));
  for (const row of opts.rows) {
    lines.push(...renderRow(row, false));
  }
  lines.push(hLine(box.bl, box.b, box.br));
  return `${lines.join("\n")}\n`;
}

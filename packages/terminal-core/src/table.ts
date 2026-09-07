import { iterateAnsiSegments } from "./ansi-sequences.js";
import { splitGraphemes, truncateToVisibleWidth, visibleWidth } from "./ansi.js";
import { createDisplayStringFormatter } from "./display-string.js";
import { sanitizeTerminalText } from "./safe-text.js";

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

function resolveDefaultBorder(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): "unicode" | "ascii" {
  if (platform !== "win32") {
    return "unicode";
  }

  const term = env.TERM ?? "";
  const termProgram = env.TERM_PROGRAM ?? "";
  const isModernTerminal =
    Boolean(env.WT_SESSION) ||
    term.includes("xterm") ||
    term.includes("cygwin") ||
    term.includes("msys") ||
    termProgram === "vscode";

  return isModernTerminal ? "unicode" : "ascii";
}

function repeat(ch: string, n: number): string {
  if (n <= 0) {
    return "";
  }
  return ch.repeat(n);
}

function padCell(text: string, width: number, align: Align): string {
  // A single grapheme wider than the cell (e.g. a width-2 CJK/emoji glyph in a
  // width-1 column) survives wrapLine intact, so clamp here to keep every cell
  // exactly `width` columns and preserve the border-alignment invariant.
  const textWidth = visibleWidth(text);
  const content = textWidth > width ? truncateToVisibleWidth(text, width) : text;
  const w = content === text ? textWidth : visibleWidth(content);
  if (w >= width) {
    return content;
  }
  const pad = width - w;
  if (align === "right") {
    return `${repeat(" ", pad)}${content}`;
  }
  if (align === "center") {
    const left = Math.floor(pad / 2);
    const right = pad - left;
    return `${repeat(" ", left)}${content}${repeat(" ", right)}`;
  }
  return `${content}${repeat(" ", pad)}`;
}

const ESC = "\u001b";
const C1_CSI = "\u009b";
const C1_OSC = "\u009d";
const C1_ST = "\u009c";
const BEL = "\u0007";
const SGR_CONTROL_CHARS_REGEX = new RegExp(String.raw`[\u0000-\u001f\u007f]`, "g");

type AnsiToken = { kind: "ansi" | "char"; value: string; width: number };

// Keep this order when closing and reopening styles at cell wrap boundaries.
const SGR_CATEGORIES = [
  { category: "font", reset: 10, codes: [11, 12, 13, 14, 15, 16, 17, 18, 19] },
  { category: "intensity", reset: 22, codes: [1, 2] },
  { category: "italic", reset: 23, codes: [3, 20] },
  { category: "underline", reset: 24, codes: [4, 21] },
  { category: "underlineColor", reset: 59, codes: [] },
  { category: "blink", reset: 25, codes: [5, 6] },
  { category: "inverse", reset: 27, codes: [7] },
  { category: "conceal", reset: 28, codes: [8] },
  { category: "strike", reset: 29, codes: [9] },
  { category: "proportional", reset: 50, codes: [26] },
  { category: "frame", reset: 54, codes: [51, 52] },
  { category: "overline", reset: 55, codes: [53] },
  { category: "ideogram", reset: 65, codes: [60, 61, 62, 63, 64] },
  { category: "script", reset: 75, codes: [73, 74] },
  {
    category: "foreground",
    reset: 39,
    codes: [30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97],
  },
  {
    category: "background",
    reset: 49,
    codes: [40, 41, 42, 43, 44, 45, 46, 47, 100, 101, 102, 103, 104, 105, 106, 107],
  },
] as const;

type SgrCategory = (typeof SGR_CATEGORIES)[number]["category"];

const SGR_RESET_CATEGORIES = new Map<number, SgrCategory>(
  SGR_CATEGORIES.map(({ category, reset }) => [reset, category]),
);
const SGR_SIMPLE_CATEGORIES = new Map<number, SgrCategory>(
  SGR_CATEGORIES.flatMap(({ category, codes }) => codes.map((code) => [code, category] as const)),
);

function extendedSgrCategory(param: number): SgrCategory | undefined {
  if (param === 38) {
    return "foreground";
  }
  if (param === 48) {
    return "background";
  }
  return param === 58 ? "underlineColor" : undefined;
}

function parseSgrSequence(value: string): { introducer: string; parameters: string } | undefined {
  let introducer: string;
  if (value.startsWith(`${ESC}[`) && value.endsWith("m")) {
    introducer = `${ESC}[`;
  } else if (value.startsWith(C1_CSI) && value.endsWith("m")) {
    introducer = C1_CSI;
  } else {
    return undefined;
  }
  // C0 and DEL execute separately inside CSI; exclude them only from stored SGR parameters.
  const parameters = value.slice(introducer.length, -1).replace(SGR_CONTROL_CHARS_REGEX, "");
  if (/[^0-9;:]/u.test(parameters)) {
    return undefined;
  }
  return { introducer, parameters };
}

function sgrSequence(introducer: string, parameters: string): string {
  return `${introducer}${parameters}m`;
}

function applySgrSequence(active: Map<SgrCategory, string>, value: string): void {
  const sequence = parseSgrSequence(value);
  if (!sequence) {
    return;
  }

  const fields = sequence.parameters === "" ? ["0"] : sequence.parameters.split(";");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? "";
    if (field.includes(":")) {
      const param = Number(field.slice(0, field.indexOf(":")));
      const category = extendedSgrCategory(param) ?? SGR_SIMPLE_CATEGORIES.get(param);
      if (category) {
        active.set(category, sgrSequence(sequence.introducer, field));
      }
      continue;
    }

    const param = field === "" ? 0 : Number(field);
    if (!Number.isInteger(param)) {
      continue;
    }
    if (param === 0) {
      active.clear();
      continue;
    }
    const resetCategory = SGR_RESET_CATEGORIES.get(param);
    if (resetCategory) {
      active.delete(resetCategory);
      continue;
    }

    const extendedCategory = extendedSgrCategory(param);
    if (extendedCategory) {
      const mode = Number(fields[index + 1]);
      const operandCount = mode === 2 ? 3 : mode === 5 ? 1 : undefined;
      const lastOperandIndex = operandCount === undefined ? -1 : index + 1 + operandCount;
      if (lastOperandIndex < index || lastOperandIndex >= fields.length) {
        break;
      }
      const parameters = fields.slice(index, lastOperandIndex + 1).join(";");
      active.set(extendedCategory, sgrSequence(sequence.introducer, parameters));
      index = lastOperandIndex;
      continue;
    }

    const category = SGR_SIMPLE_CATEGORIES.get(param);
    if (category) {
      active.set(category, sgrSequence(sequence.introducer, String(param)));
    }
  }
}

type Osc8Link = { params: string; uri: string };

function parseOsc8Sequence(value: string): Osc8Link | undefined {
  let payloadStart: number;
  if (value.startsWith(`${ESC}]`)) {
    payloadStart = 2;
  } else if (value.startsWith(C1_OSC)) {
    payloadStart = 1;
  } else {
    return undefined;
  }

  let terminatorLength: number;
  if (value.endsWith(`${ESC}\\`)) {
    terminatorLength = 2;
  } else if (value.endsWith(BEL) || value.endsWith(C1_ST)) {
    terminatorLength = 1;
  } else {
    return undefined;
  }

  const payload = value.slice(payloadStart, -terminatorLength);
  if (!payload.startsWith("8;")) {
    return undefined;
  }
  const uriSeparator = payload.indexOf(";", 2);
  if (uriSeparator < 0) {
    return undefined;
  }
  return {
    params: payload.slice(2, uriSeparator),
    uri: payload.slice(uriSeparator + 1),
  };
}

function wrapLine(text: string, width: number): string[] {
  if (width <= 0) {
    return [text];
  }
  // Fitting edge-trimmed ASCII is one column per code unit and needs no ANSI/grapheme scan.
  // Keep edge whitespace on the full path, where wrapping preserves its trimming semantics.
  if (text.length <= width && /^[!-~](?:[ -~]*[!-~])?$/u.test(text)) {
    return [text];
  }

  const lines: string[] = [];
  const isBreakChar = (ch: string) =>
    ch === " " || ch === "/" || ch === "-" || ch === "_" || ch === ".";
  let skipNextLf = false;
  let hasChar = false;

  const buf: AnsiToken[] = [];
  let bufVisible = 0;
  let lastBreakIndex: number | null = null;

  const pushLine = (value: string) => {
    const cleaned = value.replace(/\s+$/, "");
    if (visibleWidth(cleaned) === 0) {
      return;
    }
    lines.push(cleaned);
  };

  const flushAt = (breakAt: number | null) => {
    if (buf.length === 0) {
      return;
    }
    // Keep the suffix in its buffer: long zero-width runs can exceed the argument
    // limit of a spread-based copy even when their visible width is small.
    const left = breakAt == null || breakAt <= 0 ? buf : buf.splice(0, breakAt);
    // Only the emitted prefix determines continuation state; the buffered suffix
    // belongs to the next line.
    const content: string[] = [];
    const sgr = new Map<SgrCategory, string>();
    let activeOsc8: Osc8Link | undefined;
    for (const token of left) {
      content.push(token.value);
      if (token.kind !== "ansi") {
        continue;
      }
      applySgrSequence(sgr, token.value);
      const link = parseOsc8Sequence(token.value);
      if (link) {
        activeOsc8 = link.uri === "" ? undefined : link;
      }
    }
    const activeSgr = SGR_CATEGORIES.flatMap(({ category, reset }) => {
      const open = sgr.get(category);
      const parsed = open ? parseSgrSequence(open) : undefined;
      return open && parsed ? [{ close: sgrSequence(parsed.introducer, String(reset)), open }] : [];
    });
    const closeOsc8 = activeOsc8 ? `${ESC}]8;;${BEL}` : "";
    const openOsc8 = activeOsc8 ? `${ESC}]8;${activeOsc8.params};${activeOsc8.uri}${BEL}` : "";
    const closeSgr = activeSgr.map((state) => state.close).join("");

    pushLine(`${content.join("")}${closeOsc8}${closeSgr}`);
    if (breakAt == null || breakAt <= 0) {
      buf.length = 0;
      if (openOsc8) {
        buf.push({ kind: "ansi", value: openOsc8, width: 0 });
      }
      for (const state of activeSgr) {
        buf.push({ kind: "ansi", value: state.open, width: 0 });
      }
      bufVisible = 0;
      lastBreakIndex = null;
      return;
    }

    if (openOsc8) {
      buf.unshift({ kind: "ansi", value: openOsc8, width: 0 });
    }
    if (activeSgr.length > 0) {
      buf.unshift(
        ...activeSgr.map((state) => ({
          kind: "ansi" as const,
          value: state.open,
          width: 0,
        })),
      );
    }

    bufVisible = buf.reduce((acc, token) => acc + token.width, 0);
    lastBreakIndex = null;
  };

  const acceptToken = (token: AnsiToken) => {
    if (token.kind === "char") {
      hasChar = true;
      // Emit the one-cell space used by layout instead of following terminal tab stops.
      token.value = token.value.replaceAll("\t", " ");
      const ch = token.value;
      if (skipNextLf && ch === "\n") {
        skipNextLf = false;
        return;
      }
      // CRLF is one grapheme; separated CR/LF may retain intervening ANSI controls.
      skipNextLf = ch === "\r";
      if (ch === "\n" || ch === "\r" || ch === "\r\n") {
        flushAt(buf.length);
        return;
      }
      // Soft-wrap remainders reuse the width measured when each token entered the buffer.
      token.width = visibleWidth(ch);
    }
    if (bufVisible + token.width > width && bufVisible > 0) {
      flushAt(lastBreakIndex);
      if (bufVisible + token.width > width && bufVisible > 0) {
        flushAt(null);
      }
    }
    if (token.kind === "char" && bufVisible === 0 && token.value === " ") {
      return;
    }

    buf.push(token);
    bufVisible += token.width;
    if (token.kind === "char" && isBreakChar(token.value)) {
      lastBreakIndex = buf.length;
    }
  };

  // Consume tokens as they arrive; only the current wrap buffer owns them.
  // SGR/OSC-8 remain atomic and close before padding, then reopen on continuation.
  for (const segment of iterateAnsiSegments(text)) {
    let value = segment.value;
    if (segment.kind === "ansi") {
      if (segment.controls.includes("\t")) {
        // Reset with the CSI introducer before printable controls can enter pending escape parsing.
        acceptToken({
          kind: "ansi",
          value: value.slice(0, value[0] === ESC ? 2 : 1) + "\x18",
          width: 0,
        });
        const controls = new Set(segment.controls);
        for (const control of segment.controls) {
          acceptToken({ kind: control === "\t" ? "char" : "ansi", value: control, width: 0 });
        }
        value = Array.from(value)
          .filter((character) => !controls.has(character))
          .join("");
      }
      acceptToken({ kind: "ansi", value, width: 0 });
      continue;
    }
    for (const grapheme of splitGraphemes(value)) {
      acceptToken({ kind: "char", value: grapheme, width: 0 });
    }
  }

  if (!hasChar) {
    return [text];
  }

  flushAt(buf.length);
  return lines.length > 0 ? lines : [""];
}

function normalizeWidth(n: number | undefined): number | undefined {
  if (n == null) {
    return undefined;
  }
  if (!Number.isFinite(n) || n <= 0) {
    return undefined;
  }
  return Math.floor(n);
}

export function getTerminalTableWidth(minWidth = 60, fallbackWidth = 120): number {
  return Math.max(minWidth, process.stdout.columns ?? fallbackWidth);
}

/** Render untrusted single-line values without changing renderTable's trusted ANSI contract. */
export function renderTerminalSafeTable(opts: RenderTableOptions): string {
  return renderTable({
    ...opts,
    columns: opts.columns.map((column) => ({
      ...column,
      header: sanitizeTerminalText(column.header),
    })),
    rows: opts.rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, sanitizeTerminalText(value)]),
      ),
    ),
  });
}

export function renderTable(opts: RenderTableOptions): string {
  const displayString = createDisplayStringFormatter();
  const rows = opts.rows.map((row) => {
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      next[key] = displayString(value);
    }
    return next;
  });
  const border = opts.border ?? resolveDefaultBorder(process.platform, process.env);
  if (border === "none") {
    const columns = opts.columns;
    const header = columns.map((c) => c.header).join(" | ");
    const lines = [header, ...rows.map((r) => columns.map((c) => r[c.key] ?? "").join(" | "))];
    return `${lines.join("\n")}\n`;
  }

  const padding = Math.max(0, opts.padding ?? 1);
  const columns = opts.columns;

  const metrics = columns.map((c) => {
    const headerW = visibleWidth(c.header);
    const cellW = rows.reduce((max, row) => Math.max(max, visibleWidth(row[c.key] ?? "")), 0);
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

    const flexColumns = columns.flatMap((column, i) => (column.flex ? [i] : []));
    const nonFlexColumns = columns.flatMap((column, i) => (column.flex ? [] : [i]));

    const shrink = (indices: number[], minWidths: number[]) => {
      while (over > 0) {
        let widest: number | undefined;
        for (const i of indices) {
          if ((widths[i] ?? 0) <= (minWidths[i] ?? 0)) {
            continue;
          }
          // Water-fill from the widest eligible column. Strict comparison makes
          // equal-width ties deterministic: the leftmost column shrinks first.
          if (widest === undefined || (widths[i] ?? 0) > (widths[widest] ?? 0)) {
            widest = i;
          }
        }
        if (widest === undefined) {
          break;
        }
        widths[widest] = (widths[widest] ?? 0) - 1;
        over -= 1;
      }
    };

    // Prefer shrinking flex columns; only shrink non-flex if necessary.
    // If required to fit, allow flex columns to shrink below user minWidth
    // down to their absolute minimum (header + padding).
    shrink(flexColumns, preferredMinWidths);
    shrink(flexColumns, absoluteMinWidths);
    shrink(nonFlexColumns, preferredMinWidths);
    shrink(nonFlexColumns, absoluteMinWidths);
  }

  // If we have room and any flex columns, expand them to fill the available width.
  // This keeps tables from looking "clipped" and reduces wrapping in wide terminals.
  if (maxWidth) {
    const sepCountLocal = columns.length + 1;
    const currentTotal = widths.reduce((a, b) => a + b, 0) + sepCountLocal;
    let extra = maxWidth - currentTotal;
    if (extra > 0) {
      let flexCols = columns.flatMap((column, i) => (column.flex ? [i] : []));
      if (flexCols.length > 0) {
        const caps = columns.map((c) =>
          typeof c.maxWidth === "number" && c.maxWidth > 0
            ? Math.floor(c.maxWidth)
            : Number.POSITIVE_INFINITY,
        );
        while (extra > 0) {
          flexCols = flexCols.filter(
            (i) => (widths[i] ?? 0) < (caps[i] ?? Number.POSITIVE_INFINITY),
          );
          if (flexCols.length === 0) {
            break;
          }
          // Fractional additions can round at a cap, so retain their one-cell steps.
          // Complete integer rounds stop at the first cap; partial rounds keep column order.
          const rounds = flexCols.reduce(
            (amount, i) =>
              Number.isSafeInteger(widths[i])
                ? Math.min(amount, (caps[i] ?? Number.POSITIVE_INFINITY) - (widths[i] ?? 0))
                : 1,
            Number.isSafeInteger(maxWidth) && Number.isSafeInteger(extra)
              ? Math.max(1, Math.floor(extra / flexCols.length))
              : 1,
          );
          for (const i of flexCols) {
            const amount = Math.min(rounds, Math.ceil(extra));
            widths[i] = (widths[i] ?? 0) + amount;
            extra -= amount;
            if (extra <= 0) {
              break;
            }
          }
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

  const contentWidthFor = (i: number) => {
    const width = widths.at(i);
    if (width === undefined) {
      throw new Error(`expected table column width ${i} to be defined`);
    }
    return Math.max(1, width - padding * 2);
  };
  const padStr = repeat(" ", padding);

  const lines: string[] = [];
  const renderRow = (record: Record<string, string>, isHeader = false) => {
    const cells = columns.map((c) => (isHeader ? c.header : (record[c.key] ?? "")));
    const wrapped = cells.map((cell, i) => wrapLine(cell, contentWidthFor(i)));
    const height = Math.max(...wrapped.map((w) => w.length));
    for (let li = 0; li < height; li += 1) {
      const parts = wrapped.map((cellLines, i) => {
        const raw = cellLines[li] ?? "";
        const aligned = padCell(raw, contentWidthFor(i), columns[i]?.align ?? "left");
        return `${padStr}${aligned}${padStr}`;
      });
      lines.push(`${box.v}${parts.join(box.v)}${box.v}`);
    }
  };

  lines.push(hLine(box.tl, box.t, box.tr));
  renderRow({}, true);
  lines.push(hLine(box.ml, box.m, box.mr));
  for (const row of rows) {
    renderRow(row, false);
  }
  lines.push(hLine(box.bl, box.b, box.br));
  return `${lines.join("\n")}\n`;
}

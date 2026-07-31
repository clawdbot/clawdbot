// Terminal Core module implements table behavior.

import { splitAnsiSegments } from "./ansi-sequences.js";
import { splitGraphemes, truncateToVisibleWidth, visibleWidth } from "./ansi.js";
import { displayString } from "./display-string.js";

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
  const content = visibleWidth(text) > width ? truncateToVisibleWidth(text, width) : text;
  const w = visibleWidth(content);
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

type AnsiToken = { kind: "ansi"; value: string; width: number } | { kind: "char"; value: string };
type SgrCategory =
  | "background"
  | "blink"
  | "conceal"
  | "font"
  | "foreground"
  | "frame"
  | "ideogram"
  | "intensity"
  | "inverse"
  | "italic"
  | "overline"
  | "proportional"
  | "script"
  | "strike"
  | "underline"
  | "underlineColor";

const SGR_CATEGORY_ORDER: readonly SgrCategory[] = [
  "font",
  "intensity",
  "italic",
  "underline",
  "underlineColor",
  "blink",
  "inverse",
  "conceal",
  "strike",
  "proportional",
  "frame",
  "overline",
  "ideogram",
  "script",
  "foreground",
  "background",
];

const SGR_RESET_CATEGORIES = new Map<number, SgrCategory>([
  [10, "font"],
  [22, "intensity"],
  [23, "italic"],
  [24, "underline"],
  [25, "blink"],
  [27, "inverse"],
  [28, "conceal"],
  [29, "strike"],
  [39, "foreground"],
  [49, "background"],
  [50, "proportional"],
  [54, "frame"],
  [55, "overline"],
  [59, "underlineColor"],
  [65, "ideogram"],
  [75, "script"],
]);

const SGR_CATEGORY_RESETS = new Map<SgrCategory, number>([
  ["font", 10],
  ["intensity", 22],
  ["italic", 23],
  ["underline", 24],
  ["blink", 25],
  ["inverse", 27],
  ["conceal", 28],
  ["strike", 29],
  ["foreground", 39],
  ["background", 49],
  ["proportional", 50],
  ["frame", 54],
  ["overline", 55],
  ["underlineColor", 59],
  ["ideogram", 65],
  ["script", 75],
]);

function simpleSgrCategory(param: number): SgrCategory | undefined {
  if (param === 1 || param === 2) {
    return "intensity";
  }
  if (param >= 11 && param <= 19) {
    return "font";
  }
  if (param === 3 || param === 20) {
    return "italic";
  }
  if (param === 4 || param === 21) {
    return "underline";
  }
  if (param === 5 || param === 6) {
    return "blink";
  }
  if (param === 7) {
    return "inverse";
  }
  if (param === 8) {
    return "conceal";
  }
  if (param === 9) {
    return "strike";
  }
  if (param === 26) {
    return "proportional";
  }
  if ((param >= 30 && param <= 37) || (param >= 90 && param <= 97)) {
    return "foreground";
  }
  if ((param >= 40 && param <= 47) || (param >= 100 && param <= 107)) {
    return "background";
  }
  if (param === 51 || param === 52) {
    return "frame";
  }
  if (param === 53) {
    return "overline";
  }
  if (param >= 60 && param <= 64) {
    return "ideogram";
  }
  if (param === 73 || param === 74) {
    return "script";
  }
  return undefined;
}

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
  const parameters = Array.from(value.slice(introducer.length, -1))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join("");
  const hasOnlySgrParameters = Array.from(parameters).every(
    (character) => (character >= "0" && character <= "9") || character === ";" || character === ":",
  );
  if (!hasOnlySgrParameters) {
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
      const category = extendedSgrCategory(param) ?? simpleSgrCategory(param);
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

    const category = simpleSgrCategory(param);
    if (category) {
      active.set(category, sgrSequence(sequence.introducer, String(param)));
    }
  }
}

type ActiveSgr = { close: string; open: string };

function activeSgrAfter(tokens: readonly AnsiToken[]): ActiveSgr[] {
  const active = new Map<SgrCategory, string>();
  for (const token of tokens) {
    if (token.kind === "ansi") {
      applySgrSequence(active, token.value);
    }
  }
  return SGR_CATEGORY_ORDER.flatMap((category) => {
    const open = active.get(category);
    const parsed = open ? parseSgrSequence(open) : undefined;
    const reset = SGR_CATEGORY_RESETS.get(category);
    return open && parsed && reset !== undefined
      ? [{ close: sgrSequence(parsed.introducer, String(reset)), open }]
      : [];
  });
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

function activeOsc8After(tokens: readonly AnsiToken[]): Osc8Link | undefined {
  let active: Osc8Link | undefined;
  for (const token of tokens) {
    if (token.kind !== "ansi") {
      continue;
    }
    const link = parseOsc8Sequence(token.value);
    if (link) {
      active = link.uri === "" ? undefined : link;
    }
  }
  return active;
}

function wrapLine(text: string, width: number): string[] {
  if (width <= 0) {
    return [text];
  }

  // ANSI-aware wrapping: never split inside ANSI SGR/OSC-8 sequences.
  // Table cells are padded and bordered per physical line, so wrapped lines
  // must not leak styling into padding while the next continuation keeps it.
  const tokens: AnsiToken[] = [];
  for (const segment of splitAnsiSegments(text)) {
    if (segment.kind === "ansi") {
      tokens.push({
        kind: "ansi",
        value: segment.value,
        width: visibleWidth(segment.controls.join("")),
      });
      continue;
    }
    for (const grapheme of splitGraphemes(segment.value)) {
      tokens.push({ kind: "char", value: grapheme });
    }
  }

  if (!tokens.some((token) => token.kind === "char")) {
    return [text];
  }

  const lines: string[] = [];
  const isBreakChar = (ch: string) =>
    ch === " " || ch === "\t" || ch === "/" || ch === "-" || ch === "_" || ch === ".";
  const isSpaceChar = (ch: string) => ch === " " || ch === "\t";
  let skipNextLf = false;

  const buf: AnsiToken[] = [];
  let bufVisible = 0;
  let lastBreakIndex: number | null = null;

  const bufToString = (slice?: AnsiToken[]) => (slice ?? buf).map((t) => t.value).join("");

  const bufVisibleWidth = (slice: AnsiToken[]) =>
    slice.reduce(
      (acc, token) => acc + (token.kind === "char" ? visibleWidth(token.value) : token.width),
      0,
    );

  const pushLine = (value: string) => {
    const cleaned = value.replace(/\s+$/, "");
    if (visibleWidth(cleaned) === 0) {
      return;
    }
    lines.push(cleaned);
  };

  const trimLeadingSpaces = (tokensLocal: AnsiToken[]) => {
    while (true) {
      const firstCharIndexLocal = tokensLocal.findIndex((token) => token.kind === "char");
      if (firstCharIndexLocal < 0) {
        return;
      }
      const firstChar = tokensLocal[firstCharIndexLocal];
      if (!firstChar || !isSpaceChar(firstChar.value)) {
        return;
      }
      tokensLocal.splice(firstCharIndexLocal, 1);
    }
  };

  const flushAt = (breakAt: number | null) => {
    if (buf.length === 0) {
      return;
    }
    const left = breakAt == null || breakAt <= 0 ? buf : buf.slice(0, breakAt);
    const activeSgr = activeSgrAfter(left);
    const activeOsc8 = activeOsc8After(left);
    const closeOsc8 = activeOsc8 ? `${ESC}]8;;${BEL}` : "";
    const openOsc8 = activeOsc8 ? `${ESC}]8;${activeOsc8.params};${activeOsc8.uri}${BEL}` : "";
    const closeSgr = activeSgr.map((state) => state.close).join("");

    if (breakAt == null || breakAt <= 0) {
      pushLine(`${bufToString()}${closeOsc8}${closeSgr}`);
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

    const rest = buf.slice(breakAt);
    pushLine(`${bufToString(left)}${closeOsc8}${closeSgr}`);
    trimLeadingSpaces(rest);
    if (openOsc8) {
      rest.unshift({ kind: "ansi", value: openOsc8, width: 0 });
    }
    if (activeSgr.length > 0) {
      rest.unshift(
        ...activeSgr.map((state) => ({
          kind: "ansi" as const,
          value: state.open,
          width: 0,
        })),
      );
    }

    buf.length = 0;
    buf.push(...rest);
    bufVisible = bufVisibleWidth(buf);
    lastBreakIndex = null;
  };

  const makeRoomFor = (tokenWidth: number) => {
    if (bufVisible + tokenWidth <= width || bufVisible === 0) {
      return;
    }
    flushAt(lastBreakIndex);
    if (bufVisible + tokenWidth > width && bufVisible > 0) {
      flushAt(null);
    }
  };

  for (const token of tokens) {
    if (token.kind === "ansi") {
      makeRoomFor(token.width);
      buf.push(token);
      bufVisible += token.width;
      continue;
    }

    const ch = token.value;
    if (skipNextLf) {
      skipNextLf = false;
      if (ch === "\n") {
        continue;
      }
    }
    if (ch === "\n" || ch === "\r") {
      flushAt(buf.length);
      if (ch === "\r") {
        skipNextLf = true;
      }
      continue;
    }
    const charWidth = visibleWidth(ch);
    makeRoomFor(charWidth);
    if (bufVisible === 0 && isSpaceChar(ch)) {
      continue;
    }

    buf.push(token);
    bufVisible += charWidth;
    if (isBreakChar(ch)) {
      lastBreakIndex = buf.length;
    }
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

export function renderTable(opts: RenderTableOptions): string {
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
    const cellW = Math.max(0, ...rows.map((r) => visibleWidth(r[c.key] ?? "")));
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
      .toSorted((a, b) => b.w - a.w)
      .map((x) => x.i);

    const nonFlexOrder = columns
      .map((_c, i) => ({ i, w: widths[i] ?? 0 }))
      .filter(({ i }) => !columns[i]?.flex)
      .toSorted((a, b) => b.w - a.w)
      .map((x) => x.i);

    const shrink = (order: number[], minWidths: number[]) => {
      while (over > 0) {
        let progressed = false;
        for (const i of order) {
          if ((widths[i] ?? 0) <= (minWidths[i] ?? 0)) {
            continue;
          }
          widths[i] = (widths[i] ?? 0) - 1;
          over -= 1;
          progressed = true;
          if (over <= 0) {
            break;
          }
        }
        if (!progressed) {
          break;
        }
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
    const sepCountLocal = columns.length + 1;
    const currentTotal = widths.reduce((a, b) => a + b, 0) + sepCountLocal;
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
            if ((widths[i] ?? 0) >= (caps[i] ?? Number.POSITIVE_INFINITY)) {
              continue;
            }
            widths[i] = (widths[i] ?? 0) + 1;
            extra -= 1;
            progressed = true;
            if (extra <= 0) {
              break;
            }
          }
          if (!progressed) {
            break;
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

  const renderRow = (record: Record<string, string>, isHeader = false) => {
    const cells = columns.map((c) => (isHeader ? c.header : (record[c.key] ?? "")));
    const wrapped = cells.map((cell, i) => wrapLine(cell, contentWidthFor(i)));
    const height = Math.max(...wrapped.map((w) => w.length));
    const out: string[] = [];
    for (let li = 0; li < height; li += 1) {
      const parts = wrapped.map((lines, i) => {
        const raw = lines[li] ?? "";
        const aligned = padCell(raw, contentWidthFor(i), columns[i]?.align ?? "left");
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
  for (const row of rows) {
    lines.push(...renderRow(row, false));
  }
  lines.push(hLine(box.bl, box.b, box.br));
  return `${lines.join("\n")}\n`;
}

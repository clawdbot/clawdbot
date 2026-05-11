import crypto from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import type { SessionSystemPromptReport } from "../../config/sessions/types.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { estimateTokensFromChars } from "../../utils/cjk-chars.js";

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Rgba = {
  r: number;
  g: number;
  b: number;
  a: number;
};

type TreemapLeaf = {
  name: string;
  value: number;
};

type TreemapGroup = {
  name: string;
  value: number;
  color: Rgba;
  leaves: TreemapLeaf[];
};

type PositionedItem<T> = {
  item: T;
  rect: Rect;
};

type ContextTreemapSessionStats = {
  cachedContextTokens: number | null;
  contextWindowTokens: number | null;
};

const WIDTH = 1280;
const HEIGHT = 860;
const HEADER_HEIGHT = 88;
const FOOTER_HEIGHT = 54;
const LEGEND_WIDTH = 274;
const PADDING = 22;
const TREEMAP_GAP = 4;

const FONT: Record<string, string[]> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  _: ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00001", "00001", "00001", "00001", "10001", "10001", "01110"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
};

function rgba(r: number, g: number, b: number, a = 255): Rgba {
  return { r, g, b, a };
}

function mixColor(a: Rgba, b: Rgba, amount: number): Rgba {
  const t = Math.max(0, Math.min(1, amount));
  return rgba(
    a.r + (b.r - a.r) * t,
    a.g + (b.g - a.g) * t,
    a.b + (b.b - a.b) * t,
    a.a + (b.a - a.a) * t,
  );
}

function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatSize(value: number): string {
  return `${formatInt(value)} CH / ~${formatInt(estimateTokensFromChars(value))} TOK`;
}

function totalValue(items: Array<{ value: number }>): number {
  return items.reduce((sum, item) => sum + item.value, 0);
}

function sanitizeLabel(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9/_.:-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function truncateLabel(value: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 2) {
    return value.slice(0, maxChars);
  }
  return value.slice(0, maxChars - 1);
}

function layoutBinary<T extends { value: number }>(rawItems: T[], rect: Rect): PositionedItem<T>[] {
  const items = rawItems.filter((item) => item.value > 0).toSorted((a, b) => b.value - a.value);
  if (items.length === 0 || rect.width <= 0 || rect.height <= 0) {
    return [];
  }
  if (items.length === 1) {
    return [{ item: items[0], rect }];
  }
  const total = totalValue(items);
  let splitIndex = 1;
  let splitSum = items[0]?.value ?? 0;
  for (let i = 1; i < items.length - 1; i += 1) {
    const next = splitSum + items[i].value;
    if (Math.abs(total / 2 - next) > Math.abs(total / 2 - splitSum)) {
      break;
    }
    splitSum = next;
    splitIndex = i + 1;
  }
  const first = items.slice(0, splitIndex);
  const second = items.slice(splitIndex);
  const ratio = splitSum / total;
  if (rect.width >= rect.height) {
    const firstWidth = rect.width * ratio;
    return [
      ...layoutBinary(first, { ...rect, width: firstWidth }),
      ...layoutBinary(second, {
        x: rect.x + firstWidth,
        y: rect.y,
        width: rect.width - firstWidth,
        height: rect.height,
      }),
    ];
  }
  const firstHeight = rect.height * ratio;
  return [
    ...layoutBinary(first, { ...rect, height: firstHeight }),
    ...layoutBinary(second, {
      x: rect.x,
      y: rect.y + firstHeight,
      width: rect.width,
      height: rect.height - firstHeight,
    }),
  ];
}

class PngCanvas {
  readonly data = Buffer.alloc(WIDTH * HEIGHT * 4);

  fill(color: Rgba): void {
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = color.r;
      this.data[i + 1] = color.g;
      this.data[i + 2] = color.b;
      this.data[i + 3] = color.a;
    }
  }

  rect(rect: Rect, color: Rgba): void {
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(WIDTH, Math.ceil(rect.x + rect.width));
    const y1 = Math.min(HEIGHT, Math.ceil(rect.y + rect.height));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const offset = (y * WIDTH + x) * 4;
        this.data[offset] = color.r;
        this.data[offset + 1] = color.g;
        this.data[offset + 2] = color.b;
        this.data[offset + 3] = color.a;
      }
    }
  }

  stroke(rect: Rect, color: Rgba, width: number): void {
    this.rect({ x: rect.x, y: rect.y, width: rect.width, height: width }, color);
    this.rect(
      { x: rect.x, y: rect.y + rect.height - width, width: rect.width, height: width },
      color,
    );
    this.rect({ x: rect.x, y: rect.y, width, height: rect.height }, color);
    this.rect({ x: rect.x + rect.width - width, y: rect.y, width, height: rect.height }, color);
  }

  text(x: number, y: number, text: string, color: Rgba, scale: number): void {
    let cursorX = Math.floor(x);
    const cursorY = Math.floor(y);
    for (const rawChar of text) {
      const char = rawChar.toUpperCase();
      const glyph = FONT[char] ?? FONT[" "];
      for (let row = 0; row < glyph.length; row += 1) {
        const line = glyph[row];
        for (let col = 0; col < line.length; col += 1) {
          if (line[col] !== "1") {
            continue;
          }
          this.rect(
            {
              x: cursorX + col * scale,
              y: cursorY + row * scale,
              width: scale,
              height: scale,
            },
            color,
          );
        }
      }
      cursorX += 6 * scale;
    }
  }
}

function inset(rect: Rect, padding: number): Rect {
  return {
    x: rect.x + padding,
    y: rect.y + padding,
    width: Math.max(0, rect.width - padding * 2),
    height: Math.max(0, rect.height - padding * 2),
  };
}

function drawLabel(
  canvas: PngCanvas,
  rect: Rect,
  lines: string[],
  color: Rgba,
  scale: number,
): void {
  const charWidth = 6 * scale;
  const lineHeight = 9 * scale;
  const maxChars = Math.floor((rect.width - 12) / charWidth);
  const maxLines = Math.floor((rect.height - 12) / lineHeight);
  if (maxChars < 4 || maxLines < 1) {
    return;
  }
  const clipped = lines
    .slice(0, maxLines)
    .map((line) => truncateLabel(sanitizeLabel(line), maxChars));
  clipped.forEach((line, index) => {
    canvas.text(rect.x + 7, rect.y + 7 + index * lineHeight, line, color, scale);
  });
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(data: Buffer): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = WIDTH * 4;
  const raw = Buffer.alloc((stride + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    data.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function treemapGroup(params: { name: string; color: Rgba; leaves: TreemapLeaf[] }): TreemapGroup {
  return { ...params, value: totalValue(params.leaves) };
}

function buildGroups(report: SessionSystemPromptReport): TreemapGroup[] {
  const injectedTotal = report.injectedWorkspaceFiles.reduce(
    (sum, file) => sum + file.injectedChars,
    0,
  );
  const projectFrameChars = Math.max(0, report.systemPrompt.projectContextChars - injectedTotal);
  const skillTotal = report.skills.entries.reduce((sum, skill) => sum + skill.blockChars, 0);
  const systemBaseChars = Math.max(0, report.systemPrompt.nonProjectContextChars - skillTotal);
  const tools = report.tools.entries
    .map((tool) => ({ name: tool.name, value: tool.schemaChars ?? 0 }))
    .filter((tool) => tool.value > 0);
  const groups = [
    treemapGroup({
      name: "Workspace files",
      color: rgba(58, 145, 91),
      leaves: [
        ...report.injectedWorkspaceFiles.map((file) => ({
          name: file.name,
          value: file.injectedChars,
        })),
        { name: "Project context frame", value: projectFrameChars },
      ],
    }),
    treemapGroup({
      name: "System prompt",
      color: rgba(222, 138, 46),
      leaves: [{ name: "Base instructions", value: systemBaseChars }],
    }),
    treemapGroup({
      name: "Tool schemas",
      color: rgba(59, 118, 184),
      leaves: tools,
    }),
    treemapGroup({
      name: "Skills",
      color: rgba(132, 91, 173),
      leaves: report.skills.entries.map((skill) => ({
        name: skill.name,
        value: skill.blockChars,
      })),
    }),
  ];
  return groups.filter((group) => group.value > 0);
}

function drawTreemap(canvas: PngCanvas, groups: TreemapGroup[], rect: Rect): void {
  const groupRects = layoutBinary(groups, rect);
  groupRects.forEach(({ item: group, rect: groupRect }, groupIndex) => {
    const groupFill = mixColor(group.color, rgba(18, 22, 27), 0.16);
    canvas.rect(groupRect, groupFill);
    canvas.stroke(groupRect, rgba(14, 18, 22), 3);
    drawLabel(
      canvas,
      { x: groupRect.x + 4, y: groupRect.y + 4, width: groupRect.width - 8, height: 38 },
      [group.name, formatSize(group.value)],
      rgba(248, 250, 252),
      groupRect.width > 260 && groupRect.height > 120 ? 2 : 1,
    );
    const childRect = inset(
      {
        x: groupRect.x + TREEMAP_GAP,
        y: groupRect.y + (groupRect.height > 92 ? 44 : TREEMAP_GAP),
        width: groupRect.width - TREEMAP_GAP * 2,
        height: groupRect.height - (groupRect.height > 92 ? 48 : TREEMAP_GAP * 2),
      },
      0,
    );
    const leaves = group.leaves.filter((leaf) => leaf.value > 0);
    const leafRects = layoutBinary(leaves, childRect);
    leafRects.forEach(({ item: leaf, rect: leafRect }, leafIndex) => {
      const shade = (leafIndex % 7) / 10 + (groupIndex % 2) * 0.08;
      const fill = mixColor(group.color, rgba(255, 255, 255), shade);
      const inner = inset(leafRect, 1.5);
      canvas.rect(inner, fill);
      canvas.stroke(inner, rgba(8, 12, 16), 1);
      if (inner.width * inner.height > 5200) {
        const textColor =
          fill.r * 0.299 + fill.g * 0.587 + fill.b * 0.114 > 150
            ? rgba(16, 23, 31)
            : rgba(248, 250, 252);
        drawLabel(canvas, inner, [leaf.name, formatSize(leaf.value)], textColor, 1);
      }
    });
  });
}

function drawLegend(canvas: PngCanvas, groups: TreemapGroup[], rect: Rect, total: number): void {
  canvas.rect(rect, rgba(245, 247, 250));
  canvas.stroke(rect, rgba(213, 220, 228), 1);
  canvas.text(rect.x + 18, rect.y + 18, "LEGEND", rgba(30, 41, 59), 2);
  let y = rect.y + 58;
  groups.forEach((group) => {
    canvas.rect({ x: rect.x + 18, y, width: 18, height: 18 }, group.color);
    canvas.stroke({ x: rect.x + 18, y, width: 18, height: 18 }, rgba(15, 23, 42), 1);
    const pct = total > 0 ? `${Math.round((group.value / total) * 100)} PCT` : "0 PCT";
    drawLabel(
      canvas,
      { x: rect.x + 46, y: y - 1, width: rect.width - 62, height: 38 },
      [group.name, pct],
      rgba(30, 41, 59),
      1,
    );
    y += 54;
  });
}

export async function renderContextTreemapPng(params: {
  report: SessionSystemPromptReport;
  session: ContextTreemapSessionStats;
}): Promise<{ path: string; trackedChars: number; caption: string }> {
  const groups = buildGroups(params.report);
  const trackedChars = totalValue(groups);
  const canvas = new PngCanvas();
  canvas.fill(rgba(238, 241, 245));
  canvas.rect({ x: 0, y: 0, width: WIDTH, height: HEADER_HEIGHT }, rgba(20, 26, 34));
  canvas.text(PADDING, 24, "CONTEXT TREEMAP", rgba(248, 250, 252), 3);
  const sourceLine = `${params.report.source.toUpperCase()} / ${params.report.provider ?? "provider"} / ${params.report.model ?? "model"}`;
  canvas.text(PADDING, 58, sanitizeLabel(sourceLine), rgba(176, 196, 222), 1);
  const treemapRect = {
    x: PADDING,
    y: HEADER_HEIGHT + PADDING,
    width: WIDTH - LEGEND_WIDTH - PADDING * 3,
    height: HEIGHT - HEADER_HEIGHT - FOOTER_HEIGHT - PADDING * 2,
  };
  drawTreemap(canvas, groups, treemapRect);
  drawLegend(
    canvas,
    groups,
    {
      x: WIDTH - LEGEND_WIDTH - PADDING,
      y: HEADER_HEIGHT + PADDING,
      width: LEGEND_WIDTH,
      height: treemapRect.height,
    },
    trackedChars,
  );
  const footerY = HEIGHT - FOOTER_HEIGHT + 18;
  const actual =
    params.session.cachedContextTokens == null
      ? "ACTUAL CTX UNKNOWN"
      : `ACTUAL CTX ${formatInt(params.session.cachedContextTokens)} TOK`;
  const window =
    params.session.contextWindowTokens == null || params.session.contextWindowTokens <= 0
      ? "WINDOW UNKNOWN"
      : `WINDOW ${formatInt(params.session.contextWindowTokens)} TOK`;
  canvas.text(
    PADDING,
    footerY,
    `${formatSize(trackedChars)} / ${actual} / ${window}`,
    rgba(51, 65, 85),
    1,
  );
  const outPath = path.join(
    resolvePreferredOpenClawTmpDir(),
    `openclaw-context-map-${crypto.randomUUID()}.png`,
  );
  await writeFile(outPath, encodePng(canvas.data));
  const caption = [
    "Context treemap",
    `Source: ${params.report.source}`,
    `Tracked: ${formatInt(trackedChars)} chars (~${formatInt(estimateTokensFromChars(trackedChars))} tok)`,
    params.session.cachedContextTokens == null
      ? "Actual cached context: unavailable"
      : `Actual cached context: ${formatInt(params.session.cachedContextTokens)} tok`,
  ].join("\n");
  return { path: outPath, trackedChars, caption };
}

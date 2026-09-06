import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { note as clackNote } from "@clack/prompts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitizeForLog, stripAnsi, visibleWidth } from "./ansi.js";
import {
  noteToStream,
  resolveNoteColumns,
  resolveNoteOutputColumns,
  wrapNoteMessage,
} from "./note.js";
import { renderTable } from "./table.js";

function mockProcessPlatform(platform: NodeJS.Platform): void {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}

function expectIntroducersToStartCompleteSequences(
  value: string,
  introducer: string,
  sequences: readonly string[],
): void {
  let index = value.indexOf(introducer);
  while (index >= 0) {
    expect(sequences.some((sequence) => value.startsWith(sequence, index))).toBe(true);
    index = value.indexOf(introducer, index + introducer.length);
  }
}

const pluginListColumns = [
  { key: "Name", header: "Name", minWidth: 14, flex: true },
  { key: "ID", header: "ID", minWidth: 10, flex: true },
  { key: "Format", header: "Format", minWidth: 9 },
  { key: "Status", header: "Status", minWidth: 10 },
  { key: "Source", header: "Source", minWidth: 26, flex: true },
  { key: "Version", header: "Version", minWidth: 8 },
];

const pluginListRows = [
  {
    Name: "Amazon Bedrock",
    ID: "amazon-bedrock",
    Format: "openclaw",
    Status: "enabled",
    Source: "~/Projects/openclaw/extensions/amazon-bedrock/index.ts",
    Version: "2026.8.1",
  },
  {
    Name: "N".repeat(40),
    ID: "i".repeat(22),
    Format: "openclaw",
    Status: "disabled",
    Source: `/${"s".repeat(80)}`,
    Version: "2026.8.1",
  },
];

function renderPluginListTable(width: number): string {
  return renderTable({
    width,
    border: "unicode",
    columns: pluginListColumns,
    rows: pluginListRows,
  });
}

describe("renderTable", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("renders fitting ASCII cells without grapheme segmentation", () => {
    const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");

    const out = renderTable({
      border: "ascii",
      columns: [{ key: "Name", header: "Name" }],
      rows: [{ Name: "alpha" }, { Name: "beta" }],
    });

    expect(out).toBe(
      ["+-------+", "| Name  |", "+-------+", "| alpha |", "| beta  |", "+-------+", ""].join("\n"),
    );
    expect(segment).not.toHaveBeenCalled();
  });

  it.each([
    ["plain", "a\tb", "| a b     |"],
    ["styled", "\x1b[31ma\tb\x1b[39m", "| \x1b[31ma b\x1b[39m     |"],
    ["wide", "表\t文", "| 表 文   |"],
    ["ESC CSI", "a\x1b[31\tmb\x1b[0m", "| a\x1b[\x18 \x1b[31mb\x1b[0m     |"],
    ["C1 CSI", "a\x9b31\tmb\x9b0m", "| a\x9b\x18 \x9b31mb\x9b0m     |"],
    ["CSI control order", "a\x1b[31\t\x07\tmb\x1b[0m", "| a\x1b[\x18 \x07 \x1b[31mb\x1b[0m    |"],
    ["cancelled CSI", "a\x1b[31\t\x18b", "| a\x1b[\x18 \x1b[31\x18b     |"],
    ["CSI without text", "\x1b[31\tm", "|         |"],
    [
      "OSC payload",
      "a\x1b]8;id=keep\tpayload;https://example.com/\x07b\x1b]8;;\x07",
      "| a\x1b]8;id=keep\tpayload;https://example.com/\x07b\x1b]8;;\x07      |",
    ],
  ])("materializes executable tabs as table spacing in %s cells", (_label, value, expectedRow) => {
    const out = renderTable({
      border: "ascii",
      columns: [{ key: "V", header: "V", minWidth: 9, maxWidth: 9 }],
      rows: [{ V: value }],
    });

    expect(out).toBe(
      ["+---------+", "| V       |", "+---------+", expectedRow, "+---------+", ""].join("\n"),
    );
  });

  it.each([
    ["ESC", "a\x1b[31\x1b[0\tmb", "| a b     |"],
    ["C1", "a\x9b31\x9b0\tmb", "| a b     |"],
    ["mixed chain", "a\x1b[31\x9b1\x1b[0\tmb", "| a b     |"],
    ["C0 before restart", "a\x1b[31\t\x07\x9b0\tmb", "| a  b    |"],
  ])("keeps materialized tabs visible after %s CSI restarts", (_label, value, expectedRow) => {
    const out = renderTable({
      border: "ascii",
      columns: [{ key: "V", header: "V", minWidth: 9, maxWidth: 9 }],
      rows: [{ V: value }],
    });

    expect(sanitizeForLog(out.split("\n")[3] ?? "")).toBe(expectedRow);
    expect(stripAnsi(out)).not.toContain("\x18");
  });

  it.each([0, 3])("renders all %i rows without an argument-count limit", (count) => {
    const out = renderTable({
      border: "ascii",
      columns: [{ key: "Key", header: "Key" }],
      rows: Array.from({ length: count }, () => ({ Key: "session" })),
    });

    const lines = out.trimEnd().split("\n");
    expect(lines).toHaveLength(count + 4);
    expect(lines.filter((line) => line === "| session |")).toHaveLength(count);
    expect(lines[1]).toMatch(/^\| Key +\|$/u);
    expect(lines.at(-1)).toBe(lines[0]);
  });

  it.each(["rows", "wrapped lines", "soft-wrap suffix"])(
    "renders large %s with the CLI process stack",
    (shape) => {
      // Worker threads have a larger stack than the CLI process. Neither many
      // rows nor one heavily wrapped cell may depend on V8's argument-count limit.
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          fileURLToPath(new URL("../../../scripts/tsx.mjs", import.meta.url)),
          "--input-type=module",
          "-e",
          `import { renderTable } from ${JSON.stringify(new URL("./table.ts", import.meta.url).href)};
const shape = ${JSON.stringify(shape)};
const output = renderTable({
  border: "ascii",
  columns: [{ key: "Key", header: "Key", maxWidth: 5 }],
  rows: shape === "rows"
    ? Array.from({ length: 150_000 }, () => ({ Key: "row" }))
    : [{ Key: shape === "wrapped lines" ? "row".repeat(150_000) : "a  " + "\\u200b".repeat(150_000) + "b" }],
});
const lines = output.trimEnd().split("\\n");
console.log(JSON.stringify({
  lineCount: lines.length,
  rows: lines.filter(line => line === "| row |").length,
  header: lines[1],
  firstLine: lines[0],
  lastLine: lines.at(-1),
  softWrapRowsMatch: lines[3] === "| a   |" && lines[4] === "| " + "\\u200b".repeat(150_000) + "b   |",
}));`,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const rendered = JSON.parse(result.stdout);
      expect(rendered.lineCount).toBe(shape === "soft-wrap suffix" ? 6 : 150_004);
      expect(rendered.rows).toBe(shape === "soft-wrap suffix" ? 0 : 150_000);
      if (shape === "soft-wrap suffix") {
        expect(rendered.softWrapRowsMatch).toBe(true);
      }
      expect(rendered.header).toMatch(/^\| Key +\|$/u);
      expect(rendered.lastLine).toBe(rendered.firstLine);
    },
  );

  it("prefers shrinking flex columns to avoid wrapping non-flex labels", () => {
    const out = renderTable({
      width: 40,
      columns: [
        { key: "Item", header: "Item", minWidth: 10 },
        { key: "Value", header: "Value", flex: true, minWidth: 24 },
      ],
      rows: [{ Item: "Dashboard", Value: "http://127.0.0.1:18789/" }],
    });

    expect(out).toContain("Dashboard");
    expect(out).toMatch(/[│|] Dashboard\s+[│|]/);
  });

  it("keeps identifier columns intact when wider flex columns can absorb the shrink", () => {
    const out = renderPluginListTable(120);

    expect(out).toMatch(/│ Amazon Bedrock\s+│ amazon-bedrock\s+│/);
  });

  it.each([60, 80, 120, 160, 200])(
    "keeps the plugin-list shape deterministic and within %i columns",
    (width) => {
      const out = renderPluginListTable(width);
      const lines = out.trimEnd().split("\n");
      const headerCells = (lines[1] ?? "").split("│").slice(1, -1);

      expect(out).toBe(renderPluginListTable(width));
      expect(Math.max(...lines.map(visibleWidth))).toBeLessThanOrEqual(width);
      expect(headerCells).toHaveLength(pluginListColumns.length);
      for (const [index, column] of pluginListColumns.entries()) {
        expect(visibleWidth(headerCells[index] ?? "")).toBeGreaterThanOrEqual(
          visibleWidth(column.header) + 2,
        );
      }
    },
  );

  it("expands flex columns to fill available width", () => {
    const width = 60;
    const out = renderTable({
      width,
      columns: [
        { key: "Item", header: "Item", minWidth: 10 },
        { key: "Value", header: "Value", flex: true, minWidth: 24 },
      ],
      rows: [{ Item: "OS", Value: "macos 26.2 (arm64)" }],
    });

    const firstLine = out.trimEnd().split("\n")[0] ?? "";
    expect(visibleWidth(firstLine)).toBe(width);
  });

  it("stops flex growth at the cap when a fractional width rounds up", () => {
    const out = renderTable({
      width: 20,
      border: "ascii",
      padding: 0,
      columns: [{ key: "V", header: "V", minWidth: 7.999999999999999, maxWidth: 9, flex: true }],
      rows: [{ V: "x" }],
    });

    expect(out).toBe("+---------+\n|V        |\n+---------+\n|x        |\n+---------+\n");
  });

  it("wraps ANSI-colored cells without corrupting escape sequences", () => {
    const out = renderTable({
      width: 36,
      columns: [
        { key: "K", header: "K", minWidth: 3 },
        { key: "V", header: "V", flex: true, minWidth: 10 },
      ],
      rows: [
        {
          K: "X",
          V: `\x1b[33m${"a".repeat(120)}\x1b[0m`,
        },
      ],
    });

    const ansiToken = new RegExp(String.raw`\u001b\[[0-9;]*m|\u001b\]8;;.*?\u001b\\`, "gs");
    let escapeIndex = out.indexOf("\u001b");
    while (escapeIndex >= 0) {
      ansiToken.lastIndex = escapeIndex;
      const match = ansiToken.exec(out);
      expect(match?.index).toBe(escapeIndex);
      escapeIndex = out.indexOf("\u001b", escapeIndex + 1);
    }
  });

  it("resets ANSI styling on wrapped lines", () => {
    const globalReset = "\x1b[0m";
    const foregroundReset = "\x1b[39m";
    const out = renderTable({
      width: 24,
      columns: [
        { key: "K", header: "K", minWidth: 3 },
        { key: "V", header: "V", flex: true, minWidth: 10 },
      ],
      rows: [
        {
          K: "X",
          V: `\x1b[31m${"a".repeat(80)}${globalReset}`,
        },
      ],
    });

    const lines = out.split("\n").filter((line) => line.includes("a"));
    for (const line of lines) {
      const resetIndex = Math.max(line.lastIndexOf(globalReset), line.lastIndexOf(foregroundReset));
      const lastSep = Math.max(line.lastIndexOf("│"), line.lastIndexOf("|"));
      expect(resetIndex).toBeGreaterThan(-1);
      expect(lastSep).toBeGreaterThan(resetIndex);
    }
  });

  it("trims leading spaces on wrapped ANSI-colored continuation lines", () => {
    const out = renderTable({
      width: 113,
      columns: [
        { key: "Status", header: "Status", minWidth: 10 },
        { key: "Skill", header: "Skill", minWidth: 18, flex: true },
        { key: "Description", header: "Description", minWidth: 24, flex: true },
        { key: "Source", header: "Source", minWidth: 10 },
      ],
      rows: [
        {
          Status: "✓ ready",
          Skill: "🌤️ weather",
          Description:
            `\x1b[2mGet current weather and forecasts via wttr.in or Open-Meteo. ` +
            `Use when: user asks about weather, temperature, or forecasts for any location.` +
            `\x1b[0m`,
          Source: "openclaw-bundled",
        },
      ],
    });

    const lines = out
      .trimEnd()
      .split("\n")
      .filter((line) => line.includes("Use when"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("\u001b[2mUse when");
    expect(lines[0]).not.toContain("│  Use when");
    expect(lines[0]).not.toContain("│ \x1b[2m Use when");
  });

  it("keeps ANSI styling when a multiline cell wraps after an unstyled line", () => {
    const muted = "\x1b[38;2;120;120;120m";
    const resetForeground = "\x1b[39m";
    const out = renderTable({
      width: 62,
      columns: [
        { key: "Status", header: "Status", minWidth: 10 },
        { key: "Source", header: "Source", minWidth: 24, flex: true },
        { key: "Version", header: "Version", minWidth: 8 },
      ],
      rows: [
        {
          Status: "disabled",
          Source:
            "stock:codex/index.js\n" +
            `${muted}Codex app-server harness and Codex-managed GPT model catalog.${resetForeground}`,
          Version: "2026.5.12-beta.6",
        },
      ],
    });

    const descLines = out
      .split("\n")
      .filter((line) => line.includes("Codex") || line.includes("catalog."));
    expect(descLines.length).toBeGreaterThan(1);
    for (const line of descLines) {
      expect(line).toContain(muted);
      const resetIndex = line.lastIndexOf(resetForeground);
      const lastSep = Math.max(line.lastIndexOf("│"), line.lastIndexOf("|"));
      expect(resetIndex).toBeGreaterThan(-1);
      expect(lastSep).toBeGreaterThan(resetIndex);
    }
  });

  it("keeps intensity active when an RGB color contains zero operands", () => {
    const bold = "\x1b[1m";
    const red = "\x1b[38;2;255;0;0m";
    const reset = "\x1b[0m";
    const out = renderTable({
      width: 24,
      columns: [
        { key: "K", header: "K", minWidth: 3 },
        { key: "V", header: "V", flex: true, minWidth: 10 },
      ],
      rows: [{ K: "X", V: `prefix ${bold}${red}${"a".repeat(80)}${reset}` }],
    });

    const styledLines = out.split("\n").filter((line) => line.includes("a"));
    expect(styledLines.length).toBeGreaterThan(1);
    for (const line of styledLines) {
      expect(line).toContain(bold);
      expect(line).toContain(red);
    }
  });

  it.each([
    ["semicolon", "\x1b[4;58;2;255;0;0m", "\x1b[58;2;255;0;0m"],
    ["colon", "\x1b[4;58:2::255:0:0m", "\x1b[58:2::255:0:0m"],
  ])("keeps underline color active with %s operands", (_label, combined, color) => {
    const underline = "\x1b[4m";
    const globalReset = "\x1b[0m";
    const out = renderTable({
      width: 24,
      columns: [
        { key: "K", header: "K", minWidth: 3 },
        { key: "V", header: "V", flex: true, minWidth: 10 },
      ],
      rows: [{ K: "X", V: `${combined}${"u".repeat(80)}${globalReset}` }],
    });

    const styledLines = out.split("\n").filter((line) => line.includes("u"));
    expect(styledLines.length).toBeGreaterThan(1);
    for (const line of styledLines) {
      const hasOpeningState =
        line.includes(combined) || (line.includes(underline) && line.includes(color));
      expect(hasOpeningState).toBe(true);
      const hasClosingState =
        line.includes(globalReset) || (line.includes("\x1b[24m") && line.includes("\x1b[59m"));
      expect(hasClosingState).toBe(true);
    }
  });

  it("keeps unrelated SGR categories after a selective reset", () => {
    const boldRed = "\x1b[1;31m";
    const bold = "\x1b[1m";
    const resetForeground = "\x1b[39m";
    const reset = "\x1b[0m";
    const out = renderTable({
      width: 24,
      columns: [
        { key: "K", header: "K", minWidth: 3 },
        { key: "V", header: "V", flex: true, minWidth: 10 },
      ],
      rows: [
        {
          K: "X",
          V: `${boldRed}red${resetForeground}\n${"z".repeat(80)}${reset}`,
        },
      ],
    });

    const continuationLines = out.split("\n").filter((line) => line.includes("z"));
    expect(continuationLines.length).toBeGreaterThan(1);
    for (const line of continuationLines) {
      expect(line).toContain(bold);
      expect(line).not.toContain(boldRed);
      expect(line).not.toContain("\x1b[31m");
    }
  });

  it("keeps colon-form SGR sequences intact when wrapping", () => {
    const red = "\x1b[38:2::255:0:0m";
    const globalReset = "\x1b[0m";
    const foregroundReset = "\x1b[39m";
    const out = renderTable({
      width: 24,
      columns: [
        { key: "K", header: "K", minWidth: 3 },
        { key: "V", header: "V", flex: true, minWidth: 10 },
      ],
      rows: [{ K: "X", V: `${red}${"a".repeat(80)}${globalReset}` }],
    });

    const lines = out.split("\n").filter((line) => line.includes("a"));
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line).toContain(red);
      expect(line.includes(globalReset) || line.includes(foregroundReset)).toBe(true);
    }
  });

  it("does not split BEL-terminated OSC-8 links when wrapping", () => {
    const open = "\x1b]8;;https://openclaw.ai\x07";
    const close = "\x1b]8;;\x07";
    const out = renderTable({
      width: 24,
      columns: [
        { key: "K", header: "K", minWidth: 3 },
        { key: "V", header: "V", flex: true, minWidth: 10 },
      ],
      rows: [{ K: "X", V: `${open}OpenClaw${close}` }],
    });

    expectIntroducersToStartCompleteSequences(out, "\x1b", [open, close]);
  });

  it("does not split C1 CSI SGR sequences when wrapping", () => {
    const red = "\x9b31m";
    const globalReset = "\x9b0m";
    const foregroundReset = "\x9b39m";
    const out = renderTable({
      width: 24,
      columns: [
        { key: "K", header: "K", minWidth: 3 },
        { key: "V", header: "V", flex: true, minWidth: 10 },
      ],
      rows: [{ K: "X", V: `${red}${"a".repeat(80)}${globalReset}` }],
    });

    const lines = out.split("\n").filter((line) => line.includes("a"));
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      const resetIndex = Math.max(line.lastIndexOf(globalReset), line.lastIndexOf(foregroundReset));
      const lastSep = Math.max(line.lastIndexOf("│"), line.lastIndexOf("|"));
      expect(resetIndex).toBeGreaterThan(-1);
      expect(lastSep).toBeGreaterThan(resetIndex);
    }
  });

  it("does not split C1 OSC-8 links when wrapping", () => {
    const open = "\x9d8;;https://openclaw.ai\x9c";
    const close = "\x9d8;;\x9c";
    const canonicalOpen = "\x1b]8;;https://openclaw.ai\x07";
    const canonicalClose = "\x1b]8;;\x07";
    const out = renderTable({
      width: 24,
      columns: [
        { key: "K", header: "K", minWidth: 3 },
        { key: "V", header: "V", flex: true, minWidth: 10 },
      ],
      rows: [{ K: "X", V: `${open}OpenClaw${close}` }],
    });

    expectIntroducersToStartCompleteSequences(out, "\x9d", [open, close]);
    expectIntroducersToStartCompleteSequences(out, "\x1b", [canonicalOpen, canonicalClose]);
  });

  it("preserves OSC-8 parameters when reopening wrapped links", () => {
    const open = "\x1b]8;id=docs;https://openclaw.ai\x07";
    const close = "\x1b]8;;\x07";
    const out = renderTable({
      width: 20,
      columns: [
        { key: "K", header: "K", minWidth: 3 },
        { key: "V", header: "V", flex: true, minWidth: 10 },
      ],
      rows: [{ K: "X", V: `${open}${"OpenClaw".repeat(5)}${close} after` }],
    });

    const linkLines = out.split("\n").filter((line) => line.includes("OpenClaw"));
    expect(linkLines.length).toBeGreaterThan(1);
    for (const line of linkLines) {
      expect(line).toContain(open);
      expect(line).toContain(close);
    }
    const afterLine = out.split("\n").find((line) => line.includes("after"));
    expect(afterLine).toBeDefined();
    const afterIndex = afterLine?.indexOf("after") ?? -1;
    const closeIndex = afterLine?.indexOf(close) ?? -1;
    expect(closeIndex).toBeGreaterThan(-1);
    expect(closeIndex).toBeLessThan(afterIndex);
    const openIndex = afterLine?.indexOf(open) ?? -1;
    if (openIndex >= 0) {
      expect(openIndex).toBeLessThan(closeIndex);
    }
  });

  it.each([
    ["BEL ST", "\x1b]8;;https://openclaw.ai\x07", "\x1b]8;;\x07"],
    ["ESC-backslash ST", "\x1b]8;;https://openclaw.ai\x1b\\", "\x1b]8;;\x1b\\"],
    ["C1 ST", "\x9d8;;https://openclaw.ai\x9c", "\x9d8;;\x9c"],
  ])(
    "closes and reopens embedded OSC-8 links at wrap boundaries (%s)",
    (_label, openSeq, closeSeq) => {
      const link = `${openSeq}OpenClaw${closeSeq}`;
      const out = renderTable({
        width: 20,
        border: "unicode",
        columns: [
          { key: "K", header: "K", minWidth: 3 },
          { key: "V", header: "V", flex: true, minWidth: 10 },
        ],
        rows: [{ K: "X", V: `before ${link} after` }],
      });

      const afterLines = out.split("\n").filter((line) => line.includes("after"));
      expect(afterLines.length).toBeGreaterThan(0);
      for (const line of afterLines) {
        const content = line.split("│")[2] ?? "";
        expect(content).toContain("after");
        // The link may have closed on a previous line. Any opener before the
        // suffix on this line must also have closed before the suffix starts.
        const prefix = content.slice(0, content.indexOf("after"));
        expect(prefix.lastIndexOf(openSeq)).toBeLessThanOrEqual(prefix.lastIndexOf(closeSeq));
      }
    },
  );

  it.each([
    ["BEL ST", "\x1b]8;;https://openclaw.ai\x07", "\x1b]8;;\x07"],
    ["ESC-backslash ST", "\x1b]8;;https://openclaw.ai\x1b\\", "\x1b]8;;\x1b\\"],
    ["C1 ST", "\x9d8;;https://openclaw.ai\x9c", "\x9d8;;\x9c"],
  ])(
    "does not reopen a leading OSC-8 link onto wrapped suffix lines (%s)",
    (_label, openSeq, closeSeq) => {
      const link = `${openSeq}OpenClaw${closeSeq}`;
      const out = renderTable({
        width: 20,
        columns: [
          { key: "K", header: "K", minWidth: 3 },
          { key: "V", header: "V", flex: true, minWidth: 10 },
        ],
        rows: [{ K: "X", V: `${link} after` }],
      });

      // "after" wraps onto a continuation line after the link's close. The
      // leading opener must not be prepended to that line, or "after" plus its
      // padding become an unclosed hyperlink that bleeds past the cell border.
      const lines = out.split("\n");
      const afterLines = lines.filter((line) => line.includes("after"));
      expect(afterLines.length).toBeGreaterThan(0);
      for (const line of afterLines) {
        expect(line.includes(openSeq)).toBe(false);
      }
      // The link itself stays intact on the OpenClaw line: open + close present.
      const linkLine = lines.find((line) => line.includes("OpenClaw"));
      expect(linkLine).toBeDefined();
      expect(linkLine?.includes(openSeq)).toBe(true);
      expect(linkLine?.includes(closeSeq)).toBe(true);
    },
  );

  it.each([
    ["LF", "line1\n東京 line2", "", "", 0],
    ["CR", "line1\r東京 line2", "", "", 0],
    ["CRLF", "line1\r\n東京 line2", "", "", 0],
    ["colored CRLF", "\x1b[31mline1\r\n東京 line2\x1b[39m", "\x1b[31m", "\x1b[39m", 0],
    [
      "linked CRLF",
      "\x1b]8;;https://openclaw.ai\x07line1\r\n東京 line2\x1b]8;;\x07",
      "\x1b]8;;https://openclaw.ai\x07",
      "\x1b]8;;\x07",
      0,
    ],
    ["CR/SGR/LF", "line1\r\x1b[31m\n東京 line2\x1b[39m", "\x1b[31m", "\x1b[39m", 1],
    [
      "CR/OSC-8/LF",
      "line1\r\x1b]8;;https://openclaw.ai\x07\n東京 line2\x1b]8;;\x07",
      "\x1b]8;;https://openclaw.ai\x07",
      "\x1b]8;;\x07",
      1,
    ],
    ["CR/CSI-HT/LF", "line1\r\x1b[31\tm\n東京 line2\x1b[39m", "\x1b[31m", "\x1b[39m", 1],
    ["CR/CSI-BEL/LF", "line1\r\x1b[31\x07m\n東京 line2\x1b[39m", "\x1b[31\x07m", "\x1b[39m", 1],
  ] as const)(
    "respects explicit %s newlines in cell values",
    (_name, value, open, close, styledStart) => {
      const out = renderTable({
        width: 48,
        border: "unicode",
        columns: [
          { key: "A", header: "A", minWidth: 6 },
          { key: "B", header: "B", minWidth: 10, flex: true },
        ],
        rows: [{ A: "row", B: value }],
      });

      const lines = out.trimEnd().split("\n");
      expect(lines).toHaveLength(6);
      for (const line of lines) {
        expect(visibleWidth(line)).toBe(48);
      }
      const dataLines = lines.slice(3, -1);
      expect(
        dataLines.map((line) =>
          sanitizeForLog(line)
            .split("│")
            .slice(1, -1)
            .map((cell) => cell.trim()),
        ),
      ).toEqual([
        ["row", "line1"],
        ["", "東京 line2"],
      ]);
      if (open) {
        for (const line of dataLines.slice(styledStart)) {
          expect(line).toContain(open);
          expect(line).toContain(close);
          expect(line.lastIndexOf(close)).toBeLessThan(line.lastIndexOf("│"));
        }
      }
    },
  );

  it("shortens only exact home paths and child paths in table cells", () => {
    const home = path.resolve("test-home", "alice");
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", "");
    vi.stubEnv("OPENCLAW_HOME", "");

    const out = renderTable({
      border: "none",
      columns: [{ key: "Path", header: "Path" }],
      rows: [
        { Path: home },
        { Path: `${home}/project` },
        { Path: `${home}2/project` },
        { Path: `Workspace: ${home}/project` },
      ],
    });

    expect(out).toContain("~\n");
    expect(out).toContain("~/project");
    expect(out).toContain(`${home}2/project`);
    expect(out).toContain("Workspace: ~/project");
    expect(out).not.toContain("~2/project");
  });

  it("keeps table borders aligned when cells contain wide emoji graphemes", () => {
    const width = 72;
    const out = renderTable({
      width,
      columns: [
        { key: "Status", header: "Status", minWidth: 10 },
        { key: "Skill", header: "Skill", minWidth: 18 },
        { key: "Description", header: "Description", minWidth: 18, flex: true },
        { key: "Source", header: "Source", minWidth: 10 },
      ],
      rows: [
        {
          Status: "✗ missing",
          Skill: "📸 peekaboo",
          Description: "Capture screenshots from macOS windows and keep table wrapping stable.",
          Source: "openclaw-bundled",
        },
      ],
    });

    for (const line of out.trimEnd().split("\n")) {
      expect(visibleWidth(line)).toBe(width);
    }
  });

  it("preserves mixed-width graphemes after a soft wrap", () => {
    const out = renderTable({
      border: "ascii",
      padding: 0,
      columns: [{ key: "V", header: "V", minWidth: 4, maxWidth: 4 }],
      rows: [{ V: "a 表👩‍💻e\u0301काﾊﾞ後 xyz" }],
    });

    expect(out.trimEnd().split("\n").slice(3, -1)).toEqual([
      "|a   |",
      "|表👩‍💻|",
      "|e\u0301का |",
      "|ﾊﾞ後|",
      "|xyz |",
    ]);
  });

  it("keeps borders aligned when a wide grapheme lands in a narrow cell", () => {
    // A width-2 CJK/emoji glyph in a column whose content width is 1 cannot be
    // wrapped, so padCell must clamp it instead of overflowing the cell and
    // pushing the right border out of alignment.
    const out = renderTable({
      border: "ascii",
      padding: 0,
      columns: [{ key: "B", header: "B", minWidth: 1, maxWidth: 1 }],
      rows: [{ B: "表" }],
    });
    const lines = out.trimEnd().split("\n");
    for (const line of lines) {
      expect(visibleWidth(line)).toBe(3);
    }
  });

  it("terminates with aligned borders when a flex column starts at its floor", () => {
    const out = renderTable({
      width: 10,
      border: "ascii",
      columns: [
        { key: "A", header: "long header here" },
        { key: "B", header: "", flex: true, maxWidth: 3 },
      ],
      rows: [{ A: "data", B: "📸" }],
    });
    const lines = out.trimEnd().split("\n");
    const headerWidth = visibleWidth(lines[0] ?? "");
    expect(headerWidth).toBeGreaterThan(10);
    for (const line of lines) {
      expect(visibleWidth(line)).toBe(headerWidth);
    }
  });

  it.each([
    ["ESC CSI", "\x1b[2J"],
    ["C1 CSI", "\x9b2J"],
  ])("keeps unsupported %s sequences atomic at wrap boundaries", (_label, sequence) => {
    const out = renderTable({
      width: 5,
      border: "ascii",
      padding: 0,
      columns: [{ key: "V", header: "V", minWidth: 3 }],
      rows: [{ V: `abc${sequence}d` }],
    });

    expect(out).toContain(sequence);
    for (const line of out.trimEnd().split("\n")) {
      expect(visibleWidth(line)).toBe(5);
    }
  });

  it.each([
    ["ESC CSI with BEL", "\x1b[31\x07m"],
    ["C1 CSI with BEL", "\x9b31\x07m"],
  ])("keeps %s sequences with executable C0 controls atomic", (_label, sequence) => {
    const out = renderTable({
      width: 5,
      border: "ascii",
      padding: 0,
      columns: [{ key: "V", header: "V", minWidth: 3 }],
      rows: [{ V: `abc${sequence}d\x1b[0m` }],
    });

    expect(out).toContain(sequence);
    for (const line of out.trimEnd().split("\n")) {
      expect(visibleWidth(line)).toBe(5);
    }
  });

  it("wraps separately executed CSI tabs with the surrounding text", () => {
    const sequence = "\x1b[31\t\t\tm";
    const out = renderTable({
      width: 7,
      border: "ascii",
      padding: 0,
      columns: [{ key: "V", header: "V", minWidth: 5 }],
      rows: [{ V: `a bbb${sequence}d\x1b[0m` }],
    });

    expect(out).toBe(
      [
        "+-----+",
        "|V    |",
        "+-----+",
        "|a    |",
        "|bbb\x1b[\x18  |",
        "|\x1b[31md\x1b[0m    |",
        "+-----+",
        "",
      ].join("\n"),
    );
  });

  it("does not interpret CSI intermediates as SGR state", () => {
    const sequence = "\x1b[31 m";
    const out = renderTable({
      width: 24,
      columns: [
        { key: "K", header: "K", minWidth: 3 },
        { key: "V", header: "V", flex: true, minWidth: 10 },
      ],
      rows: [{ K: "X", V: `${sequence}${"a".repeat(80)}` }],
    });

    expect(out.split(sequence)).toHaveLength(2);
    expect(out).not.toContain("\x1b[39m");
    for (const line of out.trimEnd().split("\n")) {
      expect(visibleWidth(line)).toBe(24);
    }
  });

  it("falls back to ASCII borders on legacy Windows consoles", () => {
    mockProcessPlatform("win32");
    vi.stubEnv("WT_SESSION", "");
    vi.stubEnv("TERM_PROGRAM", "");
    vi.stubEnv("TERM", "vt100");

    const out = renderTable({
      columns: [
        { key: "A", header: "A", minWidth: 6 },
        { key: "B", header: "B", minWidth: 10, flex: true },
      ],
      rows: [{ A: "row", B: "value" }],
    });

    expect(out).toContain("+");
    expect(out).not.toContain("┌");
  });

  it("keeps unicode borders on modern Windows terminals", () => {
    mockProcessPlatform("win32");
    vi.stubEnv("WT_SESSION", "1");
    vi.stubEnv("TERM", "");
    vi.stubEnv("TERM_PROGRAM", "");

    const out = renderTable({
      columns: [
        { key: "A", header: "A", minWidth: 6 },
        { key: "B", header: "B", minWidth: 10, flex: true },
      ],
      rows: [{ A: "row", B: "value" }],
    });

    expect(out).toContain("┌");
    expect(out).not.toContain("+");
  });
});

describe("wrapNoteMessage", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["CR", "\r"],
    ["Unicode line separator", "\u2028"],
    ["Unicode paragraph separator", "\u2029"],
  ])("preserves note text across %s line endings", (_label, separator) => {
    const input = ["First paragraph.", "", "- Second paragraph."].join(separator);
    const writes: string[] = [];
    const output = {
      columns: 80,
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WriteStream;

    noteToStream(input, "Note", output);

    const rendered = stripAnsi(writes.join(""));
    expect(rendered).toContain("First paragraph.");
    expect(rendered).toContain("- Second paragraph.");
    expect(wrapNoteMessage(input, { columns: 80 })).toBe("First paragraph.\n\n- Second paragraph.");
  });

  it("preserves long filesystem paths without inserting spaces/newlines", () => {
    const input =
      "/Users/user/Documents/Github/impact-signals-pipeline/with/really/long/segments/file.txt";
    const wrapped = wrapNoteMessage(input, { maxWidth: 22, columns: 80 });

    expect(wrapped).toBe(input);
  });

  it("preserves long urls without inserting spaces/newlines", () => {
    const input =
      "https://example.com/this/is/a/very/long/url/segment/that/should/not/be/split/for-copy";
    const wrapped = wrapNoteMessage(input, { maxWidth: 24, columns: 80 });

    expect(wrapped).toBe(input);
  });

  it("preserves long file-like underscore tokens for copy safety", () => {
    const input = "administrators_authorized_keys_with_extra_suffix";
    const wrapped = wrapNoteMessage(input, { maxWidth: 14, columns: 80 });

    expect(wrapped).toBe(input);
  });

  it("still chunks generic long opaque tokens to avoid pathological line width", () => {
    const input = "x".repeat(70);
    const wrapped = wrapNoteMessage(input, { maxWidth: 20, columns: 80 });

    expect(wrapped).toContain("\n");
    expect(wrapped.replace(/\n/g, "")).toBe(input);
  });

  it("wraps bullet lines while preserving bullet indentation", () => {
    const input = "- one two three four five six seven eight nine ten";
    const wrapped = wrapNoteMessage(input, { maxWidth: 18, columns: 80 });
    const lines = wrapped.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]?.startsWith("- ")).toBe(true);
    const unindentedContinuationLines = lines.slice(1).filter((line) => !line.startsWith("  "));
    expect(unindentedContinuationLines).toStrictEqual([]);
  });

  it("preserves long Windows paths without inserting spaces/newlines", () => {
    // No spaces: wrapNoteMessage splits on whitespace, so a "Program Files" style path would wrap.
    const input = "C:\\\\State\\\\OpenClaw\\\\bin\\\\openclaw.exe";
    const wrapped = wrapNoteMessage(input, { maxWidth: 10, columns: 80 });
    expect(wrapped).toBe(input);
  });

  it("preserves UNC paths without inserting spaces/newlines", () => {
    const input = "\\\\\\\\server\\\\share\\\\some\\\\really\\\\long\\\\path\\\\file.txt";
    const wrapped = wrapNoteMessage(input, { maxWidth: 12, columns: 80 });
    expect(wrapped).toBe(input);
  });

  it("clamps bogus TTY columns before clack wraps note text", () => {
    expect(resolveNoteColumns(undefined)).toBe(80);
    expect(resolveNoteColumns(0)).toBe(80);
    expect(resolveNoteColumns(1)).toBe(80);
    expect(resolveNoteColumns(79)).toBe(80);
    expect(resolveNoteColumns(120)).toBe(120);
  });

  it("widens note output columns so clack does not re-wrap copy-sensitive lines", () => {
    const wrapped = wrapNoteMessage(
      [
        "- Found 1 session lock file.",
        "- ~/.openclaw/agents/main/sessions/9c2acae5-841f-4aea-936b-fdb513b60202.jsonl.lock pid=86519 (alive) age=2m47s stale=no",
      ].join("\n"),
      { columns: 80 },
    );
    const writes: string[] = [];
    const output = {
      columns: resolveNoteOutputColumns(wrapped, 80),
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WriteStream;

    clackNote(wrapped, "Session locks", { output });

    const rendered = writes.join("");
    expect(rendered).toContain(".jsonl.lock");
    expect(rendered).not.toContain(".js\n");
    expect(rendered).toContain(
      "- ~/.openclaw/agents/main/sessions/9c2acae5-841f-4aea-936b-fdb513b60202.jsonl.lock",
    );
  });

  it("routes notes and wrapping through the selected output", () => {
    const writes: string[] = [];
    const output = {
      columns: 120,
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    noteToStream("word ".repeat(18).trim(), "Wide note", output);

    const rendered = stripAnsi(writes.join(""));
    expect(rendered).toContain("word ".repeat(17).trim());
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it("coerces nullish and non-string note messages before wrapping", () => {
    expect(wrapNoteMessage(undefined, { maxWidth: 20, columns: 80 })).toBe("");
    expect(wrapNoteMessage(null, { maxWidth: 20, columns: 80 })).toBe("");
    expect(wrapNoteMessage(12345, { maxWidth: 20, columns: 80 })).toBe("12345");
    expect(wrapNoteMessage(new Error("boom"), { maxWidth: 20, columns: 80 })).toBe("Error: boom");
    expect(wrapNoteMessage({ message: "boom" }, { maxWidth: 20, columns: 80 })).toBe("");
  });

  it("keeps wrapped lines within the visible-column budget for wide (CJK) words", () => {
    // A long CJK run with no separators reaches splitLongWord; each fullwidth char is 2 columns,
    // so splitting by code-point count would emit lines up to 2x the budget.
    const input = "東京特許許可局長今日休暇許可局長今日休暇東京特許";
    const lines = wrapNoteMessage(input, { maxWidth: 20, columns: 80 }).split("\n");

    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    }
    expect(lines.join("")).toBe(input);
  });
});

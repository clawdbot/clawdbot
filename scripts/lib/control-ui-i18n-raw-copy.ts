import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

type RawCopyFinding = {
  kind: "html-attribute" | "html-text" | "object-property";
  line: number;
  name: string;
  path: string;
  text: string;
};

type RawCopyBaselineEntry = {
  count: number;
  kind: RawCopyFinding["kind"];
  name: string;
  path: string;
  text: string;
};

type RawCopyBaseline = {
  entries: RawCopyBaselineEntry[];
  version: number;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const I18N_ASSETS_DIR = path.join(ROOT, "ui", "src", "i18n", ".i18n");
const SOURCE_DIRS = [
  path.join(ROOT, "ui", "src", "app"),
  path.join(ROOT, "ui", "src", "components"),
  path.join(ROOT, "ui", "src", "lib"),
  path.join(ROOT, "ui", "src", "pages"),
] as const;
const BASELINE_PATH = path.join(I18N_ASSETS_DIR, "raw-copy-baseline.json");
const BASELINE_VERSION = 1;
const INTERPOLATION_MARKER = "\u0000";

function toRepoPath(filePath: string): string {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function normalizeRawCopyText(raw: string): string {
  return raw
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/&middot;/giu, "·")
    .trim();
}

function parseDoubleQuotedString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

function pushRawCopyFinding(
  findings: RawCopyFinding[],
  params: Omit<RawCopyFinding, "text"> & { text: string },
) {
  const text = normalizeRawCopyText(params.text);
  if (!text || !/\p{L}/u.test(text)) {
    return;
  }
  findings.push({ ...params, text });
}

function pushRawCopySegments(
  findings: RawCopyFinding[],
  params: Omit<RawCopyFinding, "text"> & { text: string },
) {
  for (const text of params.text.split(INTERPOLATION_MARKER)) {
    pushRawCopyFinding(findings, { ...params, text });
  }
}

async function walkSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "test-helpers") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkSourceFiles(fullPath)));
      continue;
    }
    if (
      entry.isFile() &&
      /\.tsx?$/u.test(entry.name) &&
      !/\.(?:test|browser\.test|node\.test)\.tsx?$/u.test(entry.name)
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

export function collectControlUiRawCopyFromSource(params: {
  filePath: string;
  source: string;
  sourceFile: ts.SourceFile;
}): RawCopyFinding[] {
  const { filePath, source, sourceFile } = params;
  const repoPath = toRepoPath(filePath);
  const findings: RawCopyFinding[] = [];
  const toLine = (offset: number) => sourceFile.getLineAndCharacterOfPosition(offset).line + 1;
  const staticAttrPattern =
    /\b(aria-label|placeholder|title)\s*=\s*"((?:(?!\$\{)[^"\\]|\\.)*?\p{L}(?:(?!\$\{)[^"\\]|\\.)*?)"/gu;
  for (const match of source.matchAll(staticAttrPattern)) {
    const rawText = match[2];
    if (rawText) {
      pushRawCopyFinding(findings, {
        kind: "html-attribute",
        line: toLine(match.index ?? 0),
        name: match[1] ?? "attribute",
        path: repoPath,
        text: parseDoubleQuotedString(rawText),
      });
    }
  }

  const propertyPattern =
    /\b(label|title|subtitle|description|help|placeholder)\s*:\s*"((?:[^"\\]|\\.)*?\p{L}(?:[^"\\]|\\.)*?)"/gu;
  for (const match of source.matchAll(propertyPattern)) {
    const rawText = match[2];
    if (rawText) {
      pushRawCopyFinding(findings, {
        kind: "object-property",
        line: toLine(match.index ?? 0),
        name: match[1] ?? "property",
        path: repoPath,
        text: parseDoubleQuotedString(rawText),
      });
    }
  }

  const attrPattern =
    /\b(aria-label|placeholder|title)\s*=\s*"((?:[^"\\]|\\.)*?\p{L}(?:[^"\\]|\\.)*?)"/gu;
  const textPattern = />\s*([^<>{}]*?\p{L}[^<>{}]*?)\s*</gu;
  const visit = (node: ts.Node) => {
    if (ts.isTaggedTemplateExpression(node) && node.tag.getText(sourceFile) === "html") {
      let logicalText: string;
      if (ts.isNoSubstitutionTemplateLiteral(node.template)) {
        logicalText = node.template.text;
      } else {
        logicalText = [
          node.template.head.text,
          ...node.template.templateSpans.map((span) => span.literal.text),
        ].join(INTERPOLATION_MARKER);
      }
      const line = toLine(node.template.getStart(sourceFile));
      for (const match of logicalText.matchAll(attrPattern)) {
        const rawText = match[2];
        if (rawText?.includes(INTERPOLATION_MARKER)) {
          pushRawCopySegments(findings, {
            kind: "html-attribute",
            line,
            name: match[1] ?? "attribute",
            path: repoPath,
            text: parseDoubleQuotedString(rawText),
          });
        }
      }
      for (const match of logicalText.matchAll(textPattern)) {
        const rawText = match[1];
        if (rawText) {
          pushRawCopySegments(findings, {
            kind: "html-text",
            line,
            name: "text",
            path: repoPath,
            text: rawText,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

async function collectFindings(): Promise<RawCopyFinding[]> {
  const files = (await Promise.all(SOURCE_DIRS.map((dir) => walkSourceFiles(dir)))).flat();
  const findings: RawCopyFinding[] = [];
  for (const filePath of files.toSorted((left, right) => left.localeCompare(right))) {
    const source = await readFile(filePath, "utf8");
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
    findings.push(...collectControlUiRawCopyFromSource({ filePath, source, sourceFile }));
  }
  return findings;
}

function summarize(findings: RawCopyFinding[]): RawCopyBaselineEntry[] {
  const counts = new Map<string, RawCopyBaselineEntry>();
  for (const finding of findings) {
    const key = [finding.path, finding.kind, finding.name, finding.text].join("\u0000");
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, {
        count: 1,
        kind: finding.kind,
        name: finding.name,
        path: finding.path,
        text: finding.text,
      });
    }
  }
  return [...counts.values()].toSorted(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.kind.localeCompare(right.kind) ||
      left.name.localeCompare(right.name) ||
      left.text.localeCompare(right.text),
  );
}

function formatBaseline(entries: RawCopyBaselineEntry[]): string {
  return `${JSON.stringify({ version: BASELINE_VERSION, entries } satisfies RawCopyBaseline, null, 2)}\n`;
}

function formatDiff(current: RawCopyBaselineEntry[], expected: RawCopyBaselineEntry[]): string {
  const keyFor = (entry: RawCopyBaselineEntry) =>
    [entry.path, entry.kind, entry.name, entry.text].join("\u0000");
  const currentByKey = new Map(current.map((entry) => [keyFor(entry), entry]));
  const expectedByKey = new Map(expected.map((entry) => [keyFor(entry), entry]));
  const added = current.filter((entry) => {
    const expectedEntry = expectedByKey.get(keyFor(entry));
    return !expectedEntry || expectedEntry.count !== entry.count;
  });
  const removed = expected.filter((entry) => {
    const currentEntry = currentByKey.get(keyFor(entry));
    return !currentEntry || currentEntry.count !== entry.count;
  });
  const lines = [
    ...added
      .slice(0, 20)
      .map(
        (entry) =>
          `+ ${entry.path} ${entry.kind}:${entry.name} x${entry.count} ${JSON.stringify(entry.text)}`,
      ),
    ...removed
      .slice(0, 20)
      .map(
        (entry) =>
          `- ${entry.path} ${entry.kind}:${entry.name} x${entry.count} ${JSON.stringify(entry.text)}`,
      ),
  ];
  const extra = added.length + removed.length - lines.length;
  if (extra > 0) {
    lines.push(`... ${extra} more baseline delta(s)`);
  }
  return lines.join("\n");
}

export async function syncControlUiRawCopyBaseline(options: {
  checkOnly: boolean;
  write: boolean;
}) {
  const entries = summarize(await collectFindings());
  const expected = formatBaseline(entries);
  const current = existsSync(BASELINE_PATH) ? await readFile(BASELINE_PATH, "utf8") : "";
  if (!options.checkOnly && options.write && current !== expected) {
    await mkdir(I18N_ASSETS_DIR, { recursive: true });
    await writeFile(BASELINE_PATH, expected, "utf8");
  }
  if (options.checkOnly && current !== expected) {
    let currentEntries: RawCopyBaselineEntry[] = [];
    try {
      const parsed = JSON.parse(current) as Partial<RawCopyBaseline>;
      currentEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      // Invalid baseline reports as a full delta below.
    }
    throw new Error(
      [
        "control-ui raw-copy baseline drift detected.",
        formatDiff(entries, currentEntries),
        "Move user-facing strings into ui/src/i18n/locales/en.ts, or run `pnpm ui:i18n:baseline` when the raw string is intentional.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  process.stdout.write(`control-ui-i18n: raw-copy: baseline entries=${entries.length}\n`);
}

// Filesystem script supports OpenClaw repository automation.
import { mkdirSync, mkdtempSync } from "node:fs";
import { access, mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./host-command.ts";

const DEFAULT_TEXT_FILE_TAIL_BYTES = 4 * 1024 * 1024;
const OPENCLAW_VERSION_PATTERN = /OpenClaw\s+([0-9][^\s]*)/gi;

export async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function readTextFileTail(
  filePath: string,
  maxBytes = DEFAULT_TEXT_FILE_TAIL_BYTES,
): Promise<string> {
  const file = await open(filePath, "r").catch(() => null);
  if (!file) {
    return "";
  }
  try {
    const stats = await file.stat();
    const start = Math.max(0, stats.size - maxBytes);
    const length = stats.size - start;
    if (length <= 0) {
      return "";
    }
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

export async function extractLastOpenClawVersionFromLog(
  logPath: string,
  pattern = OPENCLAW_VERSION_PATTERN,
  maxBytes = DEFAULT_TEXT_FILE_TAIL_BYTES,
): Promise<string> {
  const text = await readTextFileTail(logPath, maxBytes);
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  return [...text.matchAll(globalPattern)].at(-1)?.[1] ?? "";
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function makeTempDir(prefix: string): Promise<string> {
  const root =
    process.env.OPENCLAW_PARALLELS_ARTIFACT_ROOT || path.join(repoRoot, ".artifacts", "parallels");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(path.join(root, prefix));
}

export async function writeSummaryMarkdown(input: {
  summaryPath: string;
  title: string;
  lines: string[];
}): Promise<string> {
  const markdownPath = path.join(path.dirname(input.summaryPath), "summary.md");
  await writeFile(
    markdownPath,
    [
      `# ${input.title}`,
      "",
      ...input.lines,
      "",
      `JSON: ${path.basename(input.summaryPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  return markdownPath;
}

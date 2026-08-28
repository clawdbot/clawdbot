import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { mergeCodexThreadConfigs } from "./plugin-thread-config.js";
import type { JsonObject } from "./protocol.js";

const CODEX_NATIVE_PROJECT_DOC_MAX_BYTES = 128 * 1024;

type CodexNativeProjectInstructionFile = {
  path: string;
  content: string;
};

export function buildCodexProjectDocThreadConfig(config?: JsonObject): JsonObject {
  const defaults: JsonObject = { project_doc_max_bytes: CODEX_NATIVE_PROJECT_DOC_MAX_BYTES };
  return mergeCodexThreadConfigs(defaults, config) ?? defaults;
}

/**
 * Freezes the project-document sources selected by Codex for this thread.
 * Source selection remains owned by Codex, including configured root markers,
 * override precedence, and fallback filenames. Capture fails closed if a selected
 * local source changed after the native start request began.
 */
export async function captureCodexNativeProjectInstructions(params: {
  cwd: string;
  instructionSources: readonly string[];
  config?: JsonObject;
  notModifiedSinceMs?: number | undefined;
}): Promise<string | undefined> {
  const files = await readCodexNativeProjectInstructionFiles({
    cwd: params.cwd,
    instructionSources: params.instructionSources,
    maxBytes: params.config?.project_doc_max_bytes,
    notModifiedSinceMs: params.notModifiedSinceMs,
  });
  if (files.length === 0) {
    return undefined;
  }
  const lines = [
    "## OpenClaw Agent Workspace Instructions",
    "",
    "OpenClaw froze the Codex-selected root-to-working-directory project instructions that established this thread.",
    "",
  ];
  for (const file of files) {
    lines.push(`### ${file.path}`, "", file.content, "");
  }
  return lines.join("\n").trim();
}

async function readCodexNativeProjectInstructionFiles(params: {
  cwd: string;
  instructionSources: readonly string[];
  maxBytes?: unknown;
  notModifiedSinceMs?: number | undefined;
}): Promise<CodexNativeProjectInstructionFile[]> {
  const cwd = path.resolve(params.cwd);
  let remaining = normalizeProjectDocMaxBytes(params.maxBytes);
  if (remaining === 0) {
    return [];
  }
  const files: CodexNativeProjectInstructionFile[] = [];
  const seen = new Set<string>();
  for (const source of params.instructionSources) {
    const filePath = path.resolve(source);
    if (remaining === 0 || seen.has(filePath) || !isProjectInstructionSource(filePath, cwd)) {
      continue;
    }
    seen.add(filePath);
    const content = await readCodexProjectDoc(filePath, remaining, params.notModifiedSinceMs);
    if (!content.text.trim()) {
      continue;
    }
    files.push({ path: filePath, content: content.text });
    remaining = Math.max(0, remaining - content.bytesRead);
  }
  return files;
}

function normalizeProjectDocMaxBytes(value: unknown): number {
  if (value === undefined) {
    return CODEX_NATIVE_PROJECT_DOC_MAX_BYTES;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function isProjectInstructionSource(filePath: string, cwd: string): boolean {
  const relative = path.relative(path.dirname(filePath), cwd);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function readCodexProjectDoc(
  filePath: string,
  maxBytes: number,
  notModifiedSinceMs?: number,
): Promise<{ text: string; bytesRead: number }> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, "r");
    const identityBefore = await handle.stat();
    assertStableCodexProjectDocIdentity(filePath, identityBefore, notModifiedSinceMs);
    const data = Buffer.allocUnsafe(maxBytes);
    let bytesRead = 0;
    while (bytesRead < maxBytes) {
      const result = await handle.read(data, bytesRead, maxBytes - bytesRead, bytesRead);
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }
    const identityAfter = await handle.stat();
    const pathIdentityAfter = await fs.stat(filePath);
    assertSameCodexProjectDocIdentity(filePath, identityBefore, identityAfter);
    assertSameCodexProjectDocIdentity(filePath, identityBefore, pathIdentityAfter);
    return { text: data.subarray(0, bytesRead).toString("utf8"), bytesRead };
  } finally {
    await handle?.close();
  }
}

type CodexProjectDocIdentity = Stats;

function assertStableCodexProjectDocIdentity(
  filePath: string,
  identity: CodexProjectDocIdentity,
  notModifiedSinceMs: number | undefined,
) {
  if (!identity.isFile()) {
    throw new Error(`Codex-selected project instruction source is not a file: ${filePath}`);
  }
  if (
    notModifiedSinceMs !== undefined &&
    (identity.mtimeMs > notModifiedSinceMs || identity.ctimeMs > notModifiedSinceMs)
  ) {
    throw new Error(
      `Codex-selected project instruction source changed during native startup: ${filePath}`,
    );
  }
}

function assertSameCodexProjectDocIdentity(
  filePath: string,
  before: CodexProjectDocIdentity,
  after: CodexProjectDocIdentity,
) {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error(
      `Codex-selected project instruction source changed during capture: ${filePath}`,
    );
  }
}

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "../infra/crypto-digest.js";
import { writeExternalFileWithinRoot } from "../infra/fs-safe.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";

export const TRANSCRIPT_EXPORT_FILE_NAMES = new Set([
  "metadata.json",
  "summary.json",
  "summary.md",
  "transcript.jsonl",
]);

export function safeTranscriptPathSegment(value: string): string {
  const segment = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (segment === ".") {
    return "%2E";
  }
  if (segment === "..") {
    return "%2E%2E";
  }
  if (!segment) {
    return "session";
  }
  if (segment.endsWith(".") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment)) {
    return Buffer.from(segment, "utf8")
      .toString("hex")
      .match(/.{2}/gu)!
      .map((byte) => `%${byte.toUpperCase()}`)
      .join("");
  }
  return segment;
}

function legacyTranscriptPathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}

function dateSegment(value: string | undefined): string {
  const isoDate = value?.match(/^(\d{4}-\d{2}-\d{2})T/)?.[1];
  return isoDate ?? new Date().toISOString().slice(0, 10);
}

export function transcriptSessionSelector(session: TranscriptSessionDescriptor): string {
  return `${dateSegment(session.startedAt)}/${safeTranscriptPathSegment(session.sessionId)}`;
}

export function legacyTranscriptSessionSelector(session: TranscriptSessionDescriptor): string {
  const date = dateSegment(session.startedAt);
  const segment = legacyTranscriptPathSegment(session.sessionId);
  // The shipped sanitizer allowed dot components: `.` collapsed to the date
  // directory and `..` collapsed to the transcript root.
  if (segment === ".") {
    return date;
  }
  if (segment === "..") {
    return ".";
  }
  return `${date}/${segment}`;
}

export function transcriptSessionExportKey(session: TranscriptSessionDescriptor): string {
  return transcriptSessionSelector(session).toLowerCase();
}

export function normalizeExportText(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

export async function writeTranscriptArtifact(
  rootDir: string,
  fileName: string,
  content: string,
): Promise<string> {
  await writeExternalFileWithinRoot({
    rootDir,
    path: fileName,
    write: async (tempPath) => await fs.writeFile(tempPath, content, { mode: 0o600 }),
  });
  return sha256Hex(content);
}

export async function removeTranscriptArtifact(rootDir: string, fileName: string): Promise<void> {
  await fs.rm(path.join(rootDir, fileName), { force: true });
}

export async function isCaseSensitiveDirectory(directory: string): Promise<boolean> {
  const probeName = `.openclaw-case-probe-${randomUUID().toLowerCase()}`;
  const probePath = path.join(directory, probeName);
  const alternatePath = path.join(directory, probeName.toUpperCase());
  const handle = await fs.open(probePath, "wx", 0o600);
  await handle.close();
  try {
    try {
      await fs.access(alternatePath);
      return false;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return true;
      }
      throw error;
    }
  } finally {
    await fs.rm(probePath, { force: true });
  }
}

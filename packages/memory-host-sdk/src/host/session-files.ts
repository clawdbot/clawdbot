import fs from "node:fs/promises";
import path from "node:path";
import { stripInboundMetadata } from "../../../../src/auto-reply/reply/strip-inbound-meta.js";
import { isUsageCountedSessionTranscriptFileName } from "../../../../src/config/sessions/artifacts.js";
import { resolveSessionTranscriptsDirForAgent } from "../../../../src/config/sessions/paths.js";
import { redactSensitiveText } from "../../../../src/logging/redact.js";
import { createSubsystemLogger } from "../../../../src/logging/subsystem.js";
import { hashText } from "./internal.js";

const log = createSubsystemLogger("memory");

export type SessionFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content: string;
  /** Maps each content line (0-indexed) to its 1-indexed JSONL source line. */
  lineMap: number[];
  /** True when this transcript belongs to an internal dreaming narrative run. */
  generatedByDreamingNarrative?: boolean;
};

function isDreamingNarrativeBootstrapRecord(record: unknown): boolean {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return false;
  }
  const candidate = record as {
    type?: unknown;
    customType?: unknown;
    data?: unknown;
  };
  if (
    candidate.type !== "custom" ||
    candidate.customType !== "openclaw:bootstrap-context:full" ||
    !candidate.data ||
    typeof candidate.data !== "object" ||
    Array.isArray(candidate.data)
  ) {
    return false;
  }
  const runId = (candidate.data as { runId?: unknown }).runId;
  return typeof runId === "string" && runId.startsWith("dreaming-narrative-");
}

export async function listSessionFilesForAgent(agentId: string): Promise<string[]> {
  const dir = resolveSessionTranscriptsDirForAgent(agentId);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => isUsageCountedSessionTranscriptFileName(name))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

export function sessionPathForFile(absPath: string): string {
  return path.join("sessions", path.basename(absPath)).replace(/\\/g, "/");
}

function normalizeSessionText(value: string): string {
  return value
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectRawSessionText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Strip OpenClaw-injected inbound metadata envelopes from a raw text block
 * on user-role messages before normalization. See the authoritative
 * implementation in `src/memory-host-sdk/host/session-files.ts` for the
 * full rationale; duplicated here to keep this parallel copy bug-free.
 */
function stripInboundMetadataForUserRole(text: string, role: "user" | "assistant"): string {
  if (role !== "user") {
    return text;
  }
  return stripInboundMetadata(text);
}

export function extractSessionText(
  content: unknown,
  role: "user" | "assistant" = "assistant",
): string | null {
  const rawText = collectRawSessionText(content);
  if (rawText === null) {
    return null;
  }
  const stripped = stripInboundMetadataForUserRole(rawText, role);
  const normalized = normalizeSessionText(stripped);
  return normalized ? normalized : null;
}

export async function buildSessionEntry(absPath: string): Promise<SessionFileEntry | null> {
  try {
    const stat = await fs.stat(absPath);
    const raw = await fs.readFile(absPath, "utf-8");
    const lines = raw.split("\n");
    const collected: string[] = [];
    const lineMap: number[] = [];
    let generatedByDreamingNarrative = false;
    for (let jsonlIdx = 0; jsonlIdx < lines.length; jsonlIdx++) {
      const line = lines[jsonlIdx];
      if (!line.trim()) {
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!generatedByDreamingNarrative && isDreamingNarrativeBootstrapRecord(record)) {
        generatedByDreamingNarrative = true;
      }
      if (
        !record ||
        typeof record !== "object" ||
        (record as { type?: unknown }).type !== "message"
      ) {
        continue;
      }
      const message = (record as { message?: unknown }).message as
        | { role?: unknown; content?: unknown }
        | undefined;
      if (!message || typeof message.role !== "string") {
        continue;
      }
      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }
      const text = extractSessionText(message.content, message.role);
      if (!text) {
        continue;
      }
      const safe = redactSensitiveText(text, { mode: "tools" });
      const label = message.role === "user" ? "User" : "Assistant";
      collected.push(`${label}: ${safe}`);
      lineMap.push(jsonlIdx + 1);
    }
    const content = collected.join("\n");
    return {
      path: sessionPathForFile(absPath),
      absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: hashText(content + "\n" + lineMap.join(",")),
      content,
      lineMap,
      ...(generatedByDreamingNarrative ? { generatedByDreamingNarrative: true } : {}),
    };
  } catch (err) {
    log.debug(`Failed reading session file ${absPath}: ${String(err)}`);
    return null;
  }
}

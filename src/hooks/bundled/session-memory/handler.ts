/**
 * Session memory hook handler
 *
 * Saves session context to memory when /new or /reset command is triggered
 * Creates a new dated memory file with a timestamp slug by default
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveAgentIdByWorkspacePath,
  resolveAgentWorkspaceDir,
} from "../../../agents/agent-scope.js";
import { resolveStateDir } from "../../../config/paths.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../../../routing/session-key.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";
import { generateSlugViaLLM } from "../../llm-slug-generator.js";
import { findPreviousSessionFile, getRecentSessionContentWithResetFallback } from "./transcript.js";

const log = createSubsystemLogger("hooks/session-memory");

function pickDateTimePart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string | undefined {
  return parts.find((part) => part.type === type)?.value;
}

function resolveLocalTimeZone(): string | undefined {
  const timeZone = process.env.TZ?.trim();
  if (!timeZone) {
    return undefined;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return undefined;
  }
}

function formatLocalSessionTimestamp(date: Date): {
  date: string;
  time: string;
  timeSlug: string;
  timeZoneName?: string;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: resolveLocalTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(date);

  const year = pickDateTimePart(parts, "year") ?? String(date.getFullYear()).padStart(4, "0");
  const month = pickDateTimePart(parts, "month") ?? String(date.getMonth() + 1).padStart(2, "0");
  const day = pickDateTimePart(parts, "day") ?? String(date.getDate()).padStart(2, "0");
  const hour = pickDateTimePart(parts, "hour") ?? String(date.getHours()).padStart(2, "0");
  const minute = pickDateTimePart(parts, "minute") ?? String(date.getMinutes()).padStart(2, "0");
  const second = pickDateTimePart(parts, "second") ?? String(date.getSeconds()).padStart(2, "0");
  const timeZoneName = [...parts]
    .toReversed()
    .find((part) => part.type === "timeZoneName")
    ?.value?.trim();

  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}:${second}`,
    timeSlug: `${hour}${minute}`,
    timeZoneName,
  };
}

async function resolveAvailableMemoryFilename(params: {
  memoryDir: string;
  dateStr: string;
  slug: string;
}): Promise<string> {
  const basename = `${params.dateStr}-${params.slug}`;
  let suffix = 1;

  while (true) {
    const filename = suffix === 1 ? `${basename}.md` : `${basename}-${suffix}.md`;
    try {
      await fs.access(path.join(params.memoryDir, filename));
      suffix += 1;
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") {
        return filename;
      }
      throw err;
    }
  }
}

function resolveDisplaySessionKey(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  sessionKey: string;
}): string {
  if (!params.cfg || !params.workspaceDir) {
    return params.sessionKey;
  }
  const workspaceAgentId = resolveAgentIdByWorkspacePath(params.cfg, params.workspaceDir);
  const parsed = parseAgentSessionKey(params.sessionKey);
  if (!workspaceAgentId || !parsed || workspaceAgentId === parsed.agentId) {
    return params.sessionKey;
  }
  return toAgentStoreSessionKey({
    agentId: workspaceAgentId,
    requestKey: parsed.rest,
  });
}

/**
 * Save session context to memory when /new or /reset command is triggered
 */
const pendingSessionMemoryWrites = new Set<Promise<void>>();

export async function flushSessionMemoryWritesForTest(): Promise<void> {
  await Promise.allSettled(pendingSessionMemoryWrites);
}

async function saveSessionMemoryNow(event: Parameters<HookHandler>[0]): Promise<void> {
  try {
    log.debug("Hook triggered for reset/new command", { action: event.action });

    const context = event.context || {};
    const cfg = context.cfg as OpenClawConfig | undefined;
    const contextWorkspaceDir =
      typeof context.workspaceDir === "string" && context.workspaceDir.trim().length > 0
        ? context.workspaceDir
        : undefined;
    const agentId = resolveAgentIdFromSessionKey(event.sessionKey);
    const workspaceDir =
      contextWorkspaceDir ||
      (cfg
        ? resolveAgentWorkspaceDir(cfg, agentId)
        : path.join(resolveStateDir(process.env, os.homedir), "workspace"));
    const displaySessionKey = resolveDisplaySessionKey({
      cfg,
      workspaceDir: contextWorkspaceDir,
      sessionKey: event.sessionKey,
    });
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    // Use the user's local timezone for memory artifact names and headings.
    const now = new Date(event.timestamp);
    const localTimestamp = formatLocalSessionTimestamp(now);
    const dateStr = localTimestamp.date;

    // Generate descriptive slug from session when explicitly enabled
    // Prefer previousSessionEntry (old session before /new) over current (which may be empty)
    const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<
      string,
      unknown
    >;
    const currentSessionId = sessionEntry.sessionId as string;
    let currentSessionFile = (sessionEntry.sessionFile as string) || undefined;

    // If sessionFile is empty or looks like a new/reset file, try to find the previous session file.
    if (!currentSessionFile || currentSessionFile.includes(".reset.")) {
      const sessionsDirs = new Set<string>();
      if (currentSessionFile) {
        sessionsDirs.add(path.dirname(currentSessionFile));
      }
      sessionsDirs.add(path.join(workspaceDir, "sessions"));

      for (const sessionsDir of sessionsDirs) {
        const recoveredSessionFile = await findPreviousSessionFile({
          sessionsDir,
          currentSessionFile,
          sessionId: currentSessionId,
        });
        if (!recoveredSessionFile) {
          continue;
        }
        currentSessionFile = recoveredSessionFile;
        log.debug("Found previous session file", { file: currentSessionFile });
        break;
      }
    }

    log.debug("Session context resolved", {
      sessionId: currentSessionId,
      sessionFile: currentSessionFile,
      hasCfg: Boolean(cfg),
    });

    const sessionFile = currentSessionFile || undefined;

    // Read message count from hook config (default: 15)
    const hookConfig = resolveHookConfig(cfg, "session-memory");
    const messageCount =
      typeof hookConfig?.messages === "number" && hookConfig.messages > 0
        ? hookConfig.messages
        : 15;

    let slug: string | null = null;
    let sessionContent: string | null = null;

    if (sessionFile) {
      // Get recent conversation content, with fallback to rotated reset transcript.
      sessionContent = await getRecentSessionContentWithResetFallback(sessionFile, messageCount);
      log.debug("Session content loaded", {
        length: sessionContent?.length ?? 0,
        messageCount,
      });

      // Avoid calling the model provider in unit tests; keep hooks fast and deterministic.
      const isTestEnv =
        process.env.OPENCLAW_TEST_FAST === "1" ||
        process.env.VITEST === "true" ||
        process.env.VITEST === "1" ||
        process.env.NODE_ENV === "test";
      const allowLlmSlug = !isTestEnv && hookConfig?.llmSlug === true;

      if (sessionContent && cfg && allowLlmSlug) {
        log.debug("Calling generateSlugViaLLM...");
        // Use LLM to generate a descriptive slug
        slug = await generateSlugViaLLM({ sessionContent, cfg });
        log.debug("Generated slug", { slug });
      }
    }

    // If no slug, use timestamp
    if (!slug) {
      slug = localTimestamp.timeSlug;
      log.debug("Using fallback timestamp slug", { slug });
    }

    // Create filename with date and slug
    const filename = await resolveAvailableMemoryFilename({ memoryDir, dateStr, slug });
    const memoryFilePath = path.join(memoryDir, filename);
    log.debug("Memory file path resolved", {
      filename,
      path: memoryFilePath.replace(os.homedir(), "~"),
    });

    const timeStr = localTimestamp.time;
    const timeZoneSuffix = localTimestamp.timeZoneName ? ` ${localTimestamp.timeZoneName}` : "";

    // Extract context details
    const sessionId = (sessionEntry.sessionId as string) || "unknown";
    const source = (context.commandSource as string) || "unknown";

    // Build Markdown entry
    const entryParts = [
      `# Session: ${dateStr} ${timeStr}${timeZoneSuffix}`,
      "",
      `- **Session Key**: ${displaySessionKey}`,
      `- **Session ID**: ${sessionId}`,
      `- **Source**: ${source}`,
      "",
    ];

    // Include conversation content if available
    if (sessionContent) {
      entryParts.push("## Conversation Summary", "", sessionContent, "");
    }

    const entry = entryParts.join("\n");

    // Write under memory root with alias-safe file validation.
    await writeFileWithinRoot({
      rootDir: memoryDir,
      relativePath: filename,
      data: entry,
      encoding: "utf-8",
    });
    log.debug("Memory file written successfully");

    // Log completion (but don't send user-visible confirmation - it's internal housekeeping)
    const relPath = memoryFilePath.replace(os.homedir(), "~");
    log.info(`Session context saved to ${relPath}`);
  } catch (err) {
    if (err instanceof Error) {
      log.error("Failed to save session memory", {
        errorName: err.name,
        errorMessage: err.message,
        stack: err.stack,
      });
    } else {
      log.error("Failed to save session memory", { error: String(err) });
    }
  }
}

const saveSessionToMemory: HookHandler = (event) => {
  // Only trigger on reset/new commands. This is silent housekeeping, so keep it
  // off the command reply path.
  const isResetCommand = event.action === "new" || event.action === "reset";
  if (event.type !== "command" || !isResetCommand) {
    return;
  }

  const writePromise = saveSessionMemoryNow(event);
  pendingSessionMemoryWrites.add(writePromise);
  void writePromise.finally(() => {
    pendingSessionMemoryWrites.delete(writePromise);
  });
};

export default saveSessionToMemory;

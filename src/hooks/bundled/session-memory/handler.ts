/**
 * Session memory hook handler
 *
 * Saves session context to memory when /new or /reset command is triggered
 * Creates a new dated memory file with a timestamp slug by default
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  resolveAgentIdByWorkspacePath,
  resolveAgentWorkspaceDir,
} from "../../../agents/agent-scope.js";
import { resolveUserTimezone } from "../../../agents/date-time.js";
import { resolveStateDir } from "../../../config/paths.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import {
  loadTranscriptEvents,
  readSessionTranscriptBoundedMessageTailPage,
  type TranscriptEvent,
} from "../../../config/sessions/session-accessor.js";
import { selectVisibleTranscriptEvents } from "../../../config/sessions/transcript-visible-events.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isVitestRuntimeEnv } from "../../../infra/env.js";
import { root } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../../process/gateway-work-admission.js";
import { parseAgentSessionKey, toAgentStoreSessionKey } from "../../../routing/session-key.js";
import { shortenHomePath } from "../../../utils.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";
import { generateSlugViaLLM } from "../../llm-slug-generator.js";
import { isSessionAutoResetReason } from "../../session-auto-reset.js";
import { countSessionMemoryMessages, getRecentSessionContentFromEvents } from "./transcript.js";

const log = createSubsystemLogger("hooks/session-memory");
const SESSION_MEMORY_CAPTURE_MAX_BYTES = 8 * 1024 * 1024;
const SESSION_MEMORY_CAPTURE_PAGE_MESSAGES = 256;
const SESSION_MEMORY_CAPTURE_MAX_SCANNED_MESSAGES = 4_096;

function pickDateTimePart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string | undefined {
  return parts.find((part) => part.type === type)?.value;
}

function formatLocalSessionTimestamp(
  date: Date,
  timeZone: string,
): {
  date: string;
  time: string;
  timeSlug: string;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const year = pickDateTimePart(parts, "year") ?? String(date.getFullYear()).padStart(4, "0");
  const month = pickDateTimePart(parts, "month") ?? String(date.getMonth() + 1).padStart(2, "0");
  const day = pickDateTimePart(parts, "day") ?? String(date.getDate()).padStart(2, "0");
  const hour = pickDateTimePart(parts, "hour") ?? String(date.getHours()).padStart(2, "0");
  const minute = pickDateTimePart(parts, "minute") ?? String(date.getMinutes()).padStart(2, "0");
  const second = pickDateTimePart(parts, "second") ?? String(date.getSeconds()).padStart(2, "0");
  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}:${second}`,
    timeSlug: `${hour}${minute}`,
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

async function getRecentSqliteSessionContent(
  scope: { agentId: string; sessionId: string; sessionKey: string; storePath: string },
  messageCount: number,
  capturedEvents?: TranscriptEvent[],
): Promise<string | null> {
  try {
    const events = capturedEvents ?? (await loadTranscriptEvents({ ...scope }));
    const latestResetIndex = capturedEvents
      ? -1
      : events.findLastIndex(
          (event) =>
            Boolean(event) &&
            typeof event === "object" &&
            !Array.isArray(event) &&
            (event as { type?: unknown }).type === "reset",
        );
    const retiredEvents = latestResetIndex >= 0 ? events.slice(0, latestResetIndex) : events;
    return getRecentSessionContentFromEvents(
      selectVisibleTranscriptEvents(retiredEvents),
      messageCount,
    );
  } catch {
    return null;
  }
}

// The bounded reader already projects the active branch, but message pages
// omit intervening control ancestors. Relink this snapshot so the shared
// visibility selector can validate it without dropping active messages.
function relinkCapturedActiveMessageEvents(events: TranscriptEvent[]): TranscriptEvent[] {
  let parentId: string | null = null;
  return events.map((event, index) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return event;
    }
    const record = event as Record<string, unknown>;
    if (record.type !== "message") {
      return event;
    }
    const id = typeof record.id === "string" ? record.id : `session-memory-${index + 1}`;
    const linked = { ...record, id, parentId } as TranscriptEvent;
    parentId = id;
    return linked;
  });
}

function captureRecentSessionMemoryEvents(
  scope: { agentId: string; sessionId: string; sessionKey: string; storePath: string },
  messageCount: number,
): TranscriptEvent[] {
  const captured: TranscriptEvent[] = [];
  let capturedBytes = 0;
  let offset = 0;
  let totalMessages = Number.POSITIVE_INFINITY;
  while (
    offset < totalMessages &&
    offset < SESSION_MEMORY_CAPTURE_MAX_SCANNED_MESSAGES &&
    capturedBytes < SESSION_MEMORY_CAPTURE_MAX_BYTES &&
    countSessionMemoryMessages(
      selectVisibleTranscriptEvents(relinkCapturedActiveMessageEvents(captured)),
    ) < messageCount
  ) {
    const page = readSessionTranscriptBoundedMessageTailPage(scope, {
      maxBytes: SESSION_MEMORY_CAPTURE_MAX_BYTES - capturedBytes,
      maxMessages: Math.min(
        SESSION_MEMORY_CAPTURE_PAGE_MESSAGES,
        SESSION_MEMORY_CAPTURE_MAX_SCANNED_MESSAGES - offset,
      ),
      offset,
    });
    totalMessages = page.totalMessages;
    if (page.scannedMessages === 0) {
      break;
    }
    captured.unshift(...page.events.map(({ event }) => event));
    capturedBytes += page.serializedBytes;
    offset += page.scannedMessages;
  }
  return relinkCapturedActiveMessageEvents(captured);
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

const pendingSessionMemoryWrites = new Set<Promise<void>>();

function requireSessionMemoryAgentId(event: Parameters<HookHandler>[0]): string {
  const agentId = normalizeOptionalString(event.context?.agentId);
  if (!agentId) {
    throw new Error("Session memory hook contract requires context.agentId");
  }
  return agentId;
}

export async function flushSessionMemoryWritesForTest(): Promise<void> {
  await Promise.allSettled(pendingSessionMemoryWrites);
}

async function saveSessionMemoryNow(
  event: Parameters<HookHandler>[0],
  agentId: string,
  capturedEvents?: TranscriptEvent[],
): Promise<void> {
  try {
    log.debug("Session memory hook triggered", { action: event.action, type: event.type });

    const context = event.context || {};
    const cfg = context.cfg as OpenClawConfig | undefined;
    const contextWorkspaceDir =
      typeof context.workspaceDir === "string" && context.workspaceDir.trim().length > 0
        ? context.workspaceDir
        : undefined;
    const contextStorePath =
      typeof context.storePath === "string" && context.storePath.trim()
        ? context.storePath.trim()
        : undefined;
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

    // Session-memory artifacts share the same configured user-day boundary as daily memory files.
    const now = new Date(event.timestamp);
    const userTimezone = resolveUserTimezone(cfg?.agents?.defaults?.userTimezone ?? process.env.TZ);
    const localTimestamp = formatLocalSessionTimestamp(now, userTimezone);
    const dateStr = localTimestamp.date;

    // Manual commands carry the prior entry separately; automatic rollover
    // events already identify the ended session as sessionEntry.
    const sessionEntry = (
      event.type === "command"
        ? context.previousSessionEntry || context.sessionEntry || {}
        : context.sessionEntry || {}
    ) as Record<string, unknown>;
    const currentSessionId =
      typeof sessionEntry.sessionId === "string" && sessionEntry.sessionId.trim()
        ? sessionEntry.sessionId.trim()
        : undefined;

    log.debug("Session context resolved", {
      sessionId: currentSessionId,
      hasCfg: Boolean(cfg),
    });

    // Read message count from hook config (default: 15)
    const hookConfig = resolveHookConfig(cfg, "session-memory");
    const messageCount =
      typeof hookConfig?.messages === "number" && hookConfig.messages > 0
        ? hookConfig.messages
        : 15;

    let slug: string | null = null;
    let sessionContent: string | null = null;

    if (currentSessionId) {
      sessionContent = await getRecentSqliteSessionContent(
        {
          agentId,
          sessionId: currentSessionId,
          sessionKey: event.sessionKey,
          storePath:
            contextStorePath ?? resolveSessionStorePathCore(cfg?.session?.store, { agentId }),
        },
        messageCount,
        capturedEvents,
      );
      log.debug("Session content loaded", {
        length: sessionContent?.length ?? 0,
        messageCount,
      });

      // Avoid calling the model provider in unit tests; keep hooks fast and deterministic.
      const isTestEnv = isVitestRuntimeEnv();
      const allowLlmSlug = !isTestEnv && hookConfig?.llmSlug === true;

      if (sessionContent && cfg && allowLlmSlug) {
        log.debug("Calling generateSlugViaLLM...");
        // Use LLM to generate a descriptive slug
        const slugModel = typeof hookConfig?.model === "string" ? hookConfig.model : undefined;
        slug = await generateSlugViaLLM({ sessionContent, cfg, agentId, model: slugModel });
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
      path: shortenHomePath(memoryFilePath),
    });

    const timeStr = localTimestamp.time;

    // Extract context details
    const sessionId = (sessionEntry.sessionId as string) || "unknown";
    const boundaryDetail =
      event.type === "session"
        ? `- **Reason**: ${(context.reason as string) || "unknown"}`
        : `- **Source**: ${(context.commandSource as string) || "unknown"}`;

    // Build Markdown entry
    const entryParts = [
      `# Session: ${dateStr} ${timeStr} ${userTimezone}`,
      "",
      `- **Session Key**: ${displaySessionKey}`,
      `- **Session ID**: ${sessionId}`,
      boundaryDetail,
      "",
    ];

    // Include conversation content if available
    if (sessionContent) {
      entryParts.push("## Conversation Summary", "", sessionContent, "");
    }

    const entry = entryParts.join("\n");

    // Write under memory root with alias-safe file validation.
    const memoryRoot = await root(memoryDir);
    await memoryRoot.write(filename, entry, { encoding: "utf-8" });
    log.debug("Memory file written successfully");

    // Log completion (but don't send user-visible confirmation - it's internal housekeeping)
    const relPath = shortenHomePath(memoryFilePath);
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
  // Manual commands retain their shipped hook contract, including /reset soft.
  // Automatic rollover uses a distinct lifecycle event so command hooks do not
  // receive synthetic commands and manual reset cannot double-write memory.
  const isResetCommand = event.action === "new" || event.action === "reset";
  const isAutoReset =
    event.type === "session" &&
    event.action === "auto-reset" &&
    isSessionAutoResetReason(event.context.reason);
  if ((event.type !== "command" || !isResetCommand) && !isAutoReset) {
    return undefined;
  }
  const agentId = requireSessionMemoryAgentId(event);

  let capturedEvents: TranscriptEvent[] | undefined;
  try {
    const context = event.context || {};
    const sessionEntry = (
      event.type === "command"
        ? context.previousSessionEntry || context.sessionEntry || {}
        : context.sessionEntry || {}
    ) as Record<string, unknown>;
    const sessionId =
      typeof sessionEntry.sessionId === "string" && sessionEntry.sessionId.trim()
        ? sessionEntry.sessionId.trim()
        : undefined;
    if (sessionId) {
      const cfg = context.cfg as OpenClawConfig | undefined;
      const storePath =
        typeof context.storePath === "string" && context.storePath.trim()
          ? context.storePath.trim()
          : resolveSessionStorePathCore(cfg?.session?.store, { agentId });
      const hookConfig = resolveHookConfig(cfg, "session-memory");
      const messageCount =
        typeof hookConfig?.messages === "number" && hookConfig.messages > 0
          ? hookConfig.messages
          : 15;
      capturedEvents = captureRecentSessionMemoryEvents(
        { agentId, sessionId, sessionKey: event.sessionKey, storePath },
        messageCount,
      );
    }
  } catch {
    // Projection reads verify indexedSeq against the latest committed seq in
    // one transaction. An in-flight rebuild throws here and schedules repair,
    // so the async writer falls back to the authoritative transcript rows.
  }
  const writePromise = isAutoReset
    ? saveSessionMemoryNow(event, agentId, capturedEvents)
    : runWithGatewayIndependentRootWorkContinuation(() =>
        saveSessionMemoryNow(event, agentId, capturedEvents),
      );
  pendingSessionMemoryWrites.add(writePromise);
  void writePromise.finally(() => {
    pendingSessionMemoryWrites.delete(writePromise);
  });
  // Automatic rollover dispatch is already detached from the successor turn.
  // Keep its gateway admission alive until nested slug/model work finishes.
  if (isAutoReset) {
    return writePromise;
  }
  return undefined;
};

export default saveSessionToMemory;

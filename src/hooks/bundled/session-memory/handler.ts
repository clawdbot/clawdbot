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
import { createMemoryWriteProvenanceObserver } from "../../../agents/memory-write-provenance.js";
import { resolveStateDir } from "../../../config/paths.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
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
import { captureSessionMemoryTranscript, type SessionMemoryTranscript } from "./capture.js";

const log = createSubsystemLogger("hooks/session-memory");

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
  transcript: SessionMemoryTranscript,
): Promise<void> {
  try {
    log.debug("Session memory hook triggered", { action: event.action, type: event.type });

    const context = event.context || {};
    const cfg = context.cfg as OpenClawConfig | undefined;
    const contextWorkspaceDir =
      typeof context.workspaceDir === "string" && context.workspaceDir.trim().length > 0
        ? context.workspaceDir
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

    const hookConfig = resolveHookConfig(cfg, "session-memory");
    let slug: string | null = null;
    if (transcript.status === "unavailable") {
      log.warn("Session transcript unavailable for memory capture", {
        sessionKey: event.sessionKey,
        error: transcript.reason,
      });
    }
    if (currentSessionId) {
      // Avoid calling the model provider in unit tests; keep hooks fast and deterministic.
      const isTestEnv = isVitestRuntimeEnv();
      const allowLlmSlug = !isTestEnv && hookConfig?.llmSlug === true;

      if (transcript.status === "available" && transcript.content && cfg && allowLlmSlug) {
        log.debug("Calling generateSlugViaLLM...");
        // Use LLM to generate a descriptive slug
        const slugModel = typeof hookConfig?.model === "string" ? hookConfig.model : undefined;
        slug = await generateSlugViaLLM({
          sessionContent: transcript.content,
          cfg,
          agentId,
          model: slugModel,
        });
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
    if (transcript.status === "available" && transcript.content) {
      entryParts.push("## Conversation Summary", "", transcript.content, "");
    } else if (transcript.status === "unavailable") {
      entryParts.push(
        "## Conversation Summary",
        "",
        `> Transcript content was unavailable: ${JSON.stringify(transcript.reason)}`,
        "",
      );
    }

    const entry = entryParts.join("\n");

    // Reserve provenance before exposing the file. A restricted projection
    // must never fall back to an untracked artifact that later reads as trusted.
    const memoryRoot = await root(memoryDir);
    const provenanceObserver = createMemoryWriteProvenanceObserver({
      mutationRoot: workspaceDir,
      workspaceDir,
      resolveOriginClass: () =>
        transcript.status === "available" ? transcript.originClass : "agent",
      sessionId: currentSessionId,
      sessionKey: event.sessionKey,
      now: () => now.getTime(),
    });
    const commit = () => memoryRoot.write(filename, entry, { encoding: "utf-8" });
    await provenanceObserver.write({
      absolutePath: memoryFilePath,
      contentBefore: "",
      contentAfter: entry,
      commit,
    });
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

  const context = event.context;
  const sessionEntry = (
    event.type === "command"
      ? (context.previousSessionEntry ?? context.sessionEntry)
      : context.sessionEntry
  ) as { sessionId?: string } | undefined;
  const cfg = context.cfg as OpenClawConfig | undefined;
  // Gateway and soft-reset hooks already run before mutation; chat resets carry
  // the snapshot captured by session initialization before closing the window.
  const transcript =
    (context.previousSessionMemory as SessionMemoryTranscript | undefined) ??
    (sessionEntry?.sessionId
      ? captureSessionMemoryTranscript(
          {
            agentId,
            sessionId: sessionEntry.sessionId,
            sessionKey: event.sessionKey,
            storePath:
              typeof context.storePath === "string" && context.storePath.trim()
                ? context.storePath.trim()
                : resolveSessionStorePathCore(cfg?.session?.store, { agentId }),
          },
          cfg,
        )
      : ({ status: "available", content: null, originClass: "agent" } as const));
  const writePromise = isAutoReset
    ? saveSessionMemoryNow(event, agentId, transcript)
    : runWithGatewayIndependentRootWorkContinuation(
        () => saveSessionMemoryNow(event, agentId, transcript),
        "hooks:session-memory",
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

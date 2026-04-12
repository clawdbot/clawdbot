import fs from "node:fs/promises";
import readline from "node:readline";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { normalizeReplyPayload } from "../../auto-reply/reply/normalize-reply.js";
import type { ThinkLevel, VerboseLevel } from "../../auto-reply/thinking.js";
import {
  isSilentReplyPrefixText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
} from "../../auto-reply/tokens.js";
import { mergeSessionEntry, type SessionEntry, updateSessionStore } from "../../config/sessions.js";
import { resolveSessionTranscriptFile } from "../../config/sessions/transcript.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { sanitizeForLog } from "../../terminal/ansi.js";
import { resolveMessageChannel } from "../../utils/message-channel.js";
import { resolveBootstrapWarningSignaturesSeen } from "../bootstrap-budget.js";
import { runCliAgent } from "../cli-runner.js";
import { clearCliSession, getCliSessionBinding, setCliSessionBinding } from "../cli-session.js";
import { FailoverError } from "../failover-error.js";
import { formatAgentInternalEventsForPrompt } from "../internal-events.js";
import { hasInternalRuntimeContext } from "../internal-runtime-context.js";
import { isCliProvider } from "../model-selection.js";
import { prepareSessionManagerForRun } from "../pi-embedded-runner/session-manager-init.js";
import { runEmbeddedPiAgent } from "../pi-embedded.js";
import { buildWorkspaceSkillSnapshot } from "../skills.js";
import { resolveAgentRunContext } from "./run-context.js";
import type { AgentCommandOpts } from "./types.js";

const log = createSubsystemLogger("agents/agent-command");

/** Maximum number of JSONL records to inspect before giving up. */
const SESSION_FILE_MAX_RECORDS = 500;

/**
 * Check whether a session transcript file exists and contains at least one
 * assistant message, indicating that the SessionManager has flushed the
 * initial user+assistant exchange to disk.  This is used to decide whether
 * a fallback retry can rely on the on-disk history or must re-send the
 * original prompt.
 *
 * The check parses JSONL records line-by-line (CWE-703) instead of relying
 * on a raw substring match against a bounded byte prefix, which could
 * produce false negatives when the pre-assistant content exceeds the byte
 * limit.
 */
export async function sessionFileHasContent(sessionFile: string | undefined): Promise<boolean> {
  if (!sessionFile) {
    return false;
  }
  try {
    // Guard against symlink-following (CWE-400 / arbitrary-file-read vector).
    const stat = await fs.lstat(sessionFile);
    if (stat.isSymbolicLink()) {
      return false;
    }

    const fh = await fs.open(sessionFile, "r");
    try {
      const rl = readline.createInterface({ input: fh.createReadStream({ encoding: "utf-8" }) });
      let recordCount = 0;
      for await (const line of rl) {
        if (!line.trim()) {
          continue;
        }
        recordCount++;
        if (recordCount > SESSION_FILE_MAX_RECORDS) {
          break;
        }
        let obj: unknown;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const rec = obj as Record<string, unknown> | null;
        if (
          rec?.type === "message" &&
          (rec.message as Record<string, unknown> | undefined)?.role === "assistant"
        ) {
          return true;
        }
      }
      return false;
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

export type PersistSessionEntryParams = {
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath: string;
  entry: SessionEntry;
  clearedFields?: string[];
};

export async function persistSessionEntry(params: PersistSessionEntryParams): Promise<void> {
  const persisted = await updateSessionStore(params.storePath, (store) => {
    const merged = mergeSessionEntry(store[params.sessionKey], params.entry);
    for (const field of params.clearedFields ?? []) {
      if (!Object.hasOwn(params.entry, field)) {
        Reflect.deleteProperty(merged, field);
      }
    }
    store[params.sessionKey] = merged;
    return merged;
  });
  params.sessionStore[params.sessionKey] = persisted;
}

export function resolveFallbackRetryPrompt(params: {
  body: string;
  isFallbackRetry: boolean;
  sessionHasHistory?: boolean;
}): string {
  if (!params.isFallbackRetry) {
    return params.body;
  }
  // When the session has no persisted history (e.g. a freshly-spawned subagent
  // whose first attempt failed before the SessionManager flushed the user
  // message to disk), the fallback model would receive only the generic
  // recovery prompt and lose the original task entirely.  Preserve the
  // original body in that case so the fallback model can execute the task.
  if (!params.sessionHasHistory) {
    return params.body;
  }
  return "Continue where you left off. The previous model attempt failed or timed out.";
}

export function prependInternalEventContext(
  body: string,
  events: AgentCommandOpts["internalEvents"],
): string {
  if (hasInternalRuntimeContext(body)) {
    return body;
  }
  const renderedEvents = formatAgentInternalEventsForPrompt(events);
  if (!renderedEvents) {
    return body;
  }
  return [renderedEvents, body].filter(Boolean).join("\n\n");
}

export function createAcpVisibleTextAccumulator() {
  let pendingSilentPrefix = "";
  let visibleText = "";
  let rawVisibleText = "";
  const startsWithWordChar = (chunk: string): boolean => /^[\p{L}\p{N}]/u.test(chunk);

  const resolveNextCandidate = (base: string, chunk: string): string => {
    if (!base) {
      return chunk;
    }
    if (
      isSilentReplyText(base, SILENT_REPLY_TOKEN) &&
      !chunk.startsWith(base) &&
      startsWithWordChar(chunk)
    ) {
      return chunk;
    }
    if (chunk.startsWith(base) && chunk.length > base.length) {
      return chunk;
    }
    return `${base}${chunk}`;
  };

  const mergeVisibleChunk = (base: string, chunk: string): { rawText: string; delta: string } => {
    if (!base) {
      return { rawText: chunk, delta: chunk };
    }
    if (chunk.startsWith(base) && chunk.length > base.length) {
      const delta = chunk.slice(base.length);
      return { rawText: chunk, delta };
    }
    return {
      rawText: `${base}${chunk}`,
      delta: chunk,
    };
  };

  return {
    consume(chunk: string): { text: string; delta: string } | null {
      if (!chunk) {
        return null;
      }

      if (!visibleText) {
        const leadCandidate = resolveNextCandidate(pendingSilentPrefix, chunk);
        const trimmedLeadCandidate = leadCandidate.trim();
        if (
          isSilentReplyText(trimmedLeadCandidate, SILENT_REPLY_TOKEN) ||
          isSilentReplyPrefixText(trimmedLeadCandidate, SILENT_REPLY_TOKEN)
        ) {
          pendingSilentPrefix = leadCandidate;
          return null;
        }
        // Strip leading NO_REPLY token when it is glued to visible text
        // (e.g. "NO_REPLYThe user is saying...") so the token never leaks.
        if (startsWithSilentToken(trimmedLeadCandidate, SILENT_REPLY_TOKEN)) {
          const stripped = stripLeadingSilentToken(leadCandidate, SILENT_REPLY_TOKEN);
          if (stripped) {
            pendingSilentPrefix = "";
            rawVisibleText = leadCandidate;
            visibleText = stripped;
            return { text: stripped, delta: stripped };
          }
          pendingSilentPrefix = leadCandidate;
          return null;
        }
        if (pendingSilentPrefix) {
          pendingSilentPrefix = "";
          rawVisibleText = leadCandidate;
          visibleText = leadCandidate;
          return {
            text: visibleText,
            delta: leadCandidate,
          };
        }
      }

      const nextVisible = mergeVisibleChunk(rawVisibleText, chunk);
      rawVisibleText = nextVisible.rawText;
      if (!nextVisible.delta) {
        return null;
      }
      visibleText = `${visibleText}${nextVisible.delta}`;
      return { text: visibleText, delta: nextVisible.delta };
    },
    finalize(): string {
      return visibleText.trim();
    },
    finalizeRaw(): string {
      return visibleText;
    },
  };
}

const ACP_TRANSCRIPT_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
} as const;

export async function persistAcpTurnTranscript(params: {
  body: string;
  finalText: string;
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  sessionAgentId: string;
  threadId?: string | number;
  sessionCwd: string;
}): Promise<SessionEntry | undefined> {
  const promptText = params.body;
  const replyText = params.finalText;
  if (!promptText && !replyText) {
    return params.sessionEntry;
  }

  const { sessionFile, sessionEntry } = await resolveSessionTranscriptFile({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    storePath: params.storePath,
    agentId: params.sessionAgentId,
    threadId: params.threadId,
  });
  const hadSessionFile = await fs
    .access(sessionFile)
    .then(() => true)
    .catch(() => false);
  const sessionManager = SessionManager.open(sessionFile);
  await prepareSessionManagerForRun({
    sessionManager,
    sessionFile,
    hadSessionFile,
    sessionId: params.sessionId,
    cwd: params.sessionCwd,
  });

  if (promptText) {
    sessionManager.appendMessage({
      role: "user",
      content: promptText,
      timestamp: Date.now(),
    });
  }

  if (replyText) {
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: replyText }],
      api: "openai-responses",
      provider: "openclaw",
      model: "acp-runtime",
      usage: ACP_TRANSCRIPT_USAGE,
      stopReason: "stop",
      timestamp: Date.now(),
    });
  }

  emitSessionTranscriptUpdate(sessionFile);
  return sessionEntry;
}

export function runAgentAttempt(params: {
  providerOverride: string;
  modelOverride: string;
  cfg: OpenClawConfig;
  sessionEntry: SessionEntry | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  sessionAgentId: string;
  sessionFile: string;
  workspaceDir: string;
  body: string;
  isFallbackRetry: boolean;
  resolvedThinkLevel: ThinkLevel;
  timeoutMs: number;
  runId: string;
  opts: AgentCommandOpts & { senderIsOwner: boolean };
  runContext: ReturnType<typeof resolveAgentRunContext>;
  spawnedBy: string | undefined;
  messageChannel: ReturnType<typeof resolveMessageChannel>;
  skillsSnapshot: ReturnType<typeof buildWorkspaceSkillSnapshot> | undefined;
  resolvedVerboseLevel: VerboseLevel | undefined;
  agentDir: string;
  onAgentEvent: (evt: { stream: string; data?: Record<string, unknown> }) => void;
  authProfileProvider: string;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  allowTransientCooldownProbe?: boolean;
  sessionHasHistory?: boolean;
}) {
  const effectivePrompt = resolveFallbackRetryPrompt({
    body: params.body,
    isFallbackRetry: params.isFallbackRetry,
    sessionHasHistory: params.sessionHasHistory,
  });
  const bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
    params.sessionEntry?.systemPromptReport,
  );
  const bootstrapPromptWarningSignature =
    bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1];
  const authProfileId =
    params.providerOverride === params.authProfileProvider
      ? params.sessionEntry?.authProfileOverride
      : undefined;
  if (isCliProvider(params.providerOverride, params.cfg)) {
    const cliSessionBinding = getCliSessionBinding(params.sessionEntry, params.providerOverride);
    const runCliWithSession = (nextCliSessionId: string | undefined) =>
      runCliAgent({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        agentId: params.sessionAgentId,
        sessionFile: params.sessionFile,
        workspaceDir: params.workspaceDir,
        config: params.cfg,
        prompt: effectivePrompt,
        provider: params.providerOverride,
        model: params.modelOverride,
        thinkLevel: params.resolvedThinkLevel,
        timeoutMs: params.timeoutMs,
        runId: params.runId,
        extraSystemPrompt: params.opts.extraSystemPrompt,
        cliSessionId: nextCliSessionId,
        cliSessionBinding:
          nextCliSessionId === cliSessionBinding?.sessionId ? cliSessionBinding : undefined,
        authProfileId,
        bootstrapPromptWarningSignaturesSeen,
        bootstrapPromptWarningSignature,
        images: params.isFallbackRetry ? undefined : params.opts.images,
        imageOrder: params.isFallbackRetry ? undefined : params.opts.imageOrder,
        skillsSnapshot: params.skillsSnapshot,
        streamParams: params.opts.streamParams,
        messageProvider: params.messageChannel,
        agentAccountId: params.runContext.accountId,
        senderIsOwner: params.opts.senderIsOwner,
      });
    return runCliWithSession(cliSessionBinding?.sessionId).catch(async (err) => {
      if (
        err instanceof FailoverError &&
        err.reason === "session_expired" &&
        cliSessionBinding?.sessionId &&
        params.sessionKey &&
        params.sessionStore &&
        params.storePath
      ) {
        log.warn(
          `CLI session expired, clearing from session store: provider=${sanitizeForLog(params.providerOverride)} sessionKey=${params.sessionKey}`,
        );

        const entry = params.sessionStore[params.sessionKey];
        if (entry) {
          const updatedEntry = { ...entry };
          clearCliSession(updatedEntry, params.providerOverride);
          updatedEntry.updatedAt = Date.now();

          await persistSessionEntry({
            sessionStore: params.sessionStore,
            sessionKey: params.sessionKey,
            storePath: params.storePath,
            entry: updatedEntry,
            clearedFields: ["cliSessionBindings", "cliSessionIds", "claudeCliSessionId"],
          });

          params.sessionEntry = updatedEntry;
        }

        return runCliWithSession(undefined).then(async (result) => {
          if (
            result.meta.agentMeta?.cliSessionBinding?.sessionId &&
            params.sessionKey &&
            params.sessionStore &&
            params.storePath
          ) {
            const entry = params.sessionStore[params.sessionKey];
            if (entry) {
              const updatedEntry = { ...entry };
              setCliSessionBinding(
                updatedEntry,
                params.providerOverride,
                result.meta.agentMeta.cliSessionBinding,
              );
              updatedEntry.updatedAt = Date.now();

              await persistSessionEntry({
                sessionStore: params.sessionStore,
                sessionKey: params.sessionKey,
                storePath: params.storePath,
                entry: updatedEntry,
              });
            }
          }
          return result;
        });
      }
      throw err;
    });
  }

  return runEmbeddedPiAgent({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.sessionAgentId,
    trigger: "user",
    messageChannel: params.messageChannel,
    agentAccountId: params.runContext.accountId,
    messageTo: params.opts.replyTo ?? params.opts.to,
    messageThreadId: params.opts.threadId,
    groupId: params.runContext.groupId,
    groupChannel: params.runContext.groupChannel,
    groupSpace: params.runContext.groupSpace,
    spawnedBy: params.spawnedBy,
    currentChannelId: params.runContext.currentChannelId,
    currentThreadTs: params.runContext.currentThreadTs,
    replyToMode: params.runContext.replyToMode,
    hasRepliedRef: params.runContext.hasRepliedRef,
    senderIsOwner: params.opts.senderIsOwner,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    config: params.cfg,
    skillsSnapshot: params.skillsSnapshot,
    prompt: effectivePrompt,
    images: params.isFallbackRetry ? undefined : params.opts.images,
    imageOrder: params.isFallbackRetry ? undefined : params.opts.imageOrder,
    clientTools: params.opts.clientTools,
    provider: params.providerOverride,
    model: params.modelOverride,
    authProfileId,
    authProfileIdSource: authProfileId ? params.sessionEntry?.authProfileOverrideSource : undefined,
    thinkLevel: params.resolvedThinkLevel,
    verboseLevel: params.resolvedVerboseLevel,
    timeoutMs: params.timeoutMs,
    runId: params.runId,
    lane: params.opts.lane,
    abortSignal: params.opts.abortSignal,
    extraSystemPrompt: params.opts.extraSystemPrompt,
    bootstrapContextMode: params.opts.bootstrapContextMode,
    bootstrapContextRunKind: params.opts.bootstrapContextRunKind,
    internalEvents: params.opts.internalEvents,
    inputProvenance: params.opts.inputProvenance,
    streamParams: params.opts.streamParams,
    agentDir: params.agentDir,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
    cleanupBundleMcpOnRunEnd: params.opts.cleanupBundleMcpOnRunEnd,
    onAgentEvent: params.onAgentEvent,
    bootstrapPromptWarningSignaturesSeen,
    bootstrapPromptWarningSignature,
  });
}

export function buildAcpResult(params: {
  payloadText: string;
  startedAt: number;
  stopReason?: string;
  abortSignal?: AbortSignal;
}) {
  const normalizedFinalPayload = normalizeReplyPayload({
    text: params.payloadText,
  });
  const payloads = normalizedFinalPayload ? [normalizedFinalPayload] : [];
  return {
    payloads,
    meta: {
      durationMs: Date.now() - params.startedAt,
      aborted: params.abortSignal?.aborted === true,
      stopReason: params.stopReason,
    },
  };
}

export function emitAcpLifecycleStart(params: { runId: string; startedAt: number }) {
  emitAgentEvent({
    runId: params.runId,
    stream: "lifecycle",
    data: {
      phase: "start",
      startedAt: params.startedAt,
    },
  });
}

export function emitAcpLifecycleEnd(params: { runId: string }) {
  emitAgentEvent({
    runId: params.runId,
    stream: "lifecycle",
    data: {
      phase: "end",
      endedAt: Date.now(),
    },
  });
}

export function emitAcpLifecycleError(params: { runId: string; message: string }) {
  emitAgentEvent({
    runId: params.runId,
    stream: "lifecycle",
    data: {
      phase: "error",
      error: params.message,
      endedAt: Date.now(),
    },
  });
}

export function emitAcpAssistantDelta(params: { runId: string; text: string; delta: string }) {
  emitAgentEvent({
    runId: params.runId,
    stream: "assistant",
    data: {
      text: params.text,
      delta: params.delta,
    },
  });
}

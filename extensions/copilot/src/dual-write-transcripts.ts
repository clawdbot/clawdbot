/**
 * Mirrors the AgentMessages produced by the copilot agent runtime into the
 * OpenClaw audit transcript that sits next to (but is distinct from) the
 * SDK's own session storage.
 *
 * The OpenClaw shell (src/agents/command/attempt-execution.ts) already
 * writes the user prompt and the terminal assistant text into the
 * transcript at the end of each attempt. That is the bare minimum to
 * keep `/history` working. It does NOT capture tool calls, tool
 * results, or intermediate assistant turns — those live only in the
 * SDK's own session file.
 *
 * For audit/compliance and for the codex-parity guarantees we promised
 * in the proposal, we mirror the full `messagesSnapshot` (user +
 * assistant + toolResult) into the OpenClaw transcript via the same
 * plugin-sdk primitives that the codex extension uses
 * (extensions/codex/src/app-server/transcript-mirror.ts). Both writers
 * cooperate via idempotency-key dedupe: user entries retain a gateway
 * turn key when present; other entries use `${idempotencyScope}:${identity}`.
 * We skip any key already present in the transcript on disk. Both
 * attempt-execution's untagged entries (no idempotencyKey) and our
 * tagged mirror entries can coexist; attempt-execution dedupes its own
 * final-assistant append via `embeddedAssistantGapFill` content match.
 *
 * Failures (lock contention, fs errors, etc.) are swallowed by the
 * caller-side `dualWriteCopilotTranscriptBestEffort` wrapper used
 * in attempt.ts so they cannot break the attempt; this module itself
 * throws on infrastructure failure so callers can choose policy.
 */

import { createHash } from "node:crypto";
import {
  projectAgentHarnessTranscriptMessageForDisplay,
  runAgentHarnessBeforeMessageWriteHook,
  type AgentMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  withSessionTranscriptWriteLock,
  type SessionTranscriptTargetParams,
  type SessionTranscriptWriteLockContext,
  type SessionTranscriptWriteLockParams,
} from "openclaw/plugin-sdk/session-transcript-runtime";

type MirroredAgentMessage = Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }>;

const MIRROR_IDENTITY_META_KEY = "mirrorIdentity" as const;

/**
 * Tag a message with a stable logical identity for mirror dedupe.
 * Callers should use a value that is invariant for the same logical
 * message across re-emits (e.g. `${sdkSessionId}:assistant:${turnIndex}`)
 * but distinct for genuinely-distinct messages. When present this
 * identity replaces the role/content fingerprint in the idempotency
 * key, so the dedupe survives caller-scope rotation without collapsing
 * distinct same-content turns. Symmetric to
 * `attachCodexMirrorIdentity` in the codex extension.
 */
export function attachCopilotMirrorIdentity<T extends AgentMessage>(
  message: T,
  identity: string,
): T {
  const record = message as unknown as Record<string, unknown>;
  const existing = record["__openclaw"];
  const baseMeta =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return {
    ...record,
    __openclaw: { ...baseMeta, [MIRROR_IDENTITY_META_KEY]: identity },
  } as unknown as T;
}

function readMirrorIdentity(message: MirroredAgentMessage): string | undefined {
  const record = message as unknown as { __openclaw?: unknown };
  const meta = record["__openclaw"];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const id = (meta as Record<string, unknown>)[MIRROR_IDENTITY_META_KEY];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function fingerprintMirrorMessageContent(message: MirroredAgentMessage): string {
  const payload = JSON.stringify({ role: message.role, content: message.content });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function buildMirrorDedupeIdentity(message: MirroredAgentMessage): string {
  const explicit = readMirrorIdentity(message);
  if (explicit) {
    return explicit;
  }
  return `${message.role}:${fingerprintMirrorMessageContent(message)}`;
}

interface MirrorCopilotTranscriptParams {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  storePath?: string;
  messages: AgentMessage[];
  /**
   * Stable per-harness/per-thread scope. The codex equivalent uses
   * `codex-app-server:${threadId}`; we use `copilot:${sessionId}`
   * by convention (see attempt.ts call site). Keeping the scope
   * thread-stable (not per-turn) is what lets a re-emitted prior-turn
   * entry collide with its existing on-disk key and be a true no-op.
   */
  idempotencyScope?: string;
  config?: SessionTranscriptWriteLockParams["config"];
}

async function mirrorCopilotTranscript(params: MirrorCopilotTranscriptParams): Promise<void> {
  const messages = params.messages.filter(
    (message): message is MirroredAgentMessage =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult",
  );
  if (messages.length === 0) {
    return;
  }

  const transcriptTarget = resolveCopilotMirrorTranscriptTarget(params);
  await withCopilotMirrorTranscriptWriteLock(
    { ...transcriptTarget, config: params.config },
    async (transcript) => {
      let didAppendMessage = false;
      const existingIdempotencyKeys = readTranscriptIdempotencyKeys(await transcript.readEvents());
      for (const message of messages) {
        const dedupeIdentity = buildMirrorDedupeIdentity(message);
        const sourceIdempotencyKey = (message as unknown as { idempotencyKey?: unknown })
          .idempotencyKey;
        const sourceUserIdempotencyKey =
          message.role === "user" &&
          typeof sourceIdempotencyKey === "string" &&
          sourceIdempotencyKey.trim()
            ? sourceIdempotencyKey.trim()
            : undefined;
        const idempotencyKey =
          sourceUserIdempotencyKey ??
          (params.idempotencyScope ? `${params.idempotencyScope}:${dedupeIdentity}` : undefined);
        if (idempotencyKey && existingIdempotencyKeys.has(idempotencyKey)) {
          continue;
        }
        const transcriptMessage = {
          ...message,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        } as AgentMessage;
        const nextMessage = runAgentHarnessBeforeMessageWriteHook({
          message: transcriptMessage,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
        });
        if (!nextMessage) {
          continue;
        }
        const messageWithIdentity = (
          idempotencyKey
            ? {
                ...(nextMessage as unknown as Record<string, unknown>),
                idempotencyKey,
              }
            : nextMessage
        ) as AgentMessage;
        const messageToAppend = projectAgentHarnessTranscriptMessageForDisplay({
          hidden: (message as { display?: boolean }).display === false,
          message: messageWithIdentity,
        });
        const appended = await transcript.appendMessage({
          message: messageToAppend,
          idempotencyLookup: idempotencyKey ? "caller-checked" : "scan",
        });
        if (!appended) {
          continue;
        }
        didAppendMessage = true;
        if (idempotencyKey) {
          existingIdempotencyKeys.add(idempotencyKey);
        }
      }
      if (didAppendMessage) {
        await transcript.publishUpdate(
          params.sessionKey ? { sessionKey: params.sessionKey } : undefined,
        );
      }
      return didAppendMessage;
    },
  );
}

function resolveCopilotMirrorTranscriptTarget(params: {
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
}): SessionTranscriptTargetParams {
  const sessionKey = params.sessionKey?.trim();
  const storePath = params.storePath?.trim();
  if (!sessionKey || !storePath) {
    throw new Error("Copilot transcript mirror requires a runtime session identity");
  }
  return {
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    sessionKey,
    storePath,
  };
}

function withCopilotMirrorTranscriptWriteLock<T>(
  params: SessionTranscriptTargetParams & { config?: SessionTranscriptWriteLockParams["config"] },
  run: (context: SessionTranscriptWriteLockContext) => Promise<T> | T,
): Promise<T> {
  return withSessionTranscriptWriteLock(params, run);
}

function readTranscriptIdempotencyKeys(events: unknown[]): Set<string> {
  const keys = new Set<string>();
  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      continue;
    }
    const parsed = event as { message?: { idempotencyKey?: unknown } };
    if (typeof parsed.message?.idempotencyKey === "string") {
      keys.add(parsed.message.idempotencyKey);
    }
  }
  return keys;
}

/**
 * Caller-side wrapper that swallows mirror failures. attempt.ts uses
 * this so that a transient transcript-mirror failure (lock contention,
 * disk full, etc.) never breaks an otherwise-successful attempt. The
 * SDK's own session file remains the source of truth in that case;
 * the OpenClaw audit trail just misses the intermediate messages for
 * this turn.
 */
export async function dualWriteCopilotTranscriptBestEffort(
  params: MirrorCopilotTranscriptParams,
): Promise<void> {
  try {
    await mirrorCopilotTranscript(params);
  } catch (error) {
    console.warn("[copilot-attempt] dual-write transcript mirror failed", error);
  }
}

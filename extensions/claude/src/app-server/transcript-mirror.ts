/**
 * Mirror Claude app-server turn output into the OpenClaw session transcript.
 *
 * Mirrors extensions/codex/src/app-server/transcript-mirror.ts at smaller
 * scope. Claude's accumulator already carries the assistant text + tool
 * call/result pairs from event-projector.ts; this module turns those into
 * AgentMessage entries, fires before_message_write hooks (so plugins like
 * provenance can intercept), and appends to the session transcript with
 * stable idempotency keys.
 *
 * Idempotency identity per message:
 *   `claude/${threadId}/${turnId}/${role}/${index}`
 *
 * The threadId+turnId pair plus the per-turn item index uniquely identifies
 * an entry across replay/restart, which means re-running a turn or
 * recovering after a crash won't duplicate transcript entries.
 *
 * Lifecycle outcome integration: callers pass the
 * `lifecycleOutcome` from startOrResumeClaudeThread so the mirror can tag
 * the FIRST assistant message of a resumed thread distinctly from a fresh
 * thread — useful for replay tooling that wants to see transcript origin.
 */

import {
  runAgentHarnessBeforeMessageWriteHook,
  type AgentMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  withSessionTranscriptWriteLock,
  type SessionTranscriptEvent,
  type SessionTranscriptWriteLockParams,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import type { ProjectorAccumulator } from "./event-projector.js";

export type ClaudeTranscriptMirrorParams = {
  sessionId: string;
  sessionKey: string;
  storePath?: string;
  agentId?: string;
  threadId: string;
  turnId: string;
  /**
   * "started" if startOrResumeClaudeThread issued a fresh thread/start;
   * "resumed" if it patched an existing binding;
   * "forked"  if catalog drift triggered a thread/fork (transcript
   *           carried forward from the parent; new SDK session).
   * Tagged into the first mirrored assistant message so replay tooling
   * can distinguish.
   */
  lifecycleOutcome: "started" | "resumed" | "forked";
  acc: ProjectorAccumulator;
  config?: SessionTranscriptWriteLockParams["config"];
};

export async function mirrorClaudeAppServerTranscript(
  params: ClaudeTranscriptMirrorParams,
): Promise<void> {
  const messages = buildMirrorMessages(params);
  if (messages.length === 0) {
    return;
  }

  await withSessionTranscriptWriteLock(
    {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      ...(params.storePath ? { storePath: params.storePath } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.config !== undefined ? { config: params.config } : {}),
    },
    async (context) => {
      const existingIdempotencyKeys = readTranscriptIdempotencyKeys(await context.readEvents());
      for (const message of messages) {
        const idempotencyKey = (message as AgentMessage & { idempotencyKey?: string })
          .idempotencyKey;
        if (idempotencyKey && existingIdempotencyKeys.has(idempotencyKey)) {
          continue;
        }
        const hooked = runAgentHarnessBeforeMessageWriteHook({
          message,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
        });
        if (!hooked) {
          continue;
        }
        const toAppend = (
          idempotencyKey
            ? { ...(hooked as unknown as Record<string, unknown>), idempotencyKey }
            : hooked
        ) as AgentMessage;
        const appendResult = await context.appendMessage({
          message: toAppend,
          ...(idempotencyKey ? { idempotencyLookup: "caller-checked" as const } : {}),
        });
        if (!appendResult) {
          continue;
        }
        if (idempotencyKey) {
          existingIdempotencyKeys.add(idempotencyKey);
        }
        await context.publishUpdate({
          message: appendResult.message,
          messageId: appendResult.messageId,
        });
      }
    },
  );
}

function readTranscriptIdempotencyKeys(events: readonly SessionTranscriptEvent[]): Set<string> {
  const keys = new Set<string>();
  for (const event of events) {
    if (!event || typeof event !== "object") {
      continue;
    }
    const parsed = event as { message?: { idempotencyKey?: unknown } };
    if (typeof parsed.message?.idempotencyKey === "string") {
      keys.add(parsed.message.idempotencyKey);
    }
  }
  return keys;
}

// ── pure helpers (exported for testability) ────────────────────────────────

export function buildMirrorMessages(params: {
  threadId: string;
  turnId: string;
  lifecycleOutcome: "started" | "resumed" | "forked";
  acc: ProjectorAccumulator;
}): AgentMessage[] {
  const out: AgentMessage[] = [];
  // Tool call/result pairs are emitted as toolResult messages so plugins
  // (provenance, vestige, etc.) can score them. We assign a stable index
  // to each based on insertion order in the accumulator's Map.
  let idx = 0;
  for (const [toolCallId, call] of params.acc.toolCalls) {
    out.push({
      role: "toolResult",
      content: stringifyToolResult(call.result),
      meta: {
        toolName: call.name,
        toolCallId,
        isError: call.isError ?? false,
        startedAt: call.startedAt,
        isDynamic: call.isDynamic ?? false,
      },
      idempotencyKey: idempotencyKeyFor({
        threadId: params.threadId,
        turnId: params.turnId,
        role: "toolResult",
        index: idx,
      }),
    } as unknown as AgentMessage);
    idx += 1;
  }

  // Single assistant message per turn (the joined deltas + non-streaming
  // fallback in finalize). When the turn carried reasoning, mirror it as a
  // leading {type:"thinking"} content block on the same message — the shape
  // core already understands (message-visibility.ts skips it for display;
  // extractAssistantThinking reads it for /reasoning on). Text-only turns
  // keep the plain string content so existing transcript bytes are stable.
  if (params.acc.assistantTexts.length > 0) {
    const text = params.acc.assistantTexts.join("");
    const reasoning = params.acc.reasoning.trim();
    out.push({
      role: "assistant",
      content: reasoning
        ? [
            { type: "thinking", thinking: reasoning },
            { type: "text", text },
          ]
        : text,
      meta: {
        lifecycleOutcome: params.lifecycleOutcome,
        threadId: params.threadId,
        turnId: params.turnId,
        toolCount: params.acc.toolCalls.size,
        itemCount: params.acc.itemCount,
      },
      idempotencyKey: idempotencyKeyFor({
        threadId: params.threadId,
        turnId: params.turnId,
        role: "assistant",
        index: 0,
      }),
    } as unknown as AgentMessage);
  }

  return out;
}

export function idempotencyKeyFor(params: {
  threadId: string;
  turnId: string;
  role: string;
  index: number;
}): string {
  return `claude/${params.threadId}/${params.turnId}/${params.role}/${params.index}`;
}

function stringifyToolResult(result: unknown): string {
  if (result == null) {
    return "";
  }
  if (typeof result === "string") {
    return result;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return "[unstringifiable tool result]";
  }
}

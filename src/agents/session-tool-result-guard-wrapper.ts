import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { redactSensitiveText } from "../logging/redact.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  applyInputProvenanceToUserMessage,
  type InputProvenance,
} from "../sessions/input-provenance.js";
import { resolveLiveToolResultMaxChars } from "./pi-embedded-runner/tool-result-truncation.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

type GuardedSessionManager = SessionManager & {
  /** Flush any synthetic tool results for pending tool calls. Idempotent. */
  flushPendingToolResults?: () => void;
  /** Clear pending tool calls without persisting synthetic tool results. Idempotent. */
  clearPendingToolResults?: () => void;
};

function redactTranscriptText(value: string, cfg?: OpenClawConfig): string {
  if (cfg?.logging?.redactSensitive === "off") {
    return value;
  }
  return redactSensitiveText(value, {
    mode: cfg?.logging?.redactSensitive,
    patterns: cfg?.logging?.redactPatterns,
  });
}

function redactTranscriptContentBlock(block: unknown, cfg?: OpenClawConfig): unknown {
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return block;
  }
  const source = block as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  const assign = (key: string, value: string) => {
    const redacted = redactTranscriptText(value, cfg);
    if (redacted === value) {
      return;
    }
    next ??= { ...source };
    next[key] = redacted;
  };

  if (typeof source.text === "string") {
    assign("text", source.text);
  }
  if (typeof source.thinking === "string") {
    assign("thinking", source.thinking);
  }
  if (typeof source.partialJson === "string") {
    assign("partialJson", source.partialJson);
  }
  return next ?? block;
}

function redactTranscriptContent(content: unknown, cfg?: OpenClawConfig): unknown {
  if (typeof content === "string") {
    return redactTranscriptText(content, cfg);
  }
  if (!Array.isArray(content)) {
    return content;
  }
  let changed = false;
  const redacted = content.map((block) => {
    const next = redactTranscriptContentBlock(block, cfg);
    changed ||= next !== block;
    return next;
  });
  return changed ? redacted : content;
}

function redactTranscriptMessage(message: AgentMessage, cfg?: OpenClawConfig): AgentMessage {
  const source = message as unknown as Record<string, unknown>;
  const redactedContent = redactTranscriptContent(source.content, cfg);
  if (redactedContent === source.content) {
    return message;
  }
  return {
    ...source,
    content: redactedContent,
  } as unknown as AgentMessage;
}

/**
 * Apply the tool-result guard to a SessionManager exactly once and expose
 * a flush method on the instance for easy teardown handling.
 */
export function guardSessionManager(
  sessionManager: SessionManager,
  opts?: {
    agentId?: string;
    sessionKey?: string;
    config?: OpenClawConfig;
    contextWindowTokens?: number;
    inputProvenance?: InputProvenance;
    allowSyntheticToolResults?: boolean;
    missingToolResultText?: string;
    allowedToolNames?: Iterable<string>;
    suppressNextUserMessagePersistence?: boolean;
    onUserMessagePersisted?: (
      message: Extract<AgentMessage, { role: "user" }>,
    ) => void | Promise<void>;
  },
): GuardedSessionManager {
  if (typeof (sessionManager as GuardedSessionManager).flushPendingToolResults === "function") {
    return sessionManager as GuardedSessionManager;
  }

  const hookRunner = getGlobalHookRunner();
  const beforeMessageWrite = (event: {
    message: import("@earendil-works/pi-agent-core").AgentMessage;
  }) => {
    let message = event.message;
    let changed = false;
    if (hookRunner?.hasHooks("before_message_write")) {
      const result = hookRunner.runBeforeMessageWrite(event, {
        agentId: opts?.agentId,
        sessionKey: opts?.sessionKey,
      });
      if (result?.block) {
        return result;
      }
      if (result?.message) {
        message = result.message;
        changed = true;
      }
    }
    const redacted = redactTranscriptMessage(message, opts?.config);
    if (redacted !== message) {
      message = redacted;
      changed = true;
    }
    return changed ? { message } : undefined;
  };

  const transform = hookRunner?.hasHooks("tool_result_persist")
    ? (
        message: AgentMessage,
        meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
      ) => {
        const out = hookRunner.runToolResultPersist(
          {
            toolName: meta.toolName,
            toolCallId: meta.toolCallId,
            message,
            isSynthetic: meta.isSynthetic,
          },
          {
            agentId: opts?.agentId,
            sessionKey: opts?.sessionKey,
            toolName: meta.toolName,
            toolCallId: meta.toolCallId,
          },
        );
        return out?.message ?? message;
      }
    : undefined;

  const guard = installSessionToolResultGuard(sessionManager, {
    sessionKey: opts?.sessionKey,
    transformMessageForPersistence: (message) =>
      applyInputProvenanceToUserMessage(message, opts?.inputProvenance),
    transformToolResultForPersistence: transform,
    allowSyntheticToolResults: opts?.allowSyntheticToolResults,
    missingToolResultText: opts?.missingToolResultText,
    allowedToolNames: opts?.allowedToolNames,
    beforeMessageWriteHook: beforeMessageWrite,
    maxToolResultChars:
      typeof opts?.contextWindowTokens === "number"
        ? resolveLiveToolResultMaxChars({
            contextWindowTokens: opts.contextWindowTokens,
            cfg: opts.config,
            agentId: opts.agentId,
          })
        : undefined,
    suppressNextUserMessagePersistence: opts?.suppressNextUserMessagePersistence,
    onUserMessagePersisted: opts?.onUserMessagePersisted,
  });
  (sessionManager as GuardedSessionManager).flushPendingToolResults = guard.flushPendingToolResults;
  (sessionManager as GuardedSessionManager).clearPendingToolResults = guard.clearPendingToolResults;
  return sessionManager as GuardedSessionManager;
}

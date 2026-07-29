// Shared directive parsing helpers used by model and auth directive handlers.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { formatCliCommand } from "../../cli/command-format.js";
import { SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS } from "../../config/sessions/session-snapshot-merge.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { SYSTEM_MARK, prefixSystemMessage } from "../../infra/system-message.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import type { ElevatedLevel, ReasoningLevel } from "./directives.js";

export const formatDirectiveAck = (text: string): string => {
  return prefixSystemMessage(text);
};

const formatOptionsLine = (options: string) => `Options: ${options}.`;
export const withOptions = (line: string, options: string) =>
  `${line}\n${formatOptionsLine(options)}`;

export const formatElevatedRuntimeHint = () =>
  `${SYSTEM_MARK} Runtime is direct; sandboxing does not apply.`;

export const formatInternalExecPersistenceDeniedText = () =>
  "Exec defaults require operator.admin for gateway callers; skipped persistence.";

export const formatInternalVerbosePersistenceDeniedText = () =>
  "Verbose defaults require operator.admin for gateway callers; skipped persistence.";

export const formatInternalVerboseCurrentReplyOnlyText = () =>
  "Verbose logging set for the current reply only.";

export function canPersistSessionDirectiveDefaults(params: {
  messageProvider?: string;
  surface?: string;
  gatewayClientScopes?: string[];
  commandAuthorized?: boolean;
  senderIsOwner?: boolean;
}): boolean {
  const messageProvider = normalizeOptionalString(params.messageProvider);
  const surface = normalizeOptionalString(params.surface);
  const authoritativeChannel = messageProvider ?? surface;

  if (!authoritativeChannel) {
    return true;
  }

  if (isInternalMessageChannel(authoritativeChannel)) {
    return params.gatewayClientScopes?.includes("operator.admin") === true;
  }

  return params.commandAuthorized === true || params.senderIsOwner === true;
}

/** Names explicit directive writes that snapshot equality cannot infer. */
export function resolveDirectiveTouchedSessionFields(params: {
  directives: InlineDirectives;
  allowInternalExecPersistence: boolean;
  allowInternalVerbosePersistence: boolean;
}): Array<keyof SessionEntry> {
  const { directives } = params;
  const fields = new Set<keyof SessionEntry>();
  if (directives.hasThinkDirective) {
    fields.add("thinkingLevel");
  }
  if (directives.hasFastDirective) {
    fields.add("fastMode");
  }
  if (directives.hasVerboseDirective && params.allowInternalVerbosePersistence) {
    fields.add("verboseLevel");
  }
  if (directives.hasTraceDirective) {
    fields.add("traceLevel");
  }
  if (directives.hasReasoningDirective) {
    fields.add("reasoningLevel");
  }
  if (directives.hasElevatedDirective) {
    fields.add("elevatedLevel");
  }
  if (directives.hasModelDirective) {
    for (const field of SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS) {
      fields.add(field);
    }
  }
  if (directives.hasExecDirective && params.allowInternalExecPersistence) {
    if (directives.execHost) {
      fields.add("execHost");
    }
    if (directives.execSecurity) {
      fields.add("execSecurity");
    }
    if (directives.execAsk) {
      fields.add("execAsk");
    }
    if (directives.execNode) {
      fields.add("execNode");
    }
  }
  if (directives.hasQueueDirective) {
    if (directives.queueReset || directives.queueMode) {
      fields.add("queueMode");
    }
    if (directives.queueReset || typeof directives.debounceMs === "number") {
      fields.add("queueDebounceMs");
    }
    if (directives.queueReset || typeof directives.cap === "number") {
      fields.add("queueCap");
    }
    if (directives.queueReset || directives.dropPolicy) {
      fields.add("queueDrop");
    }
  }
  return [...fields];
}

const formatElevatedEvent = (level: ElevatedLevel) => {
  if (level === "full") {
    return "Elevated FULL - exec runs on host with auto-approval.";
  }
  if (level === "ask" || level === "on") {
    return "Elevated ASK - exec runs on host; approvals may still apply.";
  }
  return "Elevated OFF - exec stays in sandbox.";
};

const formatReasoningEvent = (level: ReasoningLevel) => {
  if (level === "stream") {
    return "Reasoning STREAM - emit live <think>.";
  }
  if (level === "on") {
    return "Reasoning ON - include <think>.";
  }
  return "Reasoning OFF - hide <think>.";
};

export function enqueueModeSwitchEvents(params: {
  enqueueSystemEvent: (text: string, meta: { sessionKey: string; contextKey: string }) => void;
  sessionEntry: { elevatedLevel?: string | null; reasoningLevel?: string | null };
  sessionKey: string;
  elevatedChanged?: boolean;
  reasoningChanged?: boolean;
}): void {
  if (params.elevatedChanged) {
    const nextElevated = (params.sessionEntry.elevatedLevel ?? "off") as ElevatedLevel;
    params.enqueueSystemEvent(formatElevatedEvent(nextElevated), {
      sessionKey: params.sessionKey,
      contextKey: "mode:elevated",
    });
  }
  if (params.reasoningChanged) {
    const nextReasoning = (params.sessionEntry.reasoningLevel ?? "off") as ReasoningLevel;
    params.enqueueSystemEvent(formatReasoningEvent(nextReasoning), {
      sessionKey: params.sessionKey,
      contextKey: "mode:reasoning",
    });
  }
}

export function formatElevatedUnavailableText(params: {
  runtimeSandboxed: boolean;
  failures?: Array<{ gate: string; key: string }>;
  sessionKey?: string;
}): string {
  const lines: string[] = [];
  lines.push(
    `elevated is not available right now (runtime=${params.runtimeSandboxed ? "sandboxed" : "direct"}).`,
  );
  const failures = params.failures ?? [];
  if (failures.length > 0) {
    lines.push(`Failing gates: ${failures.map((f) => `${f.gate} (${f.key})`).join(", ")}`);
  } else {
    lines.push(
      "Fix-it keys: tools.elevated.enabled, tools.elevated.allowFrom.<provider>, agents.entries.*.tools.elevated.*",
    );
  }
  if (params.sessionKey) {
    lines.push(
      `See: ${formatCliCommand(`openclaw sandbox explain --session ${params.sessionKey}`)}`,
    );
  }
  return lines.join("\n");
}

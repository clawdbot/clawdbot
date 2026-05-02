import { formatCliCommand } from "../../cli/command-format.js";
import { SYSTEM_MARK, prefixSystemMessage } from "../../infra/system-message.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
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
  "Exec defaults require operator.admin for internal gateway callers; skipped persistence.";

export const formatInternalVerbosePersistenceDeniedText = () =>
  "Verbose defaults require operator.admin for internal gateway callers; skipped persistence.";

export const formatInternalVerboseCurrentReplyOnlyText = () =>
  "Verbose logging set for the current reply only.";

function canPersistInternalDirective(params: {
  messageProvider?: string;
  surface?: string;
  gatewayClientScopes?: string[];
}): boolean {
  const authoritativeChannel = isInternalMessageChannel(params.messageProvider)
    ? params.messageProvider
    : params.surface;
  if (!isInternalMessageChannel(authoritativeChannel)) {
    return true;
  }
  const scopes = params.gatewayClientScopes ?? [];
  return scopes.includes("operator.admin");
}

export const canPersistInternalExecDirective = canPersistInternalDirective;
export const canPersistInternalVerboseDirective = canPersistInternalDirective;

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
      "Fix-it keys: tools.elevated.enabled, tools.elevated.allowFrom.<provider>, agents.list[].tools.elevated.*",
    );
  }
  if (params.sessionKey) {
    lines.push(
      `See: ${formatCliCommand(`openclaw sandbox explain --session ${params.sessionKey}`)}`,
    );
  }
  return lines.join("\n");
}

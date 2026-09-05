// Shared directive parsing helpers used by model and auth directive handlers.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AgentModelPrimaryWriteTarget } from "../../agents/agent-scope.js";
import type { StickyModelSelectionDispatchOutcome } from "../../agents/sticky-model-selection.js";
import { formatCliCommand } from "../../cli/command-format.js";
import {
  adoptPersistedSessionSnapshot,
  SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS,
  sessionModelOverrideChangesApplied,
  sessionSnapshotChangesApplied,
} from "../../config/sessions/session-snapshot-merge.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { SYSTEM_MARK, prefixSystemMessage } from "../../infra/system-message.js";
import { applyTraceOverride, applyVerboseOverride } from "../../sessions/level-overrides.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import type { ReplyPayload } from "../types.js";
import type { HandleDirectiveOnlyParams } from "./directive-handling.params.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import type { ElevatedLevel, ReasoningLevel } from "./directives.js";
import { persistReplySessionEntry } from "./session-entry-persistence.js";

export const DIRECTIVE_ACK_MESSAGES = {
  verbose: {
    off: "Verbose logging disabled.",
    on: "Verbose logging enabled.",
    full: "Verbose logging set to full.",
  },
  trace: {
    off: "Trace disabled.",
    on: "Trace enabled. Warning: trace output may contain sensitive information.",
    raw: "Trace set to raw. Warning: trace output may contain sensitive information.",
  },
  reasoning: {
    off: "Reasoning visibility disabled.",
    on: "Reasoning visibility enabled.",
    stream: "Reasoning stream enabled.",
  },
  elevated: {
    off: "Elevated mode disabled.",
    on: "Elevated mode set to ask (approvals may still apply).",
    ask: "Elevated mode set to ask (approvals may still apply).",
    full: "Elevated mode set to full (auto-approve).",
  },
} as const;

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

export function formatModelSelectionScopeAck(params: {
  isDefault: boolean;
  label: string;
  configuredDefaultUpdate?: StickyModelSelectionDispatchOutcome;
  stickyModelSelectionTarget?: AgentModelPrimaryWriteTarget;
}): string {
  if (params.isDefault && !params.stickyModelSelectionTarget) {
    return `Session model reset to configured default (${params.label}).`;
  }
  const targetLabel =
    params.stickyModelSelectionTarget === "agent"
      ? "Agent default"
      : params.stickyModelSelectionTarget === "defaults"
        ? "Global default"
        : "Configured default";
  if (params.configuredDefaultUpdate === "requested") {
    return `Model set to ${params.label} for this session. ${targetLabel} update requested.`;
  }
  if (params.configuredDefaultUpdate === "skipped-immutable") {
    return `Model set to ${params.label} for this session. ${targetLabel} unchanged because configuration is immutable.`;
  }
  return `Model set to ${params.label} for this session only; configured default unchanged.`;
}

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

const SESSION_LEVEL_DIRECTIVE_FIELDS = [
  ["hasThinkDirective", "thinkingLevel"],
  ["hasFastDirective", "fastMode"],
  ["hasVerboseDirective", "verboseLevel"],
  ["hasTraceDirective", "traceLevel"],
  ["hasReasoningDirective", "reasoningLevel"],
  ["hasElevatedDirective", "elevatedLevel"],
] as const satisfies ReadonlyArray<readonly [keyof InlineDirectives, keyof SessionEntry]>;

const SESSION_EXEC_DIRECTIVE_FIELDS = ["execHost", "execNode"] as const satisfies ReadonlyArray<
  keyof InlineDirectives & keyof SessionEntry
>;

const SESSION_QUEUE_DIRECTIVE_FIELDS = [
  ["queueMode", "queueMode"],
  ["debounceMs", "queueDebounceMs"],
  ["cap", "queueCap"],
  ["dropPolicy", "queueDrop"],
] as const satisfies ReadonlyArray<readonly [keyof InlineDirectives, keyof SessionEntry]>;

/** Names explicit directive writes that snapshot equality cannot infer. */
export function resolveDirectiveTouchedSessionFields(params: {
  directives: InlineDirectives;
  allowPrivilegedPersistence: boolean;
}): Array<keyof SessionEntry> {
  const { directives } = params;
  const fields = new Set<keyof SessionEntry>();
  for (const [directiveField, sessionField] of SESSION_LEVEL_DIRECTIVE_FIELDS) {
    if (
      directives[directiveField] &&
      (sessionField !== "verboseLevel" || params.allowPrivilegedPersistence)
    ) {
      fields.add(sessionField);
    }
  }
  if (directives.hasModelDirective) {
    for (const field of SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS) {
      fields.add(field);
    }
  }
  if (directives.hasExecDirective && params.allowPrivilegedPersistence) {
    for (const field of SESSION_EXEC_DIRECTIVE_FIELDS) {
      if (directives[field]) {
        fields.add(field);
      }
    }
  }
  if (directives.hasQueueDirective) {
    for (const [directiveField, sessionField] of SESSION_QUEUE_DIRECTIVE_FIELDS) {
      const value = directives[directiveField];
      if (directives.queueReset || typeof value === "number" || Boolean(value)) {
        fields.add(sessionField);
      }
    }
  }
  return [...fields];
}

export type IgnoredSessionDirectiveFlag = Extract<keyof InlineDirectives, `has${string}Directive`>;

export function rejectSessionDirectiveTransaction(
  persistenceState: HandleDirectiveOnlyParams["persistenceState"],
  errorText: string,
): ReplyPayload {
  if (persistenceState) {
    persistenceState.outcome = { kind: "rejected", errorText };
  }
  return { text: errorText, isError: true };
}

/** Keeps the first informational/denied acknowledgement while committing valid siblings once. */
export async function acknowledgeIgnoredSessionDirective(params: {
  reply: ReplyPayload;
  directives: InlineDirectives;
  ignoredDirective: IgnoredSessionDirectiveFlag;
  persistenceState: HandleDirectiveOnlyParams["persistenceState"];
  allowPrivilegedPersistence: boolean;
  applyRemainingDirectives: (directives: InlineDirectives) => Promise<ReplyPayload | undefined>;
}): Promise<ReplyPayload> {
  if (!params.persistenceState) {
    return params.reply;
  }
  const { directives, ignoredDirective } = params;
  const remainingDirectives =
    ignoredDirective === "hasExecDirective" && directives.hasExecOptions
      ? {
          ...directives,
          invalidExecHost: false,
          invalidExecSecurity: false,
          invalidExecAsk: false,
          invalidExecNode: false,
        }
      : {
          ...directives,
          [ignoredDirective]: false,
          ...(ignoredDirective === "hasThinkDirective" ? { clearThinkLevel: false } : {}),
          ...(ignoredDirective === "hasFastDirective" ? { clearFastMode: false } : {}),
          ...(ignoredDirective === "hasModelDirective" ? { rawModelProfile: undefined } : {}),
        };
  const touchedFields = resolveDirectiveTouchedSessionFields({
    directives: remainingDirectives,
    allowPrivilegedPersistence: params.allowPrivilegedPersistence,
  });
  if (touchedFields.length > 0) {
    const siblingReply = await params.applyRemainingDirectives(remainingDirectives);
    if (params.persistenceState.outcome.kind === "rejected") {
      return siblingReply ?? params.reply;
    }
  }
  return params.reply;
}

/** Applies canonical session settings while each caller retains its authorization boundaries. */
export function applySessionDirectiveFields(params: {
  directives: InlineDirectives;
  sessionEntry: SessionEntry;
  allowPrivilegedPersistence: boolean;
  allowTracePersistence: boolean;
  allowElevatedPersistence: boolean;
  persistDirectiveOnlyFields: boolean;
}): boolean {
  const { directives, sessionEntry } = params;
  let updated = false;
  const updateField = <Field extends keyof SessionEntry>(
    field: Field,
    value: SessionEntry[Field],
  ) => {
    sessionEntry[field] = value;
    updated = true;
  };

  if (directives.clearThinkLevel) {
    if (sessionEntry.thinkingLevel) {
      delete sessionEntry.thinkingLevel;
      updated = true;
    }
  } else if (directives.hasThinkDirective && directives.thinkLevel) {
    updateField("thinkingLevel", directives.thinkLevel);
  }
  if (directives.clearFastMode) {
    if (sessionEntry.fastMode !== undefined) {
      delete sessionEntry.fastMode;
      updated = true;
    }
  } else if (
    params.persistDirectiveOnlyFields &&
    directives.hasFastDirective &&
    directives.fastMode !== undefined
  ) {
    updateField("fastMode", directives.fastMode);
  }
  if (
    directives.hasVerboseDirective &&
    directives.verboseLevel &&
    params.allowPrivilegedPersistence
  ) {
    applyVerboseOverride(sessionEntry, directives.verboseLevel);
    updated = true;
  }
  if (directives.hasTraceDirective && directives.traceLevel && params.allowTracePersistence) {
    applyTraceOverride(sessionEntry, directives.traceLevel);
    updated = true;
  }
  if (directives.hasReasoningDirective && directives.reasoningLevel) {
    // Explicit off remains stored so provider defaults cannot re-enable reasoning.
    updateField("reasoningLevel", directives.reasoningLevel);
  }
  if (
    directives.hasElevatedDirective &&
    directives.elevatedLevel &&
    params.allowElevatedPersistence
  ) {
    // Elevated defaults can be on, so an explicit off must also remain stored.
    updateField("elevatedLevel", directives.elevatedLevel);
  }
  if (
    directives.hasExecDirective &&
    directives.hasExecOptions &&
    params.allowPrivilegedPersistence
  ) {
    for (const field of SESSION_EXEC_DIRECTIVE_FIELDS) {
      const value = directives[field];
      if (value) {
        updateField(field, value);
      }
    }
  }
  if (directives.hasQueueDirective && directives.queueReset) {
    for (const [, field] of SESSION_QUEUE_DIRECTIVE_FIELDS) {
      delete sessionEntry[field];
    }
    updated = true;
  } else if (directives.hasQueueDirective && params.persistDirectiveOnlyFields) {
    for (const [directiveField, sessionField] of SESSION_QUEUE_DIRECTIVE_FIELDS) {
      const value = directives[directiveField];
      if (typeof value === "number" || value) {
        updateField(sessionField, value);
      }
    }
  }
  return updated;
}

/** Commits a directive snapshot only when its touched fields still win the session transaction. */
export async function persistSessionDirectiveSnapshot(params: {
  storePath: string;
  sessionKey: string;
  initialEntry: SessionEntry;
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  touchedFields: Array<keyof SessionEntry>;
  hasModelSelection: boolean;
  reassertLiveModelSwitchPending: boolean;
  validateCommit?: () => string | undefined;
}): Promise<
  | { status: "applied" | "conflict" | "model-selection-locked" }
  | { status: "commit-rejected"; error: string }
> {
  const { sessionEntry, sessionKey, sessionStore } = params;
  const persistence = await persistReplySessionEntry({
    storePath: params.storePath,
    sessionKey,
    initialEntry: params.initialEntry,
    entry: sessionEntry,
    reassertLiveModelSwitchPending: params.reassertLiveModelSwitchPending,
    requireModelSelectionUnlocked: params.hasModelSelection,
    touchedFields: params.touchedFields,
    validateCommit: params.validateCommit,
  });
  if (persistence.status !== "current") {
    if (persistence.entry) {
      sessionStore[sessionKey] = persistence.entry;
      adoptPersistedSessionSnapshot(sessionEntry, persistence.entry);
    }
    if (persistence.status === "commit-rejected") {
      return persistence;
    }
    return {
      status: persistence.status === "model-selection-locked" ? persistence.status : "conflict",
    };
  }

  const persistedEntry = persistence.entry;
  sessionStore[sessionKey] = persistedEntry;
  const sessionChangesApplied = sessionSnapshotChangesApplied({
    initial: params.initialEntry,
    next: sessionEntry,
    current: persistedEntry,
    touchedFields: params.touchedFields,
  });
  const modelSelectionApplied =
    !params.hasModelSelection ||
    (sessionChangesApplied &&
      sessionModelOverrideChangesApplied({
        initial: params.initialEntry,
        next: sessionEntry,
        current: persistedEntry,
        reassertLiveModelSwitchPending: params.reassertLiveModelSwitchPending,
      }));
  adoptPersistedSessionSnapshot(sessionEntry, persistedEntry);
  return { status: sessionChangesApplied && modelSelectionApplied ? "applied" : "conflict" };
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

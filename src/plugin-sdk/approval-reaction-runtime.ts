import { sanitizeForPromptLiteral } from "../agents/sanitize-for-prompt.js";
import { formatApprovalDisplayPath } from "../infra/approval-display-paths.js";
import { buildPendingApprovalView } from "../infra/approval-view-model.js";
import type { ApprovalRequest, PendingApprovalView } from "../infra/approval-view-model.types.js";
import {
  buildExecApprovalPendingReplyPayload,
  formatExecApprovalExpiresIn,
  type ExecApprovalPendingReplyParams,
  type ExecApprovalReplyDecision,
} from "../infra/exec-approval-reply.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
/**
 * @deprecated Compatibility subpath for shipped approval reaction helpers.
 * New plugin code should use the focused approval runtime/reply subpaths.
 */
import { formatFencedCodeBlock } from "../shared/markdown-code.js";
import {
  buildApprovalPendingReplyPayload,
  buildPluginApprovalPendingReplyPayload,
} from "./approval-renderers.js";
export { shouldSuppressLocalNativeExecApprovalPrompt } from "./approval-native-helpers.js";
import type { ReplyPayload } from "./reply-payload.js";

type ApprovalKind = "exec" | "plugin";
type KeyedStore<TValue> = {
  register(key: string, value: TValue, opts?: { ttlMs?: number }): Promise<void>;
  lookup(key: string): Promise<TValue | undefined>;
  delete(key: string): Promise<boolean>;
};

type PersistedApprovalReactionTarget<TTarget> = {
  version: 1;
  target: TTarget;
};

type InMemoryApprovalReactionTarget<TTarget> = {
  target: TTarget;
  expiresAtMs: number;
};

/** In-memory or backed store for approval targets awaiting reaction decisions. */
export type ApprovalReactionTargetStore<TTarget> = {
  register(key: string, target: TTarget, opts?: { ttlMs?: number }): void;
  lookup(key: string): Promise<TTarget | null>;
  delete(key: string): void;
  clearForTest(): void;
};

/** Product-ordered emoji binding for one approval decision. */
export type ApprovalReactionDecisionBinding = {
  decision: ExecApprovalReplyDecision;
  emoji: string;
  label: string;
};

/** Normalized reaction decision resolved from a channel reaction key. */
export type ApprovalReactionDecisionResolution = {
  decision: ExecApprovalReplyDecision;
  normalizedEmoji: string;
};

/** Stored target metadata needed to convert a reaction into an approval decision. */
export type ApprovalReactionTargetRecord<TRoute = unknown> = {
  approvalId: string;
  /** Explicit ownership; omission is supported only by the deprecated resolver. */
  approvalKind?: ApprovalKind;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
  route?: TRoute;
  expiresAtMs?: number;
};

/** Resolved approval target and decision produced from a reaction event. */
export type ApprovalReactionTargetResolution<TRoute = unknown> =
  ApprovalReactionDecisionResolution & {
    approvalId: string;
    approvalKind: ApprovalKind;
    route?: TRoute;
  };

/** Reply payload enriched with reaction decision metadata. */
export type ApprovalReactionPromptPayload = ReplyPayload & {
  allowedDecisions: readonly ExecApprovalReplyDecision[];
  reactionBindings: readonly ApprovalReactionDecisionBinding[];
};

/** Pair of reaction-enabled and manual-fallback approval prompt payloads. */
export type ApprovalReactionPendingContent = {
  reactionPayload: ApprovalReactionPromptPayload;
  manualFallbackPayload: ReplyPayload;
};

/** Canonical reaction controls shown for approval prompts, in product display order. */
export const APPROVAL_REACTION_BINDINGS = [
  { decision: "allow-once", emoji: "👍", label: "Allow Once" },
  { decision: "allow-always", emoji: "♾️", label: "Allow Always" },
  { decision: "deny", emoji: "👎", label: "Deny" },
] as const satisfies readonly ApprovalReactionDecisionBinding[];

const APPROVAL_REACTION_ORDER = APPROVAL_REACTION_BINDINGS.map((binding) => binding.decision);
const VARIATION_SELECTOR_RE = /[\uFE0E\uFE0F]/gu;
const FITZPATRICK_MODIFIER_RE = /[\u{1F3FB}-\u{1F3FF}]/gu;

function normalizeDecisionList(
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): ExecApprovalReplyDecision[] {
  const allowed = new Set(allowedDecisions);
  return APPROVAL_REACTION_ORDER.filter((decision) => allowed.has(decision));
}

/** List the canonical reaction bindings allowed for a specific approval request. */
export function listApprovalReactionBindings(params: {
  allowedDecisions: readonly ExecApprovalReplyDecision[];
}): ApprovalReactionDecisionBinding[] {
  const allowed = new Set(normalizeDecisionList(params.allowedDecisions));
  return APPROVAL_REACTION_BINDINGS.filter((binding) => allowed.has(binding.decision)).map(
    (binding) => ({
      decision: binding.decision,
      emoji: binding.emoji,
      label: binding.label,
    }),
  );
}

/** Build user-facing reaction instructions, or null when no reaction decisions are allowed. */
export function buildApprovalReactionHint(params: {
  allowedDecisions: readonly ExecApprovalReplyDecision[];
}): string | null {
  const bindings = listApprovalReactionBindings(params);
  if (bindings.length === 0) {
    return null;
  }
  return `React with:\n\n${bindings.map((binding) => `${binding.emoji} ${binding.label}`).join("\n")}`;
}

const APPROVAL_REACTION_HINT_PRESENT_RE = /(^|\n)React with:\s*(\n|$)/i;

/** True when approval prompt text already carries a reaction hint block. */
export function hasApprovalReactionHintText(text?: string | null): boolean {
  return APPROVAL_REACTION_HINT_PRESENT_RE.test(text ?? "");
}

/** Inserts a reaction hint after the `ID: <id>` header line, else prepends it. */
export function insertApprovalReactionHintNearIdHeader(params: {
  text: string;
  hint: string;
}): string {
  const lines = params.text.split(/\r?\n/);
  const idLineIndex = lines.findIndex((line) => /^ID:\s*\S+/.test(line.trim()));
  if (idLineIndex >= 0) {
    const before = lines.slice(0, idLineIndex + 1).join("\n");
    const after = lines
      .slice(idLineIndex + 1)
      .join("\n")
      .replace(/^\n+/, "");
    return after ? `${before}\n\n${params.hint}\n\n${after}` : `${before}\n\n${params.hint}`;
  }
  return `${params.hint}\n\n${params.text}`;
}

/** Adds the canonical reaction hint to approval prompt text unless one is present. */
export function addApprovalReactionHintToText(params: {
  text: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
}): string {
  if (hasApprovalReactionHintText(params.text)) {
    return params.text;
  }
  const hint = buildApprovalReactionHint({ allowedDecisions: params.allowedDecisions });
  return hint ? insertApprovalReactionHintNearIdHeader({ text: params.text, hint }) : params.text;
}

/** Normalize reaction emoji so skin-tone and text/presentation variants match canonical bindings. */
export function normalizeApprovalReactionEmoji(reactionKey: string): string {
  const normalized = reactionKey
    .trim()
    .replace(VARIATION_SELECTOR_RE, "")
    .replace(FITZPATRICK_MODIFIER_RE, "");
  // Infinity commonly arrives without the emoji variation selector; restore the canonical binding.
  if (normalized === "♾") {
    return "♾️";
  }
  return normalized;
}

/** Resolve a reaction key to an allowed approval decision. */
export function resolveApprovalReactionDecision(params: {
  reactionKey: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
}): ApprovalReactionDecisionResolution | null {
  const normalizedEmoji = normalizeApprovalReactionEmoji(params.reactionKey);
  if (!normalizedEmoji) {
    return null;
  }
  for (const binding of listApprovalReactionBindings(params)) {
    if (binding.emoji === normalizedEmoji) {
      return { decision: binding.decision, normalizedEmoji };
    }
  }
  return null;
}

function resolveApprovalReactionTargetInternal<TRoute>(params: {
  target: ApprovalReactionTargetRecord<TRoute> | null | undefined;
  reactionKey: string;
  allowLegacyKindInference: boolean;
}): ApprovalReactionTargetResolution<TRoute> | null {
  const target = params.target;
  if (!target) {
    return null;
  }
  const decision = resolveApprovalReactionDecision({
    reactionKey: params.reactionKey,
    allowedDecisions: target.allowedDecisions,
  });
  if (!decision) {
    return null;
  }
  // Typed targets already carry canonical protocol identity. Preserve it byte-for-byte;
  // only the shipped ownerless path retains its historical trimming behavior.
  const approvalId = params.allowLegacyKindInference ? target.approvalId.trim() : target.approvalId;
  const approvalKind = target.approvalKind;
  if (!approvalId) {
    return null;
  }
  const resolvedKind =
    approvalKind === "exec" || approvalKind === "plugin"
      ? approvalKind
      : params.allowLegacyKindInference
        ? approvalId.startsWith("plugin:")
          ? "plugin"
          : "exec"
        : null;
  if (!resolvedKind) {
    return null;
  }
  return {
    approvalId,
    approvalKind: resolvedKind,
    decision: decision.decision,
    normalizedEmoji: decision.normalizedEmoji,
    ...(target.route === undefined ? {} : { route: target.route }),
  };
}

/**
 * Resolve a stored target while retaining shipped id-based ownership inference.
 * @deprecated Use resolveTypedApprovalReactionTarget with an explicit approvalKind.
 */
export function resolveApprovalReactionTarget<TRoute = unknown>(params: {
  target: ApprovalReactionTargetRecord<TRoute> | null | undefined;
  reactionKey: string;
}): ApprovalReactionTargetResolution<TRoute> | null {
  return resolveApprovalReactionTargetInternal({
    ...params,
    allowLegacyKindInference: true,
  });
}

/** Resolve an explicitly typed target without deriving ownership from its id. */
export function resolveTypedApprovalReactionTarget<TRoute = unknown>(params: {
  target:
    | (ApprovalReactionTargetRecord<TRoute> & { approvalKind: ApprovalKind })
    | null
    | undefined;
  reactionKey: string;
}): ApprovalReactionTargetResolution<TRoute> | null {
  return resolveApprovalReactionTargetInternal({
    ...params,
    allowLegacyKindInference: false,
  });
}

function formatSeverity(value: "info" | "warning" | "critical"): string {
  return value === "critical" ? "Critical" : value === "info" ? "Info" : "Warning";
}

function buildDecisionText(allowedDecisions: readonly ExecApprovalReplyDecision[]): string {
  return allowedDecisions.join("|");
}

function buildManualInstructionSection(params: {
  approvalKind: ApprovalKind;
  approvalId: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
}): string[] {
  const lines: string[] = [];
  if (!params.allowedDecisions.includes("allow-always")) {
    lines.push(
      params.approvalKind === "exec"
        ? "Allow Always is unavailable for this command."
        : "Allow Always is unavailable because the effective policy requires approval every time.",
    );
  }
  if (params.allowedDecisions.length > 0) {
    lines.push(
      `Reply with: /approve ${params.approvalId} ${buildDecisionText(params.allowedDecisions)}`,
    );
  }
  return lines;
}

function buildCommandActionInstructionSection(actions: PendingApprovalView["actions"]): string[] {
  return actions.flatMap((action) =>
    action.command.trim() ? [`${action.label}: ${action.command}`] : [],
  );
}

function listDecisionActions(actions: PendingApprovalView["actions"]): ExecApprovalReplyDecision[] {
  return normalizeDecisionList(
    actions.flatMap((action) => ("decision" in action && action.decision ? [action.decision] : [])),
  );
}
function buildApprovalReactionPromptText(params: {
  view: PendingApprovalView;
  nowMs: number;
  reactionHint: string | null;
}): string {
  const { view } = params;
  const allowedDecisions = listDecisionActions(view.actions);
  const sections: string[] = [];
  if (view.approvalKind === "exec") {
    const header = ["Exec approval required", `ID: ${view.approvalId}`];
    sections.push(header.join("\n"));
    const warningText = view.warningText?.trim();
    if (warningText) {
      sections.push(warningText);
    }
    const warningLines = view.commandAnalysis?.warningLines
      ?.map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 5);
    if (warningLines?.length) {
      sections.push(["Command analysis:", ...warningLines.map((line) => `- ${line}`)].join("\n"));
    }
    sections.push(["Pending command:", formatFencedCodeBlock(view.commandText, "sh")].join("\n"));
    const info: string[] = [];
    if (view.cwd) {
      info.push(`CWD: ${formatApprovalDisplayPath(sanitizeForPromptLiteral(view.cwd))}`);
    }
    if (view.host) {
      info.push(`Host: ${view.host}`);
    }
    if (view.nodeId) {
      info.push(`Node: ${view.nodeId}`);
    }
    if (view.agentId) {
      info.push(`Agent: ${view.agentId}`);
    }
    if (view.ask) {
      info.push(`Ask: ${view.ask}`);
    }
    info.push(`Expires in: ${formatExecApprovalExpiresIn(view.expiresAtMs, params.nowMs)}`);
    info.push(`Full id: \`${view.approvalId}\``);
    sections.push(info.join("\n"));
  } else {
    const header = ["Plugin approval required", `ID: ${view.approvalId}`];
    sections.push(header.join("\n"));
    const details = [`Title: ${view.title}`];
    if (view.description) {
      details.push(`Description: ${view.description}`);
    }
    details.push(`Severity: ${formatSeverity(view.severity)}`);
    if (view.toolName) {
      details.push(`Tool: ${view.toolName}`);
    }
    if (view.pluginId) {
      details.push(`Plugin: ${view.pluginId}`);
    }
    if (view.agentId) {
      details.push(`Agent: ${view.agentId}`);
    }
    details.push(`Expires in: ${formatExecApprovalExpiresIn(view.expiresAtMs, params.nowMs)}`);
    details.push(`Full id: \`${view.approvalId}\``);
    sections.push(details.join("\n"));
  }
  if (params.reactionHint) {
    sections.push(params.reactionHint);
  }
  const commandInstructions = buildCommandActionInstructionSection(view.actions);
  if (commandInstructions.length > 0) {
    sections.push(commandInstructions.join("\n"));
  }
  const manualInstructions = buildManualInstructionSection({
    approvalKind: view.approvalKind,
    approvalId: view.approvalId,
    allowedDecisions,
  });
  if (manualInstructions.length > 0) {
    sections.push(manualInstructions.join("\n"));
  }
  return sections.filter(Boolean).join("\n\n");
}

function withoutPresentation(payload: ReplyPayload): ReplyPayload {
  const { presentation: _presentation, interactive: _interactive, ...rest } = payload;
  return rest;
}

function buildMetadataPayload(params: {
  request: ApprovalRequest;
  view: PendingApprovalView;
  text: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
}): ReplyPayload {
  const sessionKey =
    params.request.request && "sessionKey" in params.request.request
      ? params.request.request.sessionKey
      : null;
  return withoutPresentation(
    buildApprovalPendingReplyPayload({
      approvalKind: params.view.approvalKind,
      approvalId: params.view.approvalId,
      approvalSlug: params.view.approvalId.slice(0, 8),
      text: params.text,
      agentId: params.view.agentId ?? null,
      allowedDecisions: params.allowedDecisions,
      sessionKey,
    }),
  );
}

/** Build an approval prompt payload with reaction bindings for a prepared view. */
export function buildApprovalPendingPromptPayload(params: {
  request: ApprovalRequest;
  view: PendingApprovalView;
  nowMs: number;
}): ApprovalReactionPromptPayload {
  const allowedDecisions = listDecisionActions(params.view.actions);
  const reactionBindings = listApprovalReactionBindings({ allowedDecisions });
  const text = buildApprovalReactionPromptText({
    view: params.view,
    nowMs: params.nowMs,
    reactionHint: buildApprovalReactionHint({ allowedDecisions }),
  });
  return {
    ...buildMetadataPayload({
      request: params.request,
      view: params.view,
      text,
      allowedDecisions,
    }),
    allowedDecisions,
    reactionBindings,
  };
}

/** Build an approval prompt payload with reaction bindings directly from a request. */
export function buildApprovalReactionPromptPayloadForRequest(params: {
  request: ApprovalRequest;
  nowMs: number;
}): ApprovalReactionPromptPayload {
  return buildApprovalPendingPromptPayload({
    request: params.request,
    view: buildPendingApprovalView(params.request),
    nowMs: params.nowMs,
  });
}

function replaceApprovalIdPlaceholder(text: string | undefined, approvalId: string): string {
  return (text ?? "").replace(/\/approve\s+<id>/g, `/approve ${approvalId}`);
}

/** Build reaction and manual-fallback pending approval content for a prepared view. */
export function buildApprovalReactionPendingContent(params: {
  request: ApprovalRequest;
  view: PendingApprovalView;
  nowMs: number;
}): ApprovalReactionPendingContent {
  const reactionPayload = buildApprovalPendingPromptPayload(params);
  const manualFallbackPayload =
    params.view.approvalKind === "plugin"
      ? (() => {
          const payload = buildPluginApprovalPendingReplyPayload({
            request: params.request as PluginApprovalRequest,
            nowMs: params.nowMs,
            allowedDecisions: reactionPayload.allowedDecisions,
          });
          return withoutPresentation({
            ...payload,
            text: replaceApprovalIdPlaceholder(payload.text, params.request.id),
          });
        })()
      : withoutPresentation(
          buildExecApprovalPendingReplyPayload({
            approvalId: params.request.id,
            approvalSlug: params.request.id.slice(0, 8),
            approvalCommandId: params.request.id,
            warningText: params.view.warningText ?? undefined,
            ask: params.view.ask ?? null,
            agentId: params.view.agentId ?? null,
            allowedDecisions: reactionPayload.allowedDecisions,
            command: params.view.commandText,
            cwd: params.view.cwd ?? undefined,
            host: params.view.host === "node" ? "node" : "gateway",
            nodeId: params.view.nodeId ?? undefined,
            sessionKey: params.view.sessionKey ?? null,
            expiresAtMs: params.request.expiresAtMs,
            nowMs: params.nowMs,
          } satisfies ExecApprovalPendingReplyParams),
        );
  return { reactionPayload, manualFallbackPayload };
}

/** Build reaction and manual-fallback pending approval content directly from a request. */
export function buildApprovalReactionPendingContentForRequest(params: {
  request: ApprovalRequest;
  nowMs: number;
}): ApprovalReactionPendingContent {
  return buildApprovalReactionPendingContent({
    request: params.request,
    view: buildPendingApprovalView(params.request),
    nowMs: params.nowMs,
  });
}

/** Create an approval target store backed by memory with optional persistent storage. */
export function createApprovalReactionTargetStore<TTarget>(params: {
  namespace: string;
  maxEntries: number;
  defaultTtlMs: number;
  openStore?: (params: {
    namespace: string;
    maxEntries: number;
    defaultTtlMs: number;
  }) => KeyedStore<PersistedApprovalReactionTarget<TTarget>> | undefined;
  logPersistentError?: (error: unknown) => void;
  readPersistedTarget?: (target: unknown) => TTarget | null;
  nowMs?: () => number;
}): ApprovalReactionTargetStore<TTarget> {
  const nowMs = params.nowMs ?? Date.now;
  const memory = new Map<string, InMemoryApprovalReactionTarget<TTarget>>();
  let persistentStore: KeyedStore<PersistedApprovalReactionTarget<TTarget>> | undefined;
  let persistentStoreDisabled = false;

  const disablePersistentStore = (error: unknown) => {
    persistentStoreDisabled = true;
    persistentStore = undefined;
    params.logPersistentError?.(error);
  };

  const getPersistentStore = () => {
    if (persistentStoreDisabled || !params.openStore) {
      return undefined;
    }
    if (persistentStore) {
      return persistentStore;
    }
    try {
      persistentStore = params.openStore({
        namespace: params.namespace,
        maxEntries: params.maxEntries,
        defaultTtlMs: params.defaultTtlMs,
      });
      return persistentStore;
    } catch (error) {
      disablePersistentStore(error);
      return undefined;
    }
  };

  const pruneMemory = () => {
    const now = nowMs();
    for (const [key, entry] of memory) {
      if (entry.expiresAtMs <= now) {
        memory.delete(key);
      }
    }
    while (memory.size > params.maxEntries) {
      const oldestKey = memory.keys().next().value;
      if (!oldestKey) {
        return;
      }
      memory.delete(oldestKey);
    }
  };

  return {
    register(key: string, target: TTarget, opts?: { ttlMs?: number }): void {
      const normalizedKey = key.trim();
      if (!normalizedKey) {
        return;
      }
      const ttlMs = Math.max(1, opts?.ttlMs ?? params.defaultTtlMs);
      memory.set(normalizedKey, {
        target,
        expiresAtMs: nowMs() + ttlMs,
      });
      pruneMemory();
      const store = getPersistentStore();
      if (!store) {
        return;
      }
      void store
        .register(normalizedKey, { version: 1, target }, { ttlMs })
        .catch(disablePersistentStore);
    },
    async lookup(key: string): Promise<TTarget | null> {
      const normalizedKey = key.trim();
      if (!normalizedKey) {
        return null;
      }
      pruneMemory();
      const entry = memory.get(normalizedKey);
      if (entry) {
        return entry.target;
      }
      const store = getPersistentStore();
      if (!store) {
        return null;
      }
      try {
        const persisted = await store.lookup(normalizedKey);
        if (persisted?.version !== 1) {
          return null;
        }
        return params.readPersistedTarget
          ? params.readPersistedTarget(persisted.target)
          : persisted.target;
      } catch (error) {
        disablePersistentStore(error);
        return null;
      }
    },
    delete(key: string): void {
      const normalizedKey = key.trim();
      if (!normalizedKey) {
        return;
      }
      memory.delete(normalizedKey);
      const store = getPersistentStore();
      if (!store) {
        return;
      }
      void store.delete(normalizedKey).catch(disablePersistentStore);
    },
    clearForTest(): void {
      memory.clear();
      persistentStore = undefined;
      persistentStoreDisabled = false;
    },
  };
}

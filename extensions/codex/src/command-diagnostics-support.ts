import crypto from "node:crypto";
import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { bindingStoreKey } from "./app-server/session-binding.js";
import {
  codexDiagnosticsFeedbackState,
  type CodexDiagnosticsTarget,
  type PendingCodexDiagnosticsConfirmation,
} from "./command-diagnostics-state.js";
import { splitArgs } from "./command-handler-args.js";

type ParsedDiagnosticsArgs =
  | { action: "request"; note: string }
  | { action: "confirm"; token: string }
  | { action: "cancel"; token: string }
  | { action: "usage" };

const CODEX_DIAGNOSTICS_SOURCE = "openclaw-diagnostics";
const CODEX_DIAGNOSTICS_REASON_MAX_CHARS = 2048;
const CODEX_DIAGNOSTICS_COOLDOWN_MS = 60_000;
const CODEX_DIAGNOSTICS_ERROR_MAX_CHARS = 500;
const CODEX_DIAGNOSTICS_COOLDOWN_MAX_THREADS = 100;
const CODEX_DIAGNOSTICS_COOLDOWN_MAX_SCOPES = 100;
const CODEX_DIAGNOSTICS_CONFIRMATION_TTL_MS = 5 * 60_000;
const CODEX_DIAGNOSTICS_CONFIRMATION_MAX_REQUESTS_PER_SCOPE = 100;
const CODEX_DIAGNOSTICS_CONFIRMATION_MAX_SCOPES = 100;
const CODEX_DIAGNOSTICS_SCOPE_FIELD_MAX_CHARS = 128;
const CODEX_RESUME_SAFE_THREAD_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

const {
  lastUploadByThread: lastCodexDiagnosticsUploadByThread,
  lastUploadByScope: lastCodexDiagnosticsUploadByScope,
  pendingConfirmations: pendingCodexDiagnosticsConfirmations,
  pendingTokensByScope: pendingCodexDiagnosticsConfirmationTokensByScope,
} = codexDiagnosticsFeedbackState;

export function normalizeDiagnosticsReason(note: string): string | undefined {
  const normalized = normalizeOptionalString(note);
  return normalized ? truncateUtf16Safe(normalized, CODEX_DIAGNOSTICS_REASON_MAX_CHARS) : undefined;
}

export function parseDiagnosticsArgs(args: string): ParsedDiagnosticsArgs {
  const [action, token, ...extra] = splitArgs(args);
  const normalizedAction = action?.toLowerCase();
  if (
    (normalizedAction === "confirm" || normalizedAction === "--confirm") &&
    token &&
    extra.length === 0
  ) {
    return { action: "confirm", token };
  }
  if (
    (normalizedAction === "cancel" || normalizedAction === "--cancel") &&
    token &&
    extra.length === 0
  ) {
    return { action: "cancel", token };
  }
  if (
    normalizedAction === "confirm" ||
    normalizedAction === "--confirm" ||
    normalizedAction === "cancel" ||
    normalizedAction === "--cancel"
  ) {
    return { action: "usage" };
  }
  return { action: "request", note: args };
}

export function formatDiagnosticsUsage(commandPrefix: string): string {
  return [
    `Usage: ${commandPrefix} [note]`,
    `Usage: ${commandPrefix} confirm <token>`,
    `Usage: ${commandPrefix} cancel <token>`,
  ].join("\n");
}

export function createCodexDiagnosticsConfirmation(params: {
  targets: CodexDiagnosticsTarget[];
  note?: string;
  senderId: string;
  channel: string;
  accountId?: string;
  channelId?: string;
  messageThreadId?: string;
  threadParentId?: string;
  sessionKey?: string;
  scopeKey: string;
  privateRouted?: boolean;
  now: number;
}): string {
  prunePendingCodexDiagnosticsConfirmations(params.now);
  if (
    !pendingCodexDiagnosticsConfirmationTokensByScope.has(params.scopeKey) &&
    pendingCodexDiagnosticsConfirmationTokensByScope.size >=
      CODEX_DIAGNOSTICS_CONFIRMATION_MAX_SCOPES
  ) {
    const oldestScopeKey = pendingCodexDiagnosticsConfirmationTokensByScope.keys().next().value;
    if (typeof oldestScopeKey === "string") {
      deletePendingCodexDiagnosticsConfirmationScope(oldestScopeKey);
    }
  }
  const scopeTokens = pendingCodexDiagnosticsConfirmationTokensByScope.get(params.scopeKey) ?? [];
  while (scopeTokens.length >= CODEX_DIAGNOSTICS_CONFIRMATION_MAX_REQUESTS_PER_SCOPE) {
    const oldestToken = scopeTokens.shift();
    if (!oldestToken) {
      break;
    }
    pendingCodexDiagnosticsConfirmations.delete(oldestToken);
  }
  const token = crypto.randomBytes(6).toString("hex");
  scopeTokens.push(token);
  pendingCodexDiagnosticsConfirmationTokensByScope.set(params.scopeKey, scopeTokens);
  pendingCodexDiagnosticsConfirmations.set(token, {
    token,
    targets: params.targets,
    note: params.note,
    senderId: params.senderId,
    channel: params.channel,
    accountId: params.accountId,
    channelId: params.channelId,
    messageThreadId: params.messageThreadId,
    threadParentId: params.threadParentId,
    sessionKey: params.sessionKey,
    scopeKey: params.scopeKey,
    ...(params.privateRouted === undefined ? {} : { privateRouted: params.privateRouted }),
    createdAt: params.now,
  });
  return token;
}

export function readCodexDiagnosticsConfirmationScope(ctx: PluginCommandContext): {
  accountId?: string;
  channelId?: string;
  messageThreadId?: string;
  threadParentId?: string;
  sessionKey?: string;
} {
  return {
    accountId: normalizeCodexDiagnosticsScopeField(ctx.accountId),
    channelId: normalizeCodexDiagnosticsScopeField(ctx.channelId),
    messageThreadId:
      typeof ctx.messageThreadId === "string" || typeof ctx.messageThreadId === "number"
        ? normalizeCodexDiagnosticsScopeField(String(ctx.messageThreadId))
        : undefined,
    threadParentId: normalizeCodexDiagnosticsScopeField(ctx.threadParentId),
    sessionKey: normalizeCodexDiagnosticsScopeField(ctx.sessionKey),
  };
}

export function readCodexDiagnosticsScopeMismatch(
  pending: PendingCodexDiagnosticsConfirmation,
  ctx: PluginCommandContext,
):
  | {
      confirmMessage: string;
      cancelMessage: string;
    }
  | undefined {
  const current = readCodexDiagnosticsConfirmationScope(ctx);
  if (pending.accountId !== current.accountId) {
    return {
      confirmMessage: "This Codex diagnostics confirmation belongs to a different account.",
      cancelMessage: "This Codex diagnostics confirmation belongs to a different account.",
    };
  }
  if (pending.privateRouted) {
    return undefined;
  }
  if (pending.channelId !== current.channelId) {
    return {
      confirmMessage:
        "This Codex diagnostics confirmation belongs to a different channel instance.",
      cancelMessage: "This Codex diagnostics confirmation belongs to a different channel instance.",
    };
  }
  if (pending.messageThreadId !== current.messageThreadId) {
    return {
      confirmMessage: "This Codex diagnostics confirmation belongs to a different thread.",
      cancelMessage: "This Codex diagnostics confirmation belongs to a different thread.",
    };
  }
  if (pending.threadParentId !== current.threadParentId) {
    return {
      confirmMessage: "This Codex diagnostics confirmation belongs to a different parent thread.",
      cancelMessage: "This Codex diagnostics confirmation belongs to a different parent thread.",
    };
  }
  if (pending.sessionKey !== current.sessionKey) {
    return {
      confirmMessage: "This Codex diagnostics confirmation belongs to a different session.",
      cancelMessage: "This Codex diagnostics confirmation belongs to a different session.",
    };
  }
  return undefined;
}

export function readPendingCodexDiagnosticsConfirmation(
  token: string,
  now: number,
): PendingCodexDiagnosticsConfirmation | undefined {
  prunePendingCodexDiagnosticsConfirmations(now);
  return pendingCodexDiagnosticsConfirmations.get(token);
}

export function deletePendingCodexDiagnosticsConfirmation(token: string): void {
  const pending = pendingCodexDiagnosticsConfirmations.get(token);
  pendingCodexDiagnosticsConfirmations.delete(token);
  if (!pending) {
    return;
  }
  const scopeTokens = pendingCodexDiagnosticsConfirmationTokensByScope.get(pending.scopeKey);
  if (!scopeTokens) {
    return;
  }
  const tokenIndex = scopeTokens.indexOf(token);
  if (tokenIndex >= 0) {
    scopeTokens.splice(tokenIndex, 1);
  }
  if (scopeTokens.length === 0) {
    pendingCodexDiagnosticsConfirmationTokensByScope.delete(pending.scopeKey);
  }
}

function prunePendingCodexDiagnosticsConfirmations(now: number): void {
  for (const [token, pending] of pendingCodexDiagnosticsConfirmations) {
    if (now - pending.createdAt >= CODEX_DIAGNOSTICS_CONFIRMATION_TTL_MS) {
      deletePendingCodexDiagnosticsConfirmation(token);
    }
  }
}

function deletePendingCodexDiagnosticsConfirmationScope(scopeKey: string): void {
  const scopeTokens = pendingCodexDiagnosticsConfirmationTokensByScope.get(scopeKey) ?? [];
  for (const token of scopeTokens) {
    pendingCodexDiagnosticsConfirmations.delete(token);
  }
  pendingCodexDiagnosticsConfirmationTokensByScope.delete(scopeKey);
}

export function codexDiagnosticsTargetsMatch(
  expected: readonly CodexDiagnosticsTarget[],
  actual: readonly CodexDiagnosticsTarget[],
): boolean {
  const fingerprint = (target: CodexDiagnosticsTarget) =>
    JSON.stringify([
      bindingStoreKey(target.identity),
      target.threadId,
      target.connectionScope ?? null,
      target.pendingSupervisionBranch?.connectionFingerprint ??
        target.appServerRuntimeFingerprint ??
        null,
      target.authProfileId ?? null,
    ]);
  const expectedTargets = expected.map(fingerprint).toSorted();
  const actualTargets = actual.map(fingerprint).toSorted();
  return (
    expectedTargets.length === actualTargets.length &&
    expectedTargets.every((target, index) => target === actualTargets[index])
  );
}

export function formatCodexDiagnosticsUploadResult(
  sent: readonly CodexDiagnosticsTarget[],
  failed: ReadonlyArray<{ target: CodexDiagnosticsTarget; error: string }>,
): string {
  const lines: string[] = [];
  if (sent.length > 0) {
    lines.push("Codex diagnostics sent to OpenAI servers:");
    lines.push(...formatCodexDiagnosticsTargetLines(sent));
    lines.push("Included Codex logs and spawned Codex subthreads when available.");
  }
  if (failed.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push("Could not send Codex diagnostics:");
    lines.push(
      ...failed.map(
        ({ target, error }) =>
          `${formatCodexDiagnosticsTargetLine(target)}: ${formatCodexErrorForDisplay(error)}`,
      ),
    );
    lines.push("Inspect locally:");
    lines.push(
      ...failed.map(({ target }) => `- ${formatCodexResumeCommandForDisplay(target.threadId)}`),
    );
  }
  return lines.join("\n");
}

export function formatCodexDiagnosticsTargetLines(
  targets: readonly CodexDiagnosticsTarget[],
): string[] {
  return targets.flatMap((target, index) => {
    const lines = formatCodexDiagnosticsTargetBlock(target, index);
    return index < targets.length - 1 ? [...lines, ""] : lines;
  });
}

function formatCodexDiagnosticsTargetBlock(
  target: CodexDiagnosticsTarget,
  index: number,
): string[] {
  const lines = [`Session ${index + 1}`];
  if (target.channel) {
    lines.push(`Channel: ${formatCodexValueForDisplay(target.channel)}`);
  }
  if (target.sessionKey) {
    lines.push(`OpenClaw session key: ${formatCodexCopyableValueForDisplay(target.sessionKey)}`);
  }
  if (target.sessionId) {
    lines.push(`OpenClaw session id: ${formatCodexCopyableValueForDisplay(target.sessionId)}`);
  }
  lines.push(`Codex thread id: ${formatCodexCopyableValueForDisplay(target.threadId)}`);
  lines.push(`Inspect locally: ${formatCodexResumeCommandForDisplay(target.threadId)}`);
  return lines;
}

function formatCodexDiagnosticsTargetLine(target: CodexDiagnosticsTarget): string {
  const parts: string[] = [];
  if (target.channel) {
    parts.push(`channel ${formatCodexValueForDisplay(target.channel)}`);
  }
  const sessionLabel = target.sessionId || target.sessionKey;
  if (sessionLabel) {
    parts.push(`OpenClaw session ${formatCodexValueForDisplay(sessionLabel)}`);
  }
  parts.push(`Codex thread ${formatCodexThreadIdForDisplay(target.threadId)}`);
  return `- ${parts.join(", ")}`;
}

export function escapeCodexChatText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("@", "\uff20")
    .replaceAll("`", "\uff40")
    .replaceAll("[", "\uff3b")
    .replaceAll("]", "\uff3d")
    .replaceAll("(", "\uff08")
    .replaceAll(")", "\uff09")
    .replaceAll("*", "\u2217")
    .replaceAll("_", "\uff3f")
    .replaceAll("~", "\uff5e")
    .replaceAll("|", "\uff5c");
}

export function formatCodexTextForDisplay(value: string): string {
  let safe = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    safe += codePoint != null && isUnsafeDisplayCodePoint(codePoint) ? "?" : character;
  }
  safe = safe.trim();
  return safe || "<unknown>";
}

export function readCodexDiagnosticsTargetsCooldownMessage(
  targets: readonly CodexDiagnosticsTarget[],
  ctx: PluginCommandContext,
  now: number,
  options: { includeThreadId?: boolean; cooldownScope?: string } = {},
): string | undefined {
  for (const target of targets) {
    const cooldownMs = readCodexDiagnosticsCooldownMs(target.threadId, now);
    if (cooldownMs > 0) {
      if (options.includeThreadId === false) {
        return `Codex diagnostics were already sent for one of these Codex threads recently. Try again in ${Math.ceil(
          cooldownMs / 1000,
        )}s.`;
      }
      const displayThreadId = formatCodexThreadIdForDisplay(target.threadId);
      return `Codex diagnostics were already sent for thread ${displayThreadId} recently. Try again in ${Math.ceil(
        cooldownMs / 1000,
      )}s.`;
    }
  }
  const scopeCooldownMs = readCodexDiagnosticsScopeCooldownMs(
    options.cooldownScope ?? readCodexDiagnosticsCooldownScope(ctx),
    now,
  );
  if (scopeCooldownMs > 0) {
    return `Codex diagnostics were already sent for this account or channel recently. Try again in ${Math.ceil(
      scopeCooldownMs / 1000,
    )}s.`;
  }
  return undefined;
}

export function recordCodexDiagnosticsUpload(
  threadId: string,
  ctx: PluginCommandContext,
  now: number,
  cooldownScope?: string,
): void {
  pruneCodexDiagnosticsCooldowns(now);
  recordBoundedCodexDiagnosticsCooldown(
    lastCodexDiagnosticsUploadByScope,
    cooldownScope ?? readCodexDiagnosticsCooldownScope(ctx),
    CODEX_DIAGNOSTICS_COOLDOWN_MAX_SCOPES,
    now,
  );
  recordBoundedCodexDiagnosticsCooldown(
    lastCodexDiagnosticsUploadByThread,
    threadId,
    CODEX_DIAGNOSTICS_COOLDOWN_MAX_THREADS,
    now,
  );
}

export function readCodexDiagnosticsCooldownScope(ctx: PluginCommandContext): string {
  const scope = readCodexDiagnosticsConfirmationScope(ctx);
  const payload = JSON.stringify({
    accountId: scope.accountId ?? null,
    channelId: scope.channelId ?? null,
    sessionKey: scope.sessionKey ?? null,
    messageThreadId: scope.messageThreadId ?? null,
    threadParentId: scope.threadParentId ?? null,
    senderId: normalizeCodexDiagnosticsScopeField(ctx.senderId) ?? null,
    channel: normalizeCodexDiagnosticsScopeField(ctx.channel) ?? "",
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export function buildDiagnosticsTags(ctx: PluginCommandContext): Record<string, string> {
  const tags: Record<string, string> = {
    source: CODEX_DIAGNOSTICS_SOURCE,
  };
  addTag(tags, "channel", ctx.channel);
  return tags;
}

function addTag(tags: Record<string, string>, key: string, value: unknown): void {
  if (typeof value === "string" && value.trim()) {
    tags[key] = value.trim();
  }
}

function formatCodexThreadIdForDisplay(threadId: string): string {
  return escapeCodexChatText(formatCodexTextForDisplay(threadId));
}

function formatCodexValueForDisplay(value: string): string {
  return escapeCodexChatText(formatCodexTextForDisplay(value));
}

function formatCodexCopyableValueForDisplay(value: string): string {
  const safe = formatCodexTextForDisplay(value);
  if (CODEX_RESUME_SAFE_THREAD_ID_PATTERN.test(safe)) {
    return `\`${safe}\``;
  }
  return escapeCodexChatText(safe);
}

function readCodexDiagnosticsCooldownMs(threadId: string, now: number): number {
  const lastSentAt = lastCodexDiagnosticsUploadByThread.get(threadId);
  if (!lastSentAt) {
    return 0;
  }
  const remainingMs = Math.max(0, CODEX_DIAGNOSTICS_COOLDOWN_MS - (now - lastSentAt));
  if (remainingMs === 0) {
    lastCodexDiagnosticsUploadByThread.delete(threadId);
  }
  return remainingMs;
}

function readCodexDiagnosticsScopeCooldownMs(scope: string, now: number): number {
  const lastSentAt = lastCodexDiagnosticsUploadByScope.get(scope);
  if (!lastSentAt) {
    return 0;
  }
  const remainingMs = Math.max(0, CODEX_DIAGNOSTICS_COOLDOWN_MS - (now - lastSentAt));
  if (remainingMs === 0) {
    lastCodexDiagnosticsUploadByScope.delete(scope);
  }
  return remainingMs;
}

function recordBoundedCodexDiagnosticsCooldown(
  map: Map<string, number>,
  key: string,
  maxSize: number,
  now: number,
): void {
  if (!map.has(key)) {
    while (map.size >= maxSize) {
      const oldestKey = map.keys().next().value;
      if (typeof oldestKey !== "string") {
        break;
      }
      map.delete(oldestKey);
    }
  }
  map.set(key, now);
}

function pruneCodexDiagnosticsCooldowns(now: number): void {
  pruneCodexDiagnosticsCooldownMap(lastCodexDiagnosticsUploadByThread, now);
  pruneCodexDiagnosticsCooldownMap(lastCodexDiagnosticsUploadByScope, now);
}

function pruneCodexDiagnosticsCooldownMap(map: Map<string, number>, now: number): void {
  for (const [key, lastSentAt] of map) {
    if (now - lastSentAt >= CODEX_DIAGNOSTICS_COOLDOWN_MS) {
      map.delete(key);
    }
  }
}

function formatCodexErrorForDisplay(error: string): string {
  const safe = truncateUtf16Safe(
    formatCodexTextForDisplay(error),
    CODEX_DIAGNOSTICS_ERROR_MAX_CHARS,
  );
  return escapeCodexChatText(safe) || "unknown error";
}

function formatCodexResumeCommandForDisplay(threadId: string): string {
  const safeThreadId = formatCodexTextForDisplay(threadId);
  if (!CODEX_RESUME_SAFE_THREAD_ID_PATTERN.test(safeThreadId)) {
    return "run codex resume and paste the thread id shown above";
  }
  return `\`codex resume ${safeThreadId}\``;
}

function isUnsafeDisplayCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x001f ||
    (codePoint >= 0x007f && codePoint <= 0x009f) ||
    codePoint === 0x00ad ||
    codePoint === 0x061c ||
    codePoint === 0x180e ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    codePoint === 0xfeff ||
    (codePoint >= 0xfff9 && codePoint <= 0xfffb) ||
    (codePoint >= 0xe0000 && codePoint <= 0xe007f)
  );
}

function normalizeCodexDiagnosticsScopeField(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= CODEX_DIAGNOSTICS_SCOPE_FIELD_MAX_CHARS) {
    return normalized;
  }
  return `sha256:${crypto.createHash("sha256").update(normalized).digest("hex")}`;
}

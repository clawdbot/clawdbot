import { matchesApprovalRequestFilters } from "openclaw/plugin-sdk/approval-client-runtime";
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import { getSignalApprovalApprovers, signalApprovalAuth } from "./approval-auth.js";
import { looksLikeUuid } from "./identity.js";
import { normalizeSignalMessagingTarget } from "./normalize.js";
import { getOptionalSignalRuntime } from "./runtime.js";

const SIGNAL_APPROVAL_REACTION_META = {
  "allow-once": {
    emoji: "👍",
    label: "Allow Once",
  },
  deny: {
    emoji: "👎",
    label: "Deny",
  },
} satisfies Partial<Record<ExecApprovalReplyDecision, { emoji: string; label: string }>>;

const SIGNAL_APPROVAL_REACTION_ORDER = [
  "allow-once",
  "deny",
] as const satisfies readonly ExecApprovalReplyDecision[];

const PERSISTENT_NAMESPACE = "signal.approval-reactions";
const PERSISTENT_MAX_ENTRIES = 1000;
const DEFAULT_REACTION_TARGET_TTL_MS = 24 * 60 * 60 * 1000;

export type SignalApprovalReactionBinding = {
  decision: ExecApprovalReplyDecision;
  emoji: string;
  label: string;
};

type SignalApprovalReactionResolution = {
  approvalId: string;
  approvalKind: ApprovalKind;
  decision: ExecApprovalReplyDecision;
  route: SignalApprovalReactionRoute;
};

type ApprovalKind = "exec" | "plugin";
type ApprovalForwardingConfig = NonNullable<NonNullable<OpenClawConfig["approvals"]>["exec"]>;
type ApprovalForwardingMode = NonNullable<ApprovalForwardingConfig["mode"]>;

type SignalApprovalReactionRoute = {
  deliveryMode: "session";
  agentId?: string;
  sessionKey?: string;
};

type SignalApprovalReactionTarget = {
  approvalId: string;
  approvalKind: ApprovalKind;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
  targetAuthorKeys: readonly string[];
  route: SignalApprovalReactionRoute;
};

type PersistedSignalApprovalReactionTarget = {
  version: 1;
  target: SignalApprovalReactionTarget;
};

type SignalApprovalReactionStore = {
  register(
    key: string,
    value: PersistedSignalApprovalReactionTarget,
    opts?: { ttlMs?: number },
  ): Promise<void>;
  lookup(key: string): Promise<PersistedSignalApprovalReactionTarget | undefined>;
  delete(key: string): Promise<boolean>;
};

const signalApprovalReactionTargets = new Map<string, SignalApprovalReactionTarget>();
let persistentStore: SignalApprovalReactionStore | undefined;
let persistentStoreDisabled = false;
let resolverRuntimePromise: Promise<typeof import("./approval-resolver.js")> | undefined;

function loadApprovalResolver(): Promise<typeof import("./approval-resolver.js")> {
  resolverRuntimePromise ??= import("./approval-resolver.js");
  return resolverRuntimePromise;
}

function resolveApprovalKindFromId(approvalId: string): ApprovalKind {
  return approvalId.startsWith("plugin:") ? "plugin" : "exec";
}

function resolveApprovalForwardingConfig(params: {
  cfg: OpenClawConfig;
  approvalKind: ApprovalKind;
}): ApprovalForwardingConfig | undefined {
  return params.approvalKind === "plugin"
    ? params.cfg.approvals?.plugin
    : params.cfg.approvals?.exec;
}

function normalizeApprovalForwardingMode(
  mode: ApprovalForwardingConfig["mode"] | undefined,
): ApprovalForwardingMode {
  return mode ?? "session";
}

function approvalModeIncludesSession(mode: ApprovalForwardingMode): boolean {
  return mode === "session" || mode === "both";
}

function isSignalApprovalReactionRouteStillEnabled(params: {
  cfg: OpenClawConfig;
  target: Pick<SignalApprovalReactionTarget, "approvalKind" | "route">;
}): boolean {
  const config = resolveApprovalForwardingConfig({
    cfg: params.cfg,
    approvalKind: params.target.approvalKind,
  });
  if (!config?.enabled) {
    return false;
  }
  if (!approvalModeIncludesSession(normalizeApprovalForwardingMode(config.mode))) {
    return false;
  }
  return matchesApprovalRequestFilters({
    request: {
      agentId: params.target.route.agentId,
      sessionKey: params.target.route.sessionKey,
    },
    agentFilter: config.agentFilter,
    sessionFilter: config.sessionFilter,
    fallbackAgentIdFromSessionKey: true,
  });
}

export function resolveSignalApprovalConversationKey(to: string): string | null {
  return normalizeSignalMessagingTarget(to) ?? null;
}

function normalizeSignalApprovalTargetAuthorKey(value: string): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }
  const withoutSignalPrefix = normalized.replace(/^signal:/i, "").trim();
  const lower = normalizeLowercaseStringOrEmpty(withoutSignalPrefix);
  if (lower.startsWith("uuid:")) {
    const uuid = withoutSignalPrefix.slice("uuid:".length).trim().toLowerCase();
    return uuid ? `uuid:${uuid}` : null;
  }
  if (looksLikeUuid(withoutSignalPrefix)) {
    return `uuid:${withoutSignalPrefix.toLowerCase()}`;
  }
  return normalizeE164(withoutSignalPrefix);
}

export function resolveSignalApprovalTargetAuthorKeys(params: {
  targetAuthor?: string | null;
  targetAuthorUuid?: string | null;
}): string[] {
  const targetAuthorUuid = normalizeOptionalString(params.targetAuthorUuid);
  const keys = [
    targetAuthorUuid
      ? `uuid:${targetAuthorUuid
          .replace(/^uuid:/i, "")
          .trim()
          .toLowerCase()}`
      : null,
    params.targetAuthor ? normalizeSignalApprovalTargetAuthorKey(params.targetAuthor) : null,
  ].filter((key): key is string => Boolean(key));
  return Array.from(new Set(keys));
}

function buildReactionTargetKey(params: {
  accountId: string;
  conversationKey: string;
  messageId: string;
}) {
  const accountId = params.accountId.trim();
  const conversationKey = params.conversationKey.trim();
  const messageId = params.messageId.trim();
  if (!accountId || !conversationKey || !messageId || messageId === "unknown") {
    return null;
  }
  return `${accountId}:${conversationKey}:${messageId}`;
}

function reportPersistentApprovalReactionError(error: unknown): void {
  try {
    getOptionalSignalRuntime()
      ?.logging.getChildLogger({ plugin: "signal", feature: "approval-reaction-state" })
      .warn("Signal persistent approval reaction state failed", { error: String(error) });
  } catch {
    // Best effort only: persistent state must never break Signal reactions.
  }
}

function disablePersistentApprovalReactionStore(error: unknown): void {
  persistentStoreDisabled = true;
  persistentStore = undefined;
  reportPersistentApprovalReactionError(error);
}

function getPersistentApprovalReactionStore(): SignalApprovalReactionStore | undefined {
  if (persistentStoreDisabled) {
    return undefined;
  }
  if (persistentStore) {
    return persistentStore;
  }
  const runtime = getOptionalSignalRuntime();
  if (!runtime) {
    return undefined;
  }
  try {
    persistentStore = runtime.state.openKeyedStore<PersistedSignalApprovalReactionTarget>({
      namespace: PERSISTENT_NAMESPACE,
      maxEntries: PERSISTENT_MAX_ENTRIES,
      defaultTtlMs: DEFAULT_REACTION_TARGET_TTL_MS,
    });
    return persistentStore;
  } catch (error) {
    disablePersistentApprovalReactionStore(error);
    return undefined;
  }
}

function readPersistedTarget(value: unknown): SignalApprovalReactionTarget | null {
  const persisted = value as PersistedSignalApprovalReactionTarget | undefined;
  if (
    persisted?.version !== 1 ||
    !persisted.target ||
    typeof persisted.target.approvalId !== "string" ||
    (persisted.target.approvalKind !== "exec" && persisted.target.approvalKind !== "plugin") ||
    !persisted.target.route ||
    persisted.target.route.deliveryMode !== "session" ||
    !Array.isArray(persisted.target.targetAuthorKeys) ||
    !Array.isArray(persisted.target.allowedDecisions)
  ) {
    return null;
  }
  return persisted.target;
}

function rememberPersistentApprovalReactionTarget(params: {
  key: string;
  target: SignalApprovalReactionTarget;
  ttlMs?: number;
}): void {
  const ttlMs = params.ttlMs == null ? DEFAULT_REACTION_TARGET_TTL_MS : Math.max(1, params.ttlMs);
  const store = getPersistentApprovalReactionStore();
  if (!store) {
    return;
  }
  void store
    .register(params.key, { version: 1, target: params.target }, { ttlMs })
    .catch(disablePersistentApprovalReactionStore);
}

function forgetPersistentApprovalReactionTarget(key: string): void {
  const store = getPersistentApprovalReactionStore();
  if (!store) {
    return;
  }
  void store.delete(key).catch(disablePersistentApprovalReactionStore);
}

async function lookupPersistentApprovalReactionTarget(
  key: string,
): Promise<SignalApprovalReactionTarget | null> {
  const store = getPersistentApprovalReactionStore();
  if (!store) {
    return null;
  }
  try {
    return readPersistedTarget(await store.lookup(key));
  } catch (error) {
    disablePersistentApprovalReactionStore(error);
    return null;
  }
}

export function listSignalApprovalReactionBindings(
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): SignalApprovalReactionBinding[] {
  const allowed = new Set(allowedDecisions);
  return SIGNAL_APPROVAL_REACTION_ORDER.filter((decision) => allowed.has(decision)).map(
    (decision) => ({
      decision,
      emoji: SIGNAL_APPROVAL_REACTION_META[decision].emoji,
      label: SIGNAL_APPROVAL_REACTION_META[decision].label,
    }),
  );
}

export function buildSignalApprovalReactionHint(
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): string | null {
  const bindings = listSignalApprovalReactionBindings(allowedDecisions);
  if (bindings.length === 0) {
    return null;
  }
  return `React with:\n\n${bindings.map((binding) => `${binding.emoji} ${binding.label}`).join("\n")}`;
}

function insertSignalApprovalReactionHintNearHeader(params: {
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

export function addSignalApprovalReactionHintToText(params: {
  text: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
}): string {
  if (/(^|\n)React with:\s*(\n|$)/i.test(params.text)) {
    return params.text;
  }
  const hint = buildSignalApprovalReactionHint(params.allowedDecisions);
  return hint
    ? insertSignalApprovalReactionHintNearHeader({ text: params.text, hint })
    : params.text;
}

export function hasSignalApprovalReactionApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return getSignalApprovalApprovers(params).length > 0;
}

function resolveSignalApprovalReactionDecision(
  reactionKey: string,
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): ExecApprovalReplyDecision | null {
  const normalizedReaction = reactionKey.trim();
  if (!normalizedReaction) {
    return null;
  }
  const allowed = new Set(allowedDecisions);
  for (const decision of SIGNAL_APPROVAL_REACTION_ORDER) {
    if (!allowed.has(decision)) {
      continue;
    }
    if (SIGNAL_APPROVAL_REACTION_META[decision].emoji === normalizedReaction) {
      return decision;
    }
  }
  return null;
}

export function registerSignalApprovalReactionTarget(params: {
  accountId: string;
  conversationKey: string;
  messageId: string;
  approvalId: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
  targetAuthorKeys: readonly string[];
  route: SignalApprovalReactionRoute;
  routeAllowed: boolean;
  ttlMs?: number;
}): SignalApprovalReactionTarget | null {
  const key = buildReactionTargetKey(params);
  const approvalId = params.approvalId.trim();
  const targetAuthorKeys = Array.from(
    new Set(
      params.targetAuthorKeys
        .map((entry) => normalizeSignalApprovalTargetAuthorKey(entry))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  );
  const allowedDecisions = listSignalApprovalReactionBindings(params.allowedDecisions).map(
    (binding) => binding.decision,
  );
  if (!params.routeAllowed || !key || !approvalId || allowedDecisions.length === 0) {
    return null;
  }
  if (targetAuthorKeys.length === 0) {
    return null;
  }
  const route: SignalApprovalReactionRoute = {
    deliveryMode: "session",
    ...(normalizeOptionalString(params.route.agentId)
      ? { agentId: normalizeOptionalString(params.route.agentId) }
      : {}),
    ...(normalizeOptionalString(params.route.sessionKey)
      ? { sessionKey: normalizeOptionalString(params.route.sessionKey) }
      : {}),
  };
  const target: SignalApprovalReactionTarget = {
    approvalId,
    approvalKind: resolveApprovalKindFromId(approvalId),
    allowedDecisions,
    targetAuthorKeys,
    route,
  };
  signalApprovalReactionTargets.set(key, target);
  rememberPersistentApprovalReactionTarget({ key, target, ttlMs: params.ttlMs });
  return target;
}

export function unregisterSignalApprovalReactionTarget(params: {
  accountId: string;
  conversationKey: string;
  messageId: string;
}): void {
  const key = buildReactionTargetKey(params);
  if (!key) {
    return;
  }
  signalApprovalReactionTargets.delete(key);
  forgetPersistentApprovalReactionTarget(key);
}

function resolveTarget(params: {
  target: SignalApprovalReactionTarget | null | undefined;
  reactionKey: string;
  targetAuthorKeys: readonly string[];
}): SignalApprovalReactionResolution | null {
  const target = params.target;
  if (!target) {
    return null;
  }
  if (
    params.targetAuthorKeys.length === 0 ||
    !params.targetAuthorKeys.some((key) => target.targetAuthorKeys.includes(key))
  ) {
    return null;
  }
  const decision = resolveSignalApprovalReactionDecision(
    params.reactionKey,
    target.allowedDecisions,
  );
  return decision
    ? {
        approvalId: target.approvalId,
        approvalKind: target.approvalKind,
        decision,
        route: target.route,
      }
    : null;
}

export async function resolveSignalApprovalReactionTargetWithPersistence(params: {
  accountId: string;
  conversationKey: string;
  messageId: string;
  reactionKey: string;
  targetAuthor?: string | null;
  targetAuthorUuid?: string | null;
}): Promise<SignalApprovalReactionResolution | null> {
  const key = buildReactionTargetKey(params);
  if (!key) {
    return null;
  }
  const targetAuthorKeys = resolveSignalApprovalTargetAuthorKeys(params);
  if (targetAuthorKeys.length === 0) {
    return null;
  }
  const inMemory = resolveTarget({
    target: signalApprovalReactionTargets.get(key),
    reactionKey: params.reactionKey,
    targetAuthorKeys,
  });
  if (inMemory) {
    return inMemory;
  }
  const persisted = resolveTarget({
    target: await lookupPersistentApprovalReactionTarget(key),
    reactionKey: params.reactionKey,
    targetAuthorKeys,
  });
  if (persisted) {
    return persisted;
  }
  return null;
}

export async function maybeResolveSignalApprovalReaction(params: {
  cfg: OpenClawConfig;
  accountId: string;
  conversationKey: string;
  messageId: string;
  reactionKey: string;
  actorId?: string | null;
  targetAuthor?: string | null;
  targetAuthorUuid?: string | null;
  gatewayUrl?: string;
  logVerboseMessage?: (message: string) => void;
}): Promise<boolean> {
  const target = await resolveSignalApprovalReactionTargetWithPersistence({
    accountId: params.accountId,
    conversationKey: params.conversationKey,
    messageId: params.messageId,
    reactionKey: params.reactionKey,
    targetAuthor: params.targetAuthor,
    targetAuthorUuid: params.targetAuthorUuid,
  });
  if (!target) {
    return false;
  }

  if (!isSignalApprovalReactionRouteStillEnabled({ cfg: params.cfg, target })) {
    params.logVerboseMessage?.(
      `signal: approval reaction denied id=${target.approvalId}; approval route is no longer enabled`,
    );
    return true;
  }

  const actorId = params.actorId?.trim();
  if (!actorId) {
    params.logVerboseMessage?.(
      `signal: approval reaction ignored for ${target.approvalId}; missing actor identity`,
    );
    return true;
  }

  const approvers = getSignalApprovalApprovers({ cfg: params.cfg, accountId: params.accountId });
  if (approvers.length === 0) {
    params.logVerboseMessage?.(
      `signal: approval reaction denied id=${target.approvalId}; reactions require explicit approvers`,
    );
    return true;
  }
  const auth = signalApprovalAuth.authorizeActorAction({
    cfg: params.cfg,
    accountId: params.accountId,
    senderId: actorId,
    action: "approve",
    approvalKind: target.approvalKind,
  });
  if (!auth.authorized) {
    params.logVerboseMessage?.(
      `signal: approval reaction denied id=${target.approvalId} sender=${actorId}`,
    );
    return true;
  }

  const { isApprovalNotFoundError, resolveSignalApproval } = await loadApprovalResolver();
  try {
    await resolveSignalApproval({
      cfg: params.cfg,
      approvalId: target.approvalId,
      decision: target.decision,
      senderId: actorId,
      gatewayUrl: params.gatewayUrl,
    });
    params.logVerboseMessage?.(
      `signal: approval reaction resolved id=${target.approvalId} sender=${actorId} decision=${target.decision}`,
    );
    return true;
  } catch (error) {
    if (isApprovalNotFoundError(error)) {
      unregisterSignalApprovalReactionTarget({
        accountId: params.accountId,
        conversationKey: params.conversationKey,
        messageId: params.messageId,
      });
      params.logVerboseMessage?.(
        `signal: approval reaction ignored for expired approval id=${target.approvalId} sender=${actorId}`,
      );
      return true;
    }
    params.logVerboseMessage?.(
      `signal: approval reaction failed id=${target.approvalId} sender=${actorId}: ${String(error)}`,
    );
    return true;
  }
}

export function clearSignalApprovalReactionTargetsForTest(): void {
  signalApprovalReactionTargets.clear();
  persistentStore = undefined;
  persistentStoreDisabled = false;
  resolverRuntimePromise = undefined;
}

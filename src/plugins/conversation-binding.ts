import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import {
  createConversationBindingRecord,
  resolveConversationBindingRecord,
  unbindConversationBindingRecord,
} from "../bindings/records.js";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { formatErrorMessage } from "../infra/errors.js";
import { expandHomePrefix } from "../infra/home-dir.js";
import { writeJson } from "../infra/json-files.js";
import { type ConversationRef } from "../infra/outbound/session-binding-service.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalMap, resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import type {
  PluginConversationBinding,
  PluginConversationBindingResolvedEvent,
  PluginConversationBindingResolutionDecision,
  PluginConversationBindingRequestParams,
  PluginConversationBindingRequestResult,
} from "./conversation-binding.types.js";
import { getActivePluginRegistry } from "./runtime.js";

const log = createSubsystemLogger("plugins/binding");

const APPROVALS_PATH = "~/.openclaw/plugin-binding-approvals.json";
const PLUGIN_BINDING_CUSTOM_ID_PREFIX = "pluginbind";
const PLUGIN_BINDING_OWNER = "plugin";
const PLUGIN_BINDING_SESSION_PREFIX = "plugin-binding";
const LEGACY_CODEX_PLUGIN_SESSION_PREFIXES = [
  "openclaw-app-server:thread:",
  "openclaw-codex-app-server:thread:",
] as const;

// Runtime plugin conversation bindings are approval-driven and distinct from
// configured channel bindings compiled from config.
type PluginBindingApprovalDecision = PluginConversationBindingResolutionDecision;

type PluginBindingApprovalEntry = {
  pluginRoot: string;
  pluginId: string;
  pluginName?: string;
  channel: string;
  accountId: string;
  approvedAt: number;
};

type PluginBindingApprovalsFile = {
  version: 1;
  approvals: PluginBindingApprovalEntry[];
};

type PluginBindingConversation = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  threadId?: string | number;
};

type PendingPluginBindingRequest = {
  id: string;
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
  conversation: PluginBindingConversation;
  requestedAt: number;
  requestedBySenderId?: string;
  summary?: string;
  detachHint?: string;
  data?: Record<string, unknown>;
};

type PluginBindingApprovalAction = {
  approvalId: string;
  decision: PluginBindingApprovalDecision;
};

type PluginBindingIdentity = {
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
};

type PluginBindingMetadata = {
  pluginBindingOwner: "plugin";
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
  summary?: string;
  detachHint?: string;
  data?: Record<string, unknown>;
};

type PluginBindingResolveResult =
  | {
      status: "approved";
      binding: PluginConversationBinding;
      request: PendingPluginBindingRequest;
      decision: Exclude<PluginBindingApprovalDecision, "deny">;
    }
  | {
      status: "denied";
      request: PendingPluginBindingRequest;
    }
  | {
      status: "expired";
    };

const PLUGIN_BINDING_PENDING_REQUESTS_KEY = Symbol.for("openclaw.pluginBindingPendingRequests");

const pendingRequests = resolveGlobalMap<string, PendingPluginBindingRequest>(
  PLUGIN_BINDING_PENDING_REQUESTS_KEY,
);

type PluginBindingGlobalState = {
  fallbackNoticeBindingIds: Set<string>;
  approvalsCache: PluginBindingApprovalsFile | null;
  approvalsLoaded: boolean;
};

type PluginConversationBindingState = {
  ref: ConversationRef;
  record:
    | {
        bindingId: string;
        conversation: ConversationRef;
        boundAt: number;
        metadata?: Record<string, unknown>;
        targetSessionKey: string;
      }
    | null
    | undefined;
  binding: PluginConversationBinding | null;
  isLegacyForeignBinding: boolean;
};

const pluginBindingGlobalStateKey = Symbol.for("openclaw.plugins.binding.global-state");
const pluginBindingGlobalState = resolveGlobalSingleton<PluginBindingGlobalState>(
  pluginBindingGlobalStateKey,
  () => ({
    fallbackNoticeBindingIds: new Set<string>(),
    approvalsCache: null,
    approvalsLoaded: false,
  }),
);

function getPluginBindingGlobalState(): PluginBindingGlobalState {
  return pluginBindingGlobalState;
}

function resolveApprovalsPath(): string {
  return expandHomePrefix(APPROVALS_PATH);
}

function normalizeChannel(value: string): string {
  return normalizeOptionalLowercaseString(value) ?? "";
}

function normalizeConversation(params: PluginBindingConversation): PluginBindingConversation {
  return {
    channel: normalizeChannel(params.channel),
    accountId: params.accountId.trim() || "default",
    conversationId: params.conversationId.trim(),
    parentConversationId: normalizeOptionalString(params.parentConversationId),
    threadId:
      typeof params.threadId === "number"
        ? Math.trunc(params.threadId)
        : normalizeOptionalString(params.threadId?.toString()),
  };
}

function normalizeBindingData(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  return { ...(data as Record<string, unknown>) };
}

function toConversationRef(params: PluginBindingConversation): ConversationRef {
  const normalized = normalizeConversation(params);
  const channelId = normalizeChannelId(normalized.channel);
  const resolvedConversationRef = channelId
    ? getChannelPlugin(channelId)?.conversationBindings?.resolveConversationRef?.({
        accountId: normalized.accountId,
        conversationId: normalized.conversationId,
        parentConversationId: normalized.parentConversationId,
        threadId: normalized.threadId,
      })
    : null;
  if (resolvedConversationRef?.conversationId?.trim()) {
    return {
      channel: normalized.channel,
      accountId: normalized.accountId,
      conversationId: resolvedConversationRef.conversationId.trim(),
      ...(resolvedConversationRef.parentConversationId?.trim()
        ? { parentConversationId: resolvedConversationRef.parentConversationId.trim() }
        : {}),
    };
  }
  return {
    channel: normalized.channel,
    accountId: normalized.accountId,
    conversationId: normalized.conversationId,
    ...(normalized.parentConversationId
      ? { parentConversationId: normalized.parentConversationId }
      : {}),
  };
}

function buildApprovalScopeKey(params: {
  pluginRoot: string;
  channel: string;
  accountId: string;
}): string {
  return [
    params.pluginRoot,
    normalizeChannel(params.channel),
    params.accountId.trim() || "default",
  ].join("::");
}

function buildPluginBindingSessionKey(params: {
  pluginId: string;
  channel: string;
  accountId: string;
  conversationId: string;
}): string {
  const hash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        pluginId: params.pluginId,
        channel: normalizeChannel(params.channel),
        accountId: params.accountId,
        conversationId: params.conversationId,
      }),
    )
    .digest("hex")
    .slice(0, 24);
  return `${PLUGIN_BINDING_SESSION_PREFIX}:${params.pluginId}:${hash}`;
}

function buildPluginBindingIdentity(params: PluginBindingIdentity): PluginBindingIdentity {
  return {
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    pluginRoot: params.pluginRoot,
  };
}

function logPluginBindingLifecycleEvent(params: {
  event:
    | "migrating legacy record"
    | "auto-refresh"
    | "auto-approved"
    | "requested"
    | "detached"
    | "denied"
    | "approved";
  pluginId: string;
  pluginRoot: string;
  channel: string;
  accountId: string;
  conversationId: string;
  decision?: PluginBindingApprovalDecision;
}): void {
  const parts = [
    `plugin binding ${params.event}`,
    `plugin=${params.pluginId}`,
    `root=${params.pluginRoot}`,
    ...(params.decision ? [`decision=${params.decision}`] : []),
    `channel=${params.channel}`,
    `account=${params.accountId}`,
    `conversation=${params.conversationId}`,
  ];
  log.info(parts.join(" "));
}

function isLegacyPluginBindingRecord(params: {
  record:
    | {
        targetSessionKey: string;
        metadata?: Record<string, unknown>;
      }
    | null
    | undefined;
}): boolean {
  if (!params.record || isPluginOwnedBindingMetadata(params.record.metadata)) {
    return false;
  }
  const targetSessionKey = params.record.targetSessionKey.trim();
  return (
    targetSessionKey.startsWith(`${PLUGIN_BINDING_SESSION_PREFIX}:`) ||
    LEGACY_CODEX_PLUGIN_SESSION_PREFIXES.some((prefix) => targetSessionKey.startsWith(prefix))
  );
}

function buildApprovalInteractiveReply(
  approvalId: string,
): NonNullable<ReplyPayload["interactive"]> {
  return {
    blocks: [
      {
        type: "buttons",
        buttons: [
          {
            label: "Allow once",
            value: buildPluginBindingApprovalCustomId(approvalId, "allow-once"),
            style: "success",
          },
          {
            label: "Always allow",
            value: buildPluginBindingApprovalCustomId(approvalId, "allow-always"),
            style: "primary",
          },
          {
            label: "Deny",
            value: buildPluginBindingApprovalCustomId(approvalId, "deny"),
            style: "danger",
          },
        ],
      },
    ],
  };
}

function createApprovalRequestId(): string {
  // Keep approval ids compact so Telegram callback_data stays under its 64-byte limit.
  return crypto.randomBytes(9).toString("base64url");
}

function loadApprovalsFromDisk(): PluginBindingApprovalsFile {
  const filePath = resolveApprovalsPath();
  try {
    if (!fs.existsSync(filePath)) {
      return { version: 1, approvals: [] };
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PluginBindingApprovalsFile>;
    if (!Array.isArray(parsed.approvals)) {
      return { version: 1, approvals: [] };
    }
    return {
      version: 1,
      approvals: parsed.approvals
        .filter(
          (entry): entry is PluginBindingApprovalEntry =>
            entry !== null && typeof entry === "object",
        )
        .map((entry) => ({
          pluginRoot: typeof entry.pluginRoot === "string" ? entry.pluginRoot : "",
          pluginId: typeof entry.pluginId === "string" ? entry.pluginId : "",
          pluginName: typeof entry.pluginName === "string" ? entry.pluginName : undefined,
          channel: typeof entry.channel === "string" ? normalizeChannel(entry.channel) : "",
          accountId: normalizeOptionalString(entry.accountId) ?? "default",
          approvedAt:
            typeof entry.approvedAt === "number" && Number.isFinite(entry.approvedAt)
              ? Math.floor(entry.approvedAt)
              : Date.now(),
        }))
        .filter((entry) => entry.pluginRoot && entry.pluginId && entry.channel),
    };
  } catch (error) {
    log.warn(`plugin binding approvals load failed: ${String(error)}`);
    return { version: 1, approvals: [] };
  }
}

async function saveApprovals(file: PluginBindingApprovalsFile): Promise<void> {
  const filePath = resolveApprovalsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const state = getPluginBindingGlobalState();
  state.approvalsCache = file;
  state.approvalsLoaded = true;
  await writeJson(filePath, file, {
    mode: 0o600,
    trailingNewline: true,
  });
}

function getApprovals(): PluginBindingApprovalsFile {
  const state = getPluginBindingGlobalState();
  if (!state.approvalsLoaded || !state.approvalsCache) {
    state.approvalsCache = loadApprovalsFromDisk();
    state.approvalsLoaded = true;
  }
  return state.approvalsCache;
}

function hasPersistentApproval(params: {
  pluginRoot: string;
  channel: string;
  accountId: string;
}): boolean {
  const key = buildApprovalScopeKey(params);
  return getApprovals().approvals.some(
    (entry) =>
      buildApprovalScopeKey({
        pluginRoot: entry.pluginRoot,
        channel: entry.channel,
        accountId: entry.accountId,
      }) === key,
  );
}

async function addPersistentApproval(entry: PluginBindingApprovalEntry): Promise<void> {
  const file = getApprovals();
  const key = buildApprovalScopeKey(entry);
  const approvals = file.approvals.filter(
    (existing) =>
      buildApprovalScopeKey({
        pluginRoot: existing.pluginRoot,
        channel: existing.channel,
        accountId: existing.accountId,
      }) !== key,
  );
  approvals.push(entry);
  await saveApprovals({
    version: 1,
    approvals,
  });
}

function buildBindingMetadata(params: {
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
  summary?: string;
  detachHint?: string;
  data?: Record<string, unknown>;
}): PluginBindingMetadata {
  return {
    pluginBindingOwner: PLUGIN_BINDING_OWNER,
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    pluginRoot: params.pluginRoot,
    summary: normalizeOptionalString(params.summary),
    detachHint: normalizeOptionalString(params.detachHint),
    data: normalizeBindingData(params.data),
  };
}

export function isPluginOwnedBindingMetadata(metadata: unknown): metadata is PluginBindingMetadata {
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  const record = metadata as Record<string, unknown>;
  return (
    record.pluginBindingOwner === PLUGIN_BINDING_OWNER &&
    typeof record.pluginId === "string" &&
    typeof record.pluginRoot === "string"
  );
}

export function isPluginOwnedSessionBindingRecord(
  record:
    | {
        metadata?: Record<string, unknown>;
      }
    | null
    | undefined,
): boolean {
  return isPluginOwnedBindingMetadata(record?.metadata);
}

export function toPluginConversationBinding(
  record:
    | {
        bindingId: string;
        conversation: ConversationRef;
        boundAt: number;
        metadata?: Record<string, unknown>;
      }
    | null
    | undefined,
): PluginConversationBinding | null {
  if (!record || !isPluginOwnedBindingMetadata(record.metadata)) {
    return null;
  }
  const metadata = record.metadata;
  return {
    bindingId: record.bindingId,
    pluginId: metadata.pluginId,
    pluginName: metadata.pluginName,
    pluginRoot: metadata.pluginRoot,
    channel: record.conversation.channel,
    accountId: record.conversation.accountId,
    conversationId: record.conversation.conversationId,
    parentConversationId: record.conversation.parentConversationId,
    boundAt: record.boundAt,
    summary: metadata.summary,
    detachHint: metadata.detachHint,
    data: metadata.data,
  };
}

function withConversationBindingContext(
  binding: PluginConversationBinding,
  conversation: PluginBindingConversation,
): PluginConversationBinding {
  return {
    ...binding,
    parentConversationId: conversation.parentConversationId,
    threadId: conversation.threadId,
  };
}

function resolvePluginConversationBindingState(params: {
  conversation: PluginBindingConversation;
}): PluginConversationBindingState {
  const ref = toConversationRef(params.conversation);
  const record = resolveConversationBindingRecord(ref);
  const binding = toPluginConversationBinding(record);
  return {
    ref,
    record,
    binding,
    isLegacyForeignBinding: isLegacyPluginBindingRecord({ record }),
  };
}

function resolveOwnedPluginConversationBinding(params: {
  pluginRoot: string;
  conversation: PluginBindingConversation;
}): PluginConversationBinding | null {
  const state = resolvePluginConversationBindingState({
    conversation: params.conversation,
  });
  if (!state.binding || state.binding.pluginRoot !== params.pluginRoot) {
    return null;
  }
  return withConversationBindingContext(state.binding, params.conversation);
}

function bindConversationFromIdentity(params: {
  identity: PluginBindingIdentity;
  conversation: PluginBindingConversation;
  summary?: string;
  detachHint?: string;
  data?: Record<string, unknown>;
}): Promise<PluginConversationBinding> {
  return bindConversationNow({
    identity: buildPluginBindingIdentity(params.identity),
    conversation: params.conversation,
    summary: params.summary,
    detachHint: params.detachHint,
    data: params.data,
  });
}

function bindConversationFromRequest(
  request: Pick<
    PendingPluginBindingRequest,
    "pluginId" | "pluginName" | "pluginRoot" | "conversation" | "summary" | "detachHint" | "data"
  >,
): Promise<PluginConversationBinding> {
  return bindConversationFromIdentity({
    identity: buildPluginBindingIdentity(request),
    conversation: request.conversation,
    summary: request.summary,
    detachHint: request.detachHint,
    data: request.data,
  });
}

function buildApprovalEntryFromRequest(
  request: Pick<
    PendingPluginBindingRequest,
    "pluginRoot" | "pluginId" | "pluginName" | "conversation"
  >,
  approvedAt = Date.now(),
): PluginBindingApprovalEntry {
  return {
    pluginRoot: request.pluginRoot,
    pluginId: request.pluginId,
    pluginName: request.pluginName,
    channel: request.conversation.channel,
    accountId: request.conversation.accountId,
    approvedAt,
  };
}

async function bindConversationNow(params: {
  identity: PluginBindingIdentity;
  conversation: PluginBindingConversation;
  summary?: string;
  detachHint?: string;
  data?: Record<string, unknown>;
}): Promise<PluginConversationBinding> {
  const ref = toConversationRef(params.conversation);
  const targetSessionKey = buildPluginBindingSessionKey({
    pluginId: params.identity.pluginId,
    channel: ref.channel,
    accountId: ref.accountId,
    conversationId: ref.conversationId,
  });
  const record = await createConversationBindingRecord({
    targetSessionKey,
    targetKind: "session",
    conversation: ref,
    placement: "current",
    metadata: buildBindingMetadata({
      pluginId: params.identity.pluginId,
      pluginName: params.identity.pluginName,
      pluginRoot: params.identity.pluginRoot,
      summary: params.summary,
      detachHint: params.detachHint,
      data: params.data,
    }),
  });
  const binding = toPluginConversationBinding(record);
  if (!binding) {
    throw new Error("plugin binding was created without plugin metadata");
  }
  return withConversationBindingContext(binding, params.conversation);
}

function buildApprovalMessage(request: PendingPluginBindingRequest): string {
  const lines = [
    `Plugin bind approval required`,
    `Plugin: ${request.pluginName ?? request.pluginId}`,
    `Channel: ${request.conversation.channel}`,
    `Account: ${request.conversation.accountId}`,
  ];
  if (request.summary?.trim()) {
    lines.push(`Request: ${request.summary.trim()}`);
  } else {
    lines.push("Request: Bind this conversation so future plain messages route to the plugin.");
  }
  lines.push("Choose whether to allow this plugin to bind the current conversation.");
  return lines.join("\n");
}

function resolvePluginBindingDisplayName(binding: {
  pluginId: string;
  pluginName?: string;
}): string {
  return normalizeOptionalString(binding.pluginName) || binding.pluginId;
}

function buildDetachHintSuffix(detachHint?: string): string {
  const trimmed = detachHint?.trim();
  return trimmed ? ` To detach this conversation, use ${trimmed}.` : "";
}

export function buildPluginBindingUnavailableText(binding: PluginConversationBinding): string {
  return `The bound plugin ${resolvePluginBindingDisplayName(binding)} is not currently loaded. Routing this message to OpenClaw instead. If this started after an update, run "openclaw doctor --fix"; otherwise reinstall or enable the plugin.${buildDetachHintSuffix(binding.detachHint)}`;
}

export function buildPluginBindingDeclinedText(binding: PluginConversationBinding): string {
  return `The bound plugin ${resolvePluginBindingDisplayName(binding)} did not handle this message. This conversation is still bound to that plugin.${buildDetachHintSuffix(binding.detachHint)}`;
}

export function buildPluginBindingErrorText(binding: PluginConversationBinding): string {
  return `The bound plugin ${resolvePluginBindingDisplayName(binding)} hit an error handling this message. This conversation is still bound to that plugin.${buildDetachHintSuffix(binding.detachHint)}`;
}

export function hasShownPluginBindingFallbackNotice(bindingId: string): boolean {
  const normalized = bindingId.trim();
  if (!normalized) {
    return false;
  }
  return getPluginBindingGlobalState().fallbackNoticeBindingIds.has(normalized);
}

export function markPluginBindingFallbackNoticeShown(bindingId: string): void {
  const normalized = bindingId.trim();
  if (!normalized) {
    return;
  }
  getPluginBindingGlobalState().fallbackNoticeBindingIds.add(normalized);
}

function buildPendingReply(request: PendingPluginBindingRequest): ReplyPayload {
  return {
    text: buildApprovalMessage(request),
    interactive: buildApprovalInteractiveReply(request.id),
  };
}

function encodeCustomIdValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeCustomIdValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function buildPluginBindingApprovalCustomId(
  approvalId: string,
  decision: PluginBindingApprovalDecision,
): string {
  const decisionCode = decision === "allow-once" ? "o" : decision === "allow-always" ? "a" : "d";
  return `${PLUGIN_BINDING_CUSTOM_ID_PREFIX}:${encodeCustomIdValue(approvalId)}:${decisionCode}`;
}

export function parsePluginBindingApprovalCustomId(
  value: string,
): PluginBindingApprovalAction | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith(`${PLUGIN_BINDING_CUSTOM_ID_PREFIX}:`)) {
    return null;
  }
  const body = trimmed.slice(`${PLUGIN_BINDING_CUSTOM_ID_PREFIX}:`.length);
  const separator = body.lastIndexOf(":");
  if (separator <= 0 || separator === body.length - 1) {
    return null;
  }
  const rawId = body.slice(0, separator).trim();
  const rawDecisionCode = body.slice(separator + 1).trim();
  if (!rawId) {
    return null;
  }
  const rawDecision =
    rawDecisionCode === "o"
      ? "allow-once"
      : rawDecisionCode === "a"
        ? "allow-always"
        : rawDecisionCode === "d"
          ? "deny"
          : null;
  if (!rawDecision) {
    return null;
  }
  return {
    approvalId: decodeCustomIdValue(rawId),
    decision: rawDecision,
  };
}

export async function requestPluginConversationBinding(params: {
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
  conversation: PluginBindingConversation;
  requestedBySenderId?: string;
  binding: PluginConversationBindingRequestParams | undefined;
}): Promise<PluginConversationBindingRequestResult> {
  const conversation = normalizeConversation(params.conversation);
  const state = resolvePluginConversationBindingState({
    conversation,
  });
  if (state.record && !state.binding) {
    if (state.isLegacyForeignBinding) {
      logPluginBindingLifecycleEvent({
        event: "migrating legacy record",
        pluginId: params.pluginId,
        pluginRoot: params.pluginRoot,
        channel: state.ref.channel,
        accountId: state.ref.accountId,
        conversationId: state.ref.conversationId,
      });
    } else {
      return {
        status: "error",
        message:
          "This conversation is already bound by core routing and cannot be claimed by a plugin.",
      };
    }
  }
  if (state.binding && state.binding.pluginRoot !== params.pluginRoot) {
    return {
      status: "error",
      message: `This conversation is already bound by plugin "${state.binding.pluginName ?? state.binding.pluginId}".`,
    };
  }

  if (state.binding && state.binding.pluginRoot === params.pluginRoot) {
    const rebound = await bindConversationFromIdentity({
      identity: buildPluginBindingIdentity(params),
      conversation,
      summary: params.binding?.summary,
      detachHint: params.binding?.detachHint,
      data: params.binding?.data,
    });
    logPluginBindingLifecycleEvent({
      event: "auto-refresh",
      pluginId: params.pluginId,
      pluginRoot: params.pluginRoot,
      channel: state.ref.channel,
      accountId: state.ref.accountId,
      conversationId: state.ref.conversationId,
    });
    return { status: "bound", binding: rebound };
  }

  if (
    hasPersistentApproval({
      pluginRoot: params.pluginRoot,
      channel: state.ref.channel,
      accountId: state.ref.accountId,
    })
  ) {
    const bound = await bindConversationFromIdentity({
      identity: buildPluginBindingIdentity(params),
      conversation,
      summary: params.binding?.summary,
      detachHint: params.binding?.detachHint,
      data: params.binding?.data,
    });
    logPluginBindingLifecycleEvent({
      event: "auto-approved",
      pluginId: params.pluginId,
      pluginRoot: params.pluginRoot,
      channel: state.ref.channel,
      accountId: state.ref.accountId,
      conversationId: state.ref.conversationId,
    });
    return { status: "bound", binding: bound };
  }

  const request: PendingPluginBindingRequest = {
    id: createApprovalRequestId(),
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    pluginRoot: params.pluginRoot,
    conversation,
    requestedAt: Date.now(),
    requestedBySenderId: normalizeOptionalString(params.requestedBySenderId),
    summary: normalizeOptionalString(params.binding?.summary),
    detachHint: normalizeOptionalString(params.binding?.detachHint),
    data: normalizeBindingData(params.binding?.data),
  };
  pendingRequests.set(request.id, request);
  logPluginBindingLifecycleEvent({
    event: "requested",
    pluginId: params.pluginId,
    pluginRoot: params.pluginRoot,
    channel: state.ref.channel,
    accountId: state.ref.accountId,
    conversationId: state.ref.conversationId,
  });
  return {
    status: "pending",
    approvalId: request.id,
    reply: buildPendingReply(request),
  };
}

export async function getCurrentPluginConversationBinding(params: {
  pluginRoot: string;
  conversation: PluginBindingConversation;
}): Promise<PluginConversationBinding | null> {
  return resolveOwnedPluginConversationBinding(params);
}

export async function detachPluginConversationBinding(params: {
  pluginRoot: string;
  conversation: PluginBindingConversation;
}): Promise<{ removed: boolean }> {
  const binding = resolveOwnedPluginConversationBinding(params);
  if (!binding) {
    return { removed: false };
  }
  await unbindConversationBindingRecord({
    bindingId: binding.bindingId,
    reason: "plugin-detach",
  });
  logPluginBindingLifecycleEvent({
    event: "detached",
    pluginId: binding.pluginId,
    pluginRoot: binding.pluginRoot,
    channel: binding.channel,
    accountId: binding.accountId,
    conversationId: binding.conversationId,
  });
  return { removed: true };
}

export async function resolvePluginConversationBindingApproval(params: {
  approvalId: string;
  decision: PluginBindingApprovalDecision;
  senderId?: string;
}): Promise<PluginBindingResolveResult> {
  const request = pendingRequests.get(params.approvalId);
  if (!request) {
    return { status: "expired" };
  }
  if (
    request.requestedBySenderId &&
    params.senderId?.trim() &&
    request.requestedBySenderId !== params.senderId.trim()
  ) {
    return { status: "expired" };
  }
  pendingRequests.delete(params.approvalId);
  if (params.decision === "deny") {
    dispatchPluginConversationBindingResolved({
      status: "denied",
      decision: "deny",
      request,
    });
    logPluginBindingLifecycleEvent({
      event: "denied",
      pluginId: request.pluginId,
      pluginRoot: request.pluginRoot,
      channel: request.conversation.channel,
      accountId: request.conversation.accountId,
      conversationId: request.conversation.conversationId,
    });
    return { status: "denied", request };
  }
  if (params.decision === "allow-always") {
    await addPersistentApproval(buildApprovalEntryFromRequest(request));
  }
  const binding = await bindConversationFromRequest(request);
  logPluginBindingLifecycleEvent({
    event: "approved",
    pluginId: request.pluginId,
    pluginRoot: request.pluginRoot,
    decision: params.decision,
    channel: request.conversation.channel,
    accountId: request.conversation.accountId,
    conversationId: request.conversation.conversationId,
  });
  dispatchPluginConversationBindingResolved({
    status: "approved",
    binding,
    decision: params.decision,
    request,
  });
  return {
    status: "approved",
    binding,
    request,
    decision: params.decision,
  };
}

function dispatchPluginConversationBindingResolved(params: {
  status: "approved" | "denied";
  binding?: PluginConversationBinding;
  decision: PluginConversationBindingResolutionDecision;
  request: PendingPluginBindingRequest;
}): void {
  // Keep platform interaction acks fast even if the plugin does slow post-bind work.
  queueMicrotask(() => {
    void notifyPluginConversationBindingResolved(params).catch((error) => {
      log.warn(`plugin binding resolved dispatch failed: ${String(error)}`);
    });
  });
}

async function notifyPluginConversationBindingResolved(params: {
  status: "approved" | "denied";
  binding?: PluginConversationBinding;
  decision: PluginConversationBindingResolutionDecision;
  request: PendingPluginBindingRequest;
}): Promise<void> {
  const registrations = getActivePluginRegistry()?.conversationBindingResolvedHandlers ?? [];
  for (const registration of registrations) {
    if (registration.pluginId !== params.request.pluginId) {
      continue;
    }
    const registeredRoot = registration.pluginRoot?.trim();
    if (registeredRoot && registeredRoot !== params.request.pluginRoot) {
      continue;
    }
    try {
      const event: PluginConversationBindingResolvedEvent = {
        status: params.status,
        binding: params.binding,
        decision: params.decision,
        request: {
          summary: params.request.summary,
          detachHint: params.request.detachHint,
          data: params.request.data,
          requestedBySenderId: params.request.requestedBySenderId,
          conversation: params.request.conversation,
        },
      };
      await registration.handler(event);
    } catch (error) {
      log.warn(
        `plugin binding resolved callback failed plugin=${registration.pluginId} root=${registration.pluginRoot ?? "<none>"}: ${formatErrorMessage(error)}`,
      );
    }
  }
}

export function buildPluginBindingResolvedText(params: PluginBindingResolveResult): string {
  if (params.status === "expired") {
    return "That plugin bind approval expired. Retry the bind command.";
  }
  if (params.status === "denied") {
    return `Denied plugin bind request for ${params.request.pluginName ?? params.request.pluginId}.`;
  }
  const summarySuffix = params.request.summary?.trim() ? ` ${params.request.summary.trim()}` : "";
  if (params.decision === "allow-always") {
    return `Allowed ${params.request.pluginName ?? params.request.pluginId} to bind this conversation.${summarySuffix}`;
  }
  return `Allowed ${params.request.pluginName ?? params.request.pluginId} to bind this conversation once.${summarySuffix}`;
}

export const __testing = {
  reset() {
    pendingRequests.clear();
    const state = getPluginBindingGlobalState();
    state.approvalsCache = null;
    state.approvalsLoaded = false;
    state.fallbackNoticeBindingIds.clear();
  },
};

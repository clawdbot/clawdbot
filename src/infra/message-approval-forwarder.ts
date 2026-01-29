import type { ClawdbotConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import type {
  ExecApprovalForwardTarget,
  MessageApprovalForwardingConfig,
} from "../config/types.approvals.js";
import type { MessageApprovalDecision } from "../gateway/message-approval-manager.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import { deliverOutboundPayloads } from "./outbound/deliver.js";
import { resolveSessionDeliveryTarget } from "./outbound/targets.js";

const log = createSubsystemLogger("gateway/message-approvals");

export type MessageApprovalRequest = {
  id: string;
  request: {
    action: string;
    channel: string;
    to: string;
    message?: string | null;
    mediaUrl?: string | null;
    agentId?: string | null;
    sessionKey?: string | null;
  };
  createdAtMs: number;
  expiresAtMs: number;
};

export type MessageApprovalResolved = {
  id: string;
  decision: MessageApprovalDecision;
  resolvedBy?: string | null;
  ts: number;
};

type ForwardTarget = ExecApprovalForwardTarget & { source: "session" | "target" };

type PendingApproval = {
  request: MessageApprovalRequest;
  targets: ForwardTarget[];
  timeoutId: NodeJS.Timeout | null;
};

export type MessageApprovalForwarder = {
  handleRequested: (request: MessageApprovalRequest) => Promise<void>;
  handleResolved: (resolved: MessageApprovalResolved) => Promise<void>;
  stop: () => void;
};

export type MessageApprovalForwarderDeps = {
  getConfig?: () => ClawdbotConfig;
  deliver?: typeof deliverOutboundPayloads;
  nowMs?: () => number;
  resolveSessionTarget?: (params: {
    cfg: ClawdbotConfig;
    request: MessageApprovalRequest;
  }) => ExecApprovalForwardTarget | null;
};

const DEFAULT_MODE = "session" as const;

function normalizeMode(mode?: MessageApprovalForwardingConfig["mode"]) {
  return mode ?? DEFAULT_MODE;
}

function matchSessionFilter(sessionKey: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return sessionKey.includes(pattern) || new RegExp(pattern).test(sessionKey);
    } catch {
      return sessionKey.includes(pattern);
    }
  });
}

function shouldForward(params: {
  config?: MessageApprovalForwardingConfig;
  request: MessageApprovalRequest;
}): boolean {
  const config = params.config;
  if (!config?.enabled) return false;
  if (config.actions?.length) {
    if (!config.actions.includes(params.request.request.action)) return false;
  }
  if (config.channels?.length && !config.channels.includes("*")) {
    const channel = normalizeMessageChannel(params.request.request.channel);
    if (!channel || !config.channels.includes(channel)) return false;
  }
  if (config.agentFilter?.length) {
    const agentId =
      params.request.request.agentId ??
      parseAgentSessionKey(params.request.request.sessionKey)?.agentId;
    if (!agentId) return false;
    if (!config.agentFilter.includes(agentId)) return false;
  }
  if (config.sessionFilter?.length) {
    const sessionKey = params.request.request.sessionKey;
    if (!sessionKey) return false;
    if (!matchSessionFilter(sessionKey, config.sessionFilter)) return false;
  }
  return true;
}

function buildTargetKey(target: ExecApprovalForwardTarget): string {
  const channel = normalizeMessageChannel(target.channel) ?? target.channel;
  const accountId = target.accountId ?? "";
  const threadId = target.threadId ?? "";
  return [channel, target.to, accountId, threadId].join(":");
}

function truncateMessage(message: string | null | undefined, maxLen = 200): string {
  if (!message) return "(empty)";
  if (message.length <= maxLen) return message;
  return `${message.slice(0, maxLen)}...`;
}

function buildRequestMessage(request: MessageApprovalRequest, nowMs: number) {
  const lines: string[] = ["📬 Message approval required", `ID: ${request.id}`];
  lines.push(`Action: ${request.request.action}`);
  lines.push(`Channel: ${request.request.channel}`);
  lines.push(`To: ${request.request.to}`);
  if (request.request.message) {
    lines.push(`Message: ${truncateMessage(request.request.message)}`);
  }
  if (request.request.mediaUrl) lines.push(`Media: ${request.request.mediaUrl}`);
  if (request.request.agentId) lines.push(`Agent: ${request.request.agentId}`);
  const expiresIn = Math.max(0, Math.round((request.expiresAtMs - nowMs) / 1000));
  lines.push(`Expires in: ${expiresIn}s`);
  lines.push("Reply with: /approve <id> allow|deny");
  return lines.join("\n");
}

function decisionLabel(decision: MessageApprovalDecision): string {
  if (decision === "allow") return "allowed";
  return "denied";
}

function buildResolvedMessage(resolved: MessageApprovalResolved) {
  const base = `✅ Message approval ${decisionLabel(resolved.decision)}.`;
  const by = resolved.resolvedBy ? ` Resolved by ${resolved.resolvedBy}.` : "";
  return `${base}${by} ID: ${resolved.id}`;
}

function buildExpiredMessage(request: MessageApprovalRequest) {
  return `⏱️ Message approval expired. ID: ${request.id}`;
}

function defaultResolveSessionTarget(params: {
  cfg: ClawdbotConfig;
  request: MessageApprovalRequest;
}): ExecApprovalForwardTarget | null {
  const sessionKey = params.request.request.sessionKey?.trim();
  if (!sessionKey) return null;
  const parsed = parseAgentSessionKey(sessionKey);
  const agentId = parsed?.agentId ?? params.request.request.agentId ?? "main";
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  if (!entry) return null;
  const target = resolveSessionDeliveryTarget({ entry, requestedChannel: "last" });
  if (!target.channel || !target.to) return null;
  if (!isDeliverableMessageChannel(target.channel)) return null;
  return {
    channel: target.channel,
    to: target.to,
    accountId: target.accountId,
    threadId: target.threadId,
  };
}

async function deliverToTargets(params: {
  cfg: ClawdbotConfig;
  targets: ForwardTarget[];
  text: string;
  deliver: typeof deliverOutboundPayloads;
  shouldSend?: () => boolean;
}) {
  const deliveries = params.targets.map(async (target) => {
    if (params.shouldSend && !params.shouldSend()) return;
    const channel = normalizeMessageChannel(target.channel) ?? target.channel;
    if (!isDeliverableMessageChannel(channel)) return;
    try {
      await params.deliver({
        cfg: params.cfg,
        channel,
        to: target.to,
        accountId: target.accountId,
        threadId: target.threadId,
        payloads: [{ text: params.text }],
      });
    } catch (err) {
      log.error(`message approvals: failed to deliver to ${channel}:${target.to}: ${String(err)}`);
    }
  });
  await Promise.allSettled(deliveries);
}

export function createMessageApprovalForwarder(
  deps: MessageApprovalForwarderDeps = {},
): MessageApprovalForwarder {
  const getConfig = deps.getConfig ?? loadConfig;
  const deliver = deps.deliver ?? deliverOutboundPayloads;
  const nowMs = deps.nowMs ?? Date.now;
  const resolveSessionTarget = deps.resolveSessionTarget ?? defaultResolveSessionTarget;
  const pending = new Map<string, PendingApproval>();

  const handleRequested = async (request: MessageApprovalRequest) => {
    const cfg = getConfig();
    const config = cfg.approvals?.message;
    if (!shouldForward({ config, request })) return;

    const mode = normalizeMode(config?.mode);
    const targets: ForwardTarget[] = [];
    const seen = new Set<string>();

    if (mode === "session" || mode === "both") {
      const sessionTarget = resolveSessionTarget({ cfg, request });
      if (sessionTarget) {
        const key = buildTargetKey(sessionTarget);
        if (!seen.has(key)) {
          seen.add(key);
          targets.push({ ...sessionTarget, source: "session" });
        }
      }
    }

    if (mode === "targets" || mode === "both") {
      const explicitTargets = config?.targets ?? [];
      for (const target of explicitTargets) {
        const key = buildTargetKey(target);
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push({ ...target, source: "target" });
      }
    }

    if (targets.length === 0) return;

    const expiresInMs = Math.max(0, request.expiresAtMs - nowMs());
    const timeoutId = setTimeout(() => {
      void (async () => {
        const entry = pending.get(request.id);
        if (!entry) return;
        pending.delete(request.id);
        const expiredText = buildExpiredMessage(request);
        await deliverToTargets({ cfg, targets: entry.targets, text: expiredText, deliver });
      })();
    }, expiresInMs);
    timeoutId.unref?.();

    const pendingEntry: PendingApproval = { request, targets, timeoutId };
    pending.set(request.id, pendingEntry);

    if (pending.get(request.id) !== pendingEntry) return;

    const text = buildRequestMessage(request, nowMs());
    await deliverToTargets({
      cfg,
      targets,
      text,
      deliver,
      shouldSend: () => pending.get(request.id) === pendingEntry,
    });
  };

  const handleResolved = async (resolved: MessageApprovalResolved) => {
    const entry = pending.get(resolved.id);
    if (!entry) return;
    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    pending.delete(resolved.id);

    const cfg = getConfig();
    const text = buildResolvedMessage(resolved);
    await deliverToTargets({ cfg, targets: entry.targets, text, deliver });
  };

  const stop = () => {
    for (const entry of pending.values()) {
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
    }
    pending.clear();
  };

  return { handleRequested, handleResolved, stop };
}

export function shouldForwardMessageApproval(params: {
  config?: MessageApprovalForwardingConfig;
  request: MessageApprovalRequest;
}): boolean {
  return shouldForward(params);
}

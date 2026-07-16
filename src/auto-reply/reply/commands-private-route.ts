/** Private command reply routing for sensitive owner-only command output. */
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  getLoadedChannelPlugin,
  listChannelPlugins,
  resolveChannelApprovalAdapter,
} from "../../channels/plugins/index.js";
import type { ExecApprovalRequest } from "../../infra/exec-approvals.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { routeReply } from "./route-reply.js";

/** Resolved private delivery target for command replies and approvals. */
export type PrivateCommandRouteTarget = {
  channel: string;
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
};

const PRIVATE_COMMAND_APPROVAL_ROUTE_TTL_MS = 5 * 60_000;
const EXPIRED_PRIVATE_COMMAND_APPROVAL_ROUTE_EXPIRES_AT_MS = 0;

/** Resolves expiry timestamp for temporary private approval routes. */
export function resolvePrivateCommandApprovalRouteExpiresAtMs(nowMs = Date.now()): number {
  return (
    resolveExpiresAtMsFromDurationMs(PRIVATE_COMMAND_APPROVAL_ROUTE_TTL_MS, { nowMs }) ??
    EXPIRED_PRIVATE_COMMAND_APPROVAL_ROUTE_EXPIRES_AT_MS
  );
}

/** Finds private owner DM routes that can receive sensitive command replies. */
export async function resolvePrivateCommandRouteTargets(params: {
  commandParams: HandleCommandsParams;
  request: ExecApprovalRequest;
}): Promise<PrivateCommandRouteTarget[]> {
  const originChannel = params.commandParams.command.channel;
  const targets: PrivateCommandRouteTarget[] = [];
  for (const candidate of listPrivateCommandRouteCandidateChannels(originChannel)) {
    const native = resolveChannelApprovalAdapter(candidate.plugin)?.native;
    if (!native?.resolveApproverDmTargets) {
      continue;
    }
    const accountId =
      candidate.channel === originChannel
        ? (params.commandParams.ctx.AccountId ?? undefined)
        : undefined;
    const capabilities = native.describeDeliveryCapabilities({
      cfg: params.commandParams.cfg,
      accountId,
      approvalKind: "exec",
      request: params.request,
    });
    if (!capabilities.enabled || !capabilities.supportsApproverDmSurface) {
      continue;
    }
    const resolvedTargets = await native.resolveApproverDmTargets({
      cfg: params.commandParams.cfg,
      accountId,
      approvalKind: "exec",
      request: params.request,
    });
    for (const target of resolvedTargets) {
      targets.push({
        channel: candidate.channel,
        to: target.to,
        accountId,
        threadId: target.threadId,
      });
    }
  }
  return sortPrivateCommandRouteTargets({
    cfg: params.commandParams.cfg,
    originChannel,
    targets: filterPrivateCommandRouteOwnerTargets({
      cfg: params.commandParams.cfg,
      targets: dedupePrivateCommandRouteTargets(targets),
    }),
  });
}

/** Delivers a sensitive command reply to the resolved private targets. */
export async function deliverPrivateCommandReply(params: {
  commandParams: HandleCommandsParams;
  targets: PrivateCommandRouteTarget[];
  reply: ReplyPayload;
}): Promise<boolean> {
  const results = await Promise.allSettled(
    params.targets.map((target) =>
      routeReply({
        payload: params.reply,
        channel: target.channel as OriginatingChannelType,
        to: target.to,
        accountId: target.accountId ?? undefined,
        threadId: target.threadId ?? undefined,
        cfg: params.commandParams.cfg,
        sessionKey: params.commandParams.sessionKey,
        policyConversationType: "direct",
        mirror: false,
        isGroup: false,
        replyKind: "final",
      }),
    ),
  );
  return results.some((result) => result.status === "fulfilled" && result.value.ok);
}

/** Reads the command message thread id from command context. */
export function readCommandMessageThreadId(params: HandleCommandsParams): string | undefined {
  return typeof params.ctx.MessageThreadId === "string" ||
    typeof params.ctx.MessageThreadId === "number"
    ? String(params.ctx.MessageThreadId)
    : undefined;
}

/** Reads the best delivery target for command route resolution. */
export function readCommandDeliveryTarget(params: HandleCommandsParams): string | undefined {
  return (
    normalizeOptionalString(params.ctx.OriginatingTo) ??
    normalizeOptionalString(params.command.to) ??
    normalizeOptionalString(params.command.from)
  );
}

/**
 * Resolves where an exec approval prompt for a command should be delivered:
 * the private owner-DM target when one was resolved, else the originating
 * command surface. Keeps the fallback ternaries in one place so private and
 * origin routing cannot drift between command handlers.
 */
export function resolveCommandExecApprovalRoute(params: {
  commandParams: HandleCommandsParams;
  privateApprovalTarget?: PrivateCommandRouteTarget;
}): {
  messageProvider: string;
  currentChannelId: string | undefined;
  currentThreadTs: string | undefined;
  accountId: string | undefined;
} {
  const target = params.privateApprovalTarget;
  return {
    messageProvider: target?.channel ?? params.commandParams.command.channel,
    currentChannelId: target?.to ?? readCommandDeliveryTarget(params.commandParams),
    currentThreadTs: target
      ? target.threadId == null
        ? undefined
        : String(target.threadId)
      : readCommandMessageThreadId(params.commandParams),
    accountId: target
      ? (target.accountId ?? undefined)
      : (params.commandParams.ctx.AccountId ?? undefined),
  };
}

function listPrivateCommandRouteCandidateChannels(originChannel: string) {
  const plugins = [getLoadedChannelPlugin(originChannel), ...listChannelPlugins()].filter(
    (plugin): plugin is NonNullable<ReturnType<typeof getLoadedChannelPlugin>> =>
      Boolean(plugin?.id),
  );
  const seen = new Set<string>();
  const candidates: Array<{ channel: string; plugin: (typeof plugins)[number] }> = [];
  for (const plugin of plugins) {
    const channel = normalizeOptionalString(plugin.id) ?? "";
    if (!channel || seen.has(channel)) {
      continue;
    }
    seen.add(channel);
    candidates.push({ channel, plugin });
  }
  return candidates;
}

function resolveOwnerPreferenceIndex(params: {
  cfg: HandleCommandsParams["cfg"];
  target: PrivateCommandRouteTarget;
}): number {
  const owners = params.cfg.commands?.ownerAllowFrom;
  if (!Array.isArray(owners) || owners.length === 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  const keys = buildPrivateCommandRouteOwnerKeys(params.target);
  const index = owners.findIndex((owner) =>
    keys.has(normalizeLowercaseStringOrEmpty(String(owner))),
  );
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function buildPrivateCommandRouteOwnerKeys(target: PrivateCommandRouteTarget): Set<string> {
  const channel = normalizeLowercaseStringOrEmpty(target.channel);
  const to = normalizeLowercaseStringOrEmpty(target.to);
  const keys = new Set<string>();
  if (to) {
    keys.add(to);
    keys.add(`user:${to}`);
  }
  if (channel && to) {
    keys.add(`${channel}:${to}`);
    for (const prefix of getLoadedChannelPlugin(channel)?.messaging?.targetPrefixes ?? []) {
      const normalizedPrefix = normalizeLowercaseStringOrEmpty(prefix);
      if (normalizedPrefix) {
        keys.add(`${normalizedPrefix}:${to}`);
      }
    }
  }
  return keys;
}

function sortPrivateCommandRouteTargets(params: {
  cfg: HandleCommandsParams["cfg"];
  originChannel: string;
  targets: PrivateCommandRouteTarget[];
}): PrivateCommandRouteTarget[] {
  return params.targets
    .map((target, index) => ({
      target,
      index,
      ownerPreference: resolveOwnerPreferenceIndex({ cfg: params.cfg, target }),
      originPreference: target.channel === params.originChannel ? 0 : 1,
    }))
    .toSorted((a, b) => {
      if (a.originPreference !== b.originPreference) {
        return a.originPreference - b.originPreference;
      }
      if (a.ownerPreference !== b.ownerPreference) {
        return a.ownerPreference - b.ownerPreference;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.target);
}

function filterPrivateCommandRouteOwnerTargets(params: {
  cfg: HandleCommandsParams["cfg"];
  targets: PrivateCommandRouteTarget[];
}): PrivateCommandRouteTarget[] {
  return params.targets.filter(
    (target) =>
      resolveOwnerPreferenceIndex({
        cfg: params.cfg,
        target,
      }) !== Number.MAX_SAFE_INTEGER,
  );
}

function dedupePrivateCommandRouteTargets(
  targets: PrivateCommandRouteTarget[],
): PrivateCommandRouteTarget[] {
  const seen = new Set<string>();
  const deduped: PrivateCommandRouteTarget[] = [];
  for (const target of targets) {
    const key = [
      target.channel,
      target.to,
      target.accountId ?? "",
      target.threadId == null ? "" : String(target.threadId),
    ].join("\0");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(target);
  }
  return deduped;
}

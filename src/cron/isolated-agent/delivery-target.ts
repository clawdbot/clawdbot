import { parseExplicitTargetForLoadedChannel } from "../../channels/plugins/target-parsing-loaded.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { loadSessionStore } from "../../config/sessions/store-load.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { maybeResolveIdLikeTarget } from "../../infra/outbound/target-id-resolution.js";
import { normalizeTargetForProvider } from "../../infra/outbound/target-normalization.js";
import { tryResolveLoadedOutboundTarget } from "../../infra/outbound/targets-loaded.js";
import { resolveSessionDeliveryTarget } from "../../infra/outbound/targets-session.js";
import type { OutboundChannel } from "../../infra/outbound/targets.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";

export type DeliveryTargetResolution =
  | {
      ok: true;
      channel: Exclude<OutboundChannel, "none">;
      to: string;
      accountId?: string;
      threadId?: string | number;
      mode: "explicit" | "implicit";
    }
  | {
      ok: false;
      channel?: Exclude<OutboundChannel, "none">;
      to?: string;
      accountId?: string;
      threadId?: string | number;
      mode: "explicit" | "implicit";
      error: Error;
    };

const targetsRuntimeLoader = createLazyImportLoader(
  () => import("../../infra/outbound/targets.runtime.js"),
);

async function loadTargetsRuntime() {
  return await targetsRuntimeLoader.load();
}

async function resolveOutboundTargetWithRuntime(
  params: Parameters<typeof tryResolveLoadedOutboundTarget>[0],
) {
  try {
    const loaded = tryResolveLoadedOutboundTarget(params);
    if (loaded) {
      return loaded;
    }
    const { resolveOutboundTarget } = await loadTargetsRuntime();
    return resolveOutboundTarget(params);
  } catch (err) {
    return {
      ok: false as const,
      error: new Error(`Invalid delivery target: ${formatErrorMessage(err)}`),
    };
  }
}

function normalizeTargetForThreadCarry(
  channel: Exclude<OutboundChannel, "none"> | undefined,
  to: string | undefined,
): string | undefined {
  if (!channel || !to) {
    return undefined;
  }
  try {
    const normalized = normalizeTargetForProvider(channel, to);
    const comparable = normalized ?? to.trim();
    if (!comparable) {
      return undefined;
    }
    const parsed = parseExplicitTargetForLoadedChannel(channel, comparable);
    const base = parsed?.to ?? comparable;
    return normalizeTargetForProvider(channel, base) ?? base;
  } catch {
    return undefined;
  }
}

function deliveryTargetsShareThreadRoute(params: {
  channel: Exclude<OutboundChannel, "none"> | undefined;
  to: string | undefined;
  lastTo: string | undefined;
}): boolean {
  if (!params.to || !params.lastTo) {
    return false;
  }
  if (params.to === params.lastTo) {
    return true;
  }
  const normalizedTo = normalizeTargetForThreadCarry(params.channel, params.to);
  const normalizedLastTo = normalizeTargetForThreadCarry(params.channel, params.lastTo);
  return Boolean(normalizedTo && normalizedLastTo && normalizedTo === normalizedLastTo);
}

const channelSelectionRuntimeLoader = createLazyImportLoader(
  () => import("../../infra/outbound/channel-selection.runtime.js"),
);
const deliveryTargetRuntimeLoader = createLazyImportLoader(
  () => import("./delivery-target.runtime.js"),
);

async function loadChannelSelectionRuntime() {
  return await channelSelectionRuntimeLoader.load();
}

async function loadDeliveryTargetRuntime() {
  return await deliveryTargetRuntimeLoader.load();
}
export async function resolveDeliveryTarget(
  cfg: OpenClawConfig,
  agentId: string,
  jobPayload: {
    channel?: ChannelId;
    to?: string;
    threadId?: string | number;
    /** Explicit accountId from job.delivery — overrides session-derived and binding-derived values. */
    accountId?: string;
    sessionKey?: string;
  },
  options?: { dryRun?: boolean },
): Promise<DeliveryTargetResolution> {
  const requestedChannel = typeof jobPayload.channel === "string" ? jobPayload.channel : "last";
  const explicitTo = typeof jobPayload.to === "string" ? jobPayload.to : undefined;
  const allowMismatchedLastTo = requestedChannel === "last";

  const sessionCfg = cfg.session;
  const mainSessionKey = resolveAgentMainSessionKey({ cfg, agentId });
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });
  const store = loadSessionStore(storePath);

  // Look up thread-specific session first (e.g. agent:main:main:thread:1234),
  // then fall back to the main session entry.
  const threadSessionKey = jobPayload.sessionKey?.trim();
  const threadEntry = threadSessionKey ? store[threadSessionKey] : undefined;
  const main = threadEntry ?? store[mainSessionKey];

  const preliminary = resolveSessionDeliveryTarget({
    entry: main,
    requestedChannel,
    explicitTo,
    explicitThreadId: jobPayload.threadId,
    allowMismatchedLastTo,
  });

  let fallbackChannel: Exclude<OutboundChannel, "none"> | undefined;
  let channelResolutionError: Error | undefined;
  if (!preliminary.channel) {
    if (preliminary.lastChannel) {
      fallbackChannel = preliminary.lastChannel;
    } else {
      try {
        const { resolveMessageChannelSelection } = await loadChannelSelectionRuntime();
        const selection = await resolveMessageChannelSelection({ cfg });
        fallbackChannel = selection.channel;
      } catch (err) {
        const detail = formatErrorMessage(err);
        channelResolutionError = new Error(
          `${detail} Set delivery.channel explicitly or use a main session with a previous channel.`,
        );
      }
    }
  }

  const resolved = fallbackChannel
    ? resolveSessionDeliveryTarget({
        entry: main,
        requestedChannel,
        explicitTo,
        explicitThreadId: jobPayload.threadId,
        fallbackChannel,
        allowMismatchedLastTo,
        mode: preliminary.mode,
      })
    : preliminary;

  const channel = resolved.channel ?? fallbackChannel;
  const mode = resolved.mode as "explicit" | "implicit";
  let toCandidate = resolved.to;

  // Prefer an explicit accountId from the job's delivery config (set via
  // --account on cron add/edit). Fall back to the session's lastAccountId,
  // then to the agent's bound account from bindings config.
  const explicitAccountId =
    typeof jobPayload.accountId === "string" && jobPayload.accountId.trim()
      ? jobPayload.accountId.trim()
      : undefined;
  let accountId = explicitAccountId ?? resolved.accountId;
  if (!accountId && channel) {
    const { resolveFirstBoundAccountId } = await loadDeliveryTargetRuntime();
    accountId = resolveFirstBoundAccountId({ cfg, channelId: channel, agentId });
  }

  // job.delivery.accountId takes highest precedence — explicitly set by the job author.
  if (jobPayload.accountId) {
    accountId = jobPayload.accountId;
  }

  // Carry threadId when it was explicitly set (from :topic: parsing or config)
  // or when delivering to the same recipient as the session's last conversation.
  // Session-derived threadIds are dropped when the target differs to prevent
  // stale thread IDs from leaking to a different chat.
  let threadId =
    resolved.threadId &&
    (resolved.threadIdExplicit ||
      deliveryTargetsShareThreadRoute({
        channel,
        to: resolved.to,
        lastTo: resolved.lastTo,
      }))
      ? resolved.threadId
      : undefined;

  if (channel === "telegram" && typeof toCandidate === "string") {
    const topicMatch = toCandidate.match(/:topic:(\d+)$/i);
    if (topicMatch) {
      if (jobPayload.threadId == null || jobPayload.threadId === "") {
        threadId = Number(topicMatch[1]);
      }
      toCandidate = toCandidate.replace(/:topic:\d+$/i, "");
    }
  }

  if (!channel) {
    return {
      ok: false,
      channel: undefined,
      to: undefined,
      accountId,
      threadId,
      mode,
      error:
        channelResolutionError ??
        new Error("Channel is required when delivery.channel=last has no previous channel."),
    };
  }

  let effectiveAllowFrom: string[] | undefined;
  if (mode === "implicit") {
    const { getLoadedChannelPluginForRead, mapAllowFromEntries } =
      await loadDeliveryTargetRuntime();
    const channelPlugin = getLoadedChannelPluginForRead(channel);
    const resolvedAccountId = normalizeAccountId(accountId);
    const configuredAllowFromRaw = channelPlugin?.config.resolveAllowFrom?.({
      cfg,
      accountId: resolvedAccountId,
    });
    const configuredAllowFrom = configuredAllowFromRaw
      ? mapAllowFromEntries(configuredAllowFromRaw)
      : [];
    const allowFromOverride = [...new Set(configuredAllowFrom)];
    effectiveAllowFrom = allowFromOverride;

    if (toCandidate && allowFromOverride.length > 0) {
      const currentTargetResolution = await resolveOutboundTargetWithRuntime({
        channel,
        to: toCandidate,
        cfg,
        accountId,
        mode,
        allowFrom: effectiveAllowFrom,
      });
      if (!currentTargetResolution.ok) {
        toCandidate = allowFromOverride[0];
      }
    }
  }

  const docked = await resolveOutboundTargetWithRuntime({
    channel,
    to: toCandidate,
    cfg,
    accountId,
    mode,
    allowFrom: effectiveAllowFrom,
  });
  if (!docked.ok) {
    return {
      ok: false,
      channel,
      to: undefined,
      accountId,
      threadId,
      mode,
      error: docked.error,
    };
  }
  if (options?.dryRun) {
    return {
      ok: true,
      channel,
      to: docked.to,
      accountId,
      threadId,
      mode,
    };
  }
  const idLikeTarget = await maybeResolveIdLikeTarget({
    cfg,
    channel,
    input: docked.to,
    accountId,
  });
  return {
    ok: true,
    channel,
    to: idLikeTarget?.to ?? docked.to,
    accountId,
    threadId,
    mode,
  };
}

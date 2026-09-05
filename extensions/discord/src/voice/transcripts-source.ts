import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { summarizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
// Discord plugin module implements transcripts source behavior.
import type {
  TranscriptSourceProvider,
  TranscriptOccupancyWatchRequest,
} from "openclaw/plugin-sdk/transcripts";
import { listEnabledDiscordAccounts, resolveDiscordAccount } from "../accounts.js";
import { authorizeDiscordVoiceIngress } from "./access.js";
import { resolveDiscordVoiceEnabled } from "./config.js";
import { resolveDiscordVoiceAccess } from "./owner-access.js";
import type { DiscordVoiceManager } from "./voice-runtime.js";

const managersByAccountId = new Map<string, DiscordVoiceManager>();
const managerWaiters = new Set<{
  accountId?: string;
  resolve: () => void;
}>();

const ACCOUNT_ID_ERROR_MAX_CHARS = 64;
const ACCOUNT_ID_ERROR_MAX_ENTRIES = 4;

function formatAccountIdForError(accountId: string): string {
  return JSON.stringify(truncateUtf16Safe(accountId, ACCOUNT_ID_ERROR_MAX_CHARS));
}

function summarizeAccountIdsForError(accountIds: readonly string[]): string {
  return summarizeStringEntries({
    entries: accountIds.map(formatAccountIdForError),
    limit: ACCOUNT_ID_ERROR_MAX_ENTRIES,
  });
}

export function setDiscordTranscriptsVoiceManager(params: {
  accountId: string;
  manager: DiscordVoiceManager | null;
}): void {
  if (params.manager) {
    managersByAccountId.set(params.accountId, params.manager);
    for (const waiter of managerWaiters) {
      if (!waiter.accountId || waiter.accountId === params.accountId) {
        waiter.resolve();
      }
    }
  } else {
    managersByAccountId.delete(params.accountId);
  }
}

const resolveDiscordTranscriptsAccountId: NonNullable<
  NonNullable<TranscriptSourceProvider["accessControl"]>["resolveAccountId"]
> = ({ cfg, source }) => {
  const requestedAccountId = source.accountId?.trim();
  const configuredVoiceAccounts = cfg
    ? listEnabledDiscordAccounts(cfg).filter((account) =>
        resolveDiscordVoiceEnabled(account.config.voice),
      )
    : [];
  // Configuration owns capability; the manager map is transient readiness state.
  // Falling back to it only supports direct provider calls that have no config.
  const capableAccountIds = (
    cfg
      ? configuredVoiceAccounts
          .filter((account) => account.tokenStatus === "available")
          .map((account) => account.accountId)
      : [...managersByAccountId.keys()]
  ).toSorted();

  if (requestedAccountId) {
    // A provider can be called directly without config while its manager is starting.
    // With config, reject accounts that can never register a voice manager.
    if (!cfg || capableAccountIds.includes(requestedAccountId)) {
      return { ok: true, value: requestedAccountId };
    }
    if (
      resolveDiscordAccount({ cfg, accountId: requestedAccountId }).tokenStatus ===
      "configured_unavailable"
    ) {
      return {
        ok: false,
        error: `Discord account ${formatAccountIdForError(requestedAccountId)} has configured credentials that are unavailable in this runtime; resolve its SecretRef before using this account.`,
      };
    }
    return {
      ok: false,
      error: `Discord account ${formatAccountIdForError(requestedAccountId)} is not enabled for voice.`,
    };
  }
  if (capableAccountIds.length === 1) {
    return { ok: true, value: capableAccountIds[0] };
  }
  if (capableAccountIds.length === 0) {
    return {
      ok: false,
      error:
        "No Discord account has available credentials and voice enabled; configure credentials and enable voice for an account.",
    };
  }
  const configuredDefaultAccountId = cfg?.channels?.discord?.defaultAccount?.trim();
  if (configuredDefaultAccountId) {
    const normalizedDefaultAccountId = normalizeAccountId(configuredDefaultAccountId);
    if (capableAccountIds.includes(normalizedDefaultAccountId)) {
      return { ok: true, value: normalizedDefaultAccountId };
    }
  }
  if (capableAccountIds.includes(DEFAULT_ACCOUNT_ID)) {
    return { ok: true, value: DEFAULT_ACCOUNT_ID };
  }
  return {
    ok: false,
    error: `Multiple Discord accounts are enabled for voice (${summarizeAccountIdsForError(capableAccountIds)}); specify accountId.`,
  };
};

async function waitForManager(
  request: Pick<
    TranscriptOccupancyWatchRequest,
    "cfg" | "source" | "abortSignal" | "startupWaitMs"
  >,
): Promise<{ ok: true; value: DiscordVoiceManager | undefined } | { ok: false; error: string }> {
  const accountResolution = resolveDiscordTranscriptsAccountId({
    cfg: request.cfg,
    source: request.source,
  });
  if (!accountResolution.ok) {
    return accountResolution;
  }
  const accountId = accountResolution.value;
  const existing = accountId ? managersByAccountId.get(accountId) : undefined;
  if (existing) {
    return { ok: true, value: existing };
  }
  if (request.abortSignal?.aborted) {
    return { ok: true, value: undefined };
  }
  const startupWaitMs = request.startupWaitMs ?? 0;
  if (startupWaitMs <= 0) {
    return { ok: true, value: undefined };
  }
  await new Promise<void>((resolve) => {
    const waiter = {
      accountId,
      resolve: () => {
        clearTimeout(timer);
        request.abortSignal?.removeEventListener("abort", waiter.resolve);
        managerWaiters.delete(waiter);
        resolve();
      },
    };
    const timer = setTimeout(waiter.resolve, startupWaitMs);
    timer.unref?.();
    request.abortSignal?.addEventListener("abort", waiter.resolve, { once: true });
    managerWaiters.add(waiter);
  });
  if (request.abortSignal?.aborted) {
    return { ok: true, value: undefined };
  }
  return { ok: true, value: accountId ? managersByAccountId.get(accountId) : undefined };
}

export const discordVoiceTranscriptsSourceProvider: TranscriptSourceProvider = {
  id: "discord-voice",
  aliases: ["discord"],
  accessControl: {
    channelId: "discord",
    resolveAccountId: resolveDiscordTranscriptsAccountId,
    async authorize({ caller, cfg, source }) {
      if (caller.kind === "operator") {
        return { ok: true, value: undefined };
      }
      const guildId = source.guildId?.trim();
      const channelId = source.channelId?.trim();
      const callerAccountId = caller.accountId?.trim();
      const sourceAccountId = source.accountId?.trim();
      if (
        caller.channel !== "discord" ||
        !cfg ||
        !callerAccountId ||
        sourceAccountId !== callerAccountId ||
        !guildId ||
        !channelId ||
        caller.groupSpace !== guildId
      ) {
        return { ok: false, error: "You are not authorized to use this command." };
      }
      const manager = managersByAccountId.get(callerAccountId);
      const target = await manager?.resolveAccessTarget({ guildId, channelId });
      if (!target) {
        return { ok: false, error: "Discord voice access target is unavailable." };
      }
      const account = resolveDiscordAccount({ cfg, accountId: callerAccountId });
      const access = await authorizeDiscordVoiceIngress({
        cfg,
        discordConfig: account.config,
        accountId: account.accountId,
        guild: target.guild,
        guildId,
        channelId,
        ...(target.channelName ? { channelName: target.channelName } : {}),
        channelSlug: target.channelSlug,
        ...(target.parentId ? { parentId: target.parentId } : {}),
        ...(target.parentName ? { parentName: target.parentName } : {}),
        ...(target.parentSlug ? { parentSlug: target.parentSlug } : {}),
        scope: target.scope,
        memberRoleIds: [...caller.roleIds],
        admissionAllowFrom: resolveDiscordVoiceAccess({
          cfg,
          discordConfig: account.config,
          accountId: account.accountId,
        }).admissionAllowFrom,
        sender: { id: caller.senderId },
      });
      return access.ok ? { ok: true, value: undefined } : { ok: false, error: access.message };
    },
  },
  name: "Discord Voice",
  sourceKinds: ["live-audio"],
  async watchOccupancy(request) {
    const managerResolution = await waitForManager(request);
    if (!managerResolution.ok) {
      return managerResolution;
    }
    const manager = managerResolution.value;
    if (!manager) {
      return { ok: false, error: "Discord voice manager is not available." };
    }
    if (request.abortSignal?.aborted) {
      return { ok: false, error: "Discord transcripts occupancy watch aborted." };
    }
    const guildId = request.source.guildId?.trim();
    const channelId = request.source.channelId?.trim();
    if (!guildId || !channelId) {
      return { ok: false, error: "Discord transcripts require guildId and channelId." };
    }
    const unsubscribe = manager.watchChannelOccupancy({ guildId, channelId }, ({ occupied }) => {
      if (occupied) {
        request.onOccupied();
      } else {
        request.onEmpty();
      }
    });
    const stop = () => {
      unsubscribe();
      request.abortSignal?.removeEventListener("abort", stop);
    };
    request.abortSignal?.addEventListener("abort", stop, { once: true });
    if (request.abortSignal?.aborted) {
      stop();
    }
    return { ok: true, value: { stop } };
  },
  async start(request) {
    const managerResolution = await waitForManager({ ...request, source: request.session.source });
    if (!managerResolution.ok) {
      return managerResolution;
    }
    const manager = managerResolution.value;
    if (!manager) {
      return { ok: false, error: "Discord voice manager is not available." };
    }
    if (request.abortSignal?.aborted) {
      return { ok: false, error: "Discord transcripts start aborted." };
    }
    const guildId = request.session.source.guildId?.trim();
    const channelId = request.session.source.channelId?.trim();
    if (!guildId || !channelId) {
      return { ok: false, error: "Discord transcripts require guildId and channelId." };
    }
    const joined = await manager.join(
      { guildId, channelId },
      {
        transcripts: {
          sessionId: request.session.sessionId,
          onUtterance: request.onUtterance,
          onStop: () =>
            request.onStatus?.({
              sessionId: request.session.sessionId,
              active: false,
              source: request.session.source,
            }),
        },
      },
    );
    if (!joined.ok) {
      return { ok: false, error: joined.message };
    }
    const title = joined.channelName?.trim();
    const session =
      !request.session.title && title ? { ...request.session, title } : request.session;
    return { ok: true, session };
  },
  async stop(request) {
    const accountId = request.source.accountId?.trim();
    if (!accountId) {
      return {
        ok: false,
        error: "Discord transcripts require accountId to stop a voice session.",
      };
    }
    const manager = managersByAccountId.get(accountId);
    if (!manager) {
      return { ok: false, error: "Discord voice manager is not available." };
    }
    const guildId = request.source.guildId?.trim();
    if (!guildId) {
      return { ok: false, error: "Discord transcripts require guildId." };
    }
    const result = await manager.leave(
      {
        guildId,
        channelId: request.source.channelId,
      },
      {
        transcriptsSessionId: request.sessionId,
      },
    );
    if (!result.ok) {
      return { ok: false, error: result.message };
    }
    return { ok: true, sessionId: request.sessionId, stoppedAt: new Date().toISOString() };
  },
  async status(source) {
    const accountId = source.accountId?.trim();
    if (!accountId) {
      return [];
    }
    const manager = managersByAccountId.get(accountId);
    return (
      manager?.status().map((entry) => ({
        active: entry.ok,
        message: entry.message,
        source: {
          providerId: "discord-voice",
          accountId,
          guildId: entry.guildId,
          channelId: entry.channelId,
        },
      })) ?? []
    );
  },
};

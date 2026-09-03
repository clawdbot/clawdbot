import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { APIVoiceState, Client } from "../internal/discord.js";
import { formatMention } from "../mentions.js";
import { resolveFetchedDiscordThreadLikeChannelContext } from "../monitor/thread-channel-context.js";
import { resolveDiscordVoiceEnabled } from "./config.js";
import { DiscordVoiceMembershipTracker } from "./membership.js";
import { resolveDiscordVoiceAccess } from "./owner-access.js";
import {
  countDiscordVoiceHumanParticipants,
  listDiscordVoiceParticipantStates,
} from "./participant-context.js";
import {
  logVoiceVerbose,
  type VoiceJoinOptions,
  type VoiceOperationResult,
  type VoiceSessionEntry,
} from "./session.js";
import { DiscordVoiceSpeakerContextResolver } from "./speaker-context.js";
import {
  DiscordVoiceFollowing,
  normalizeVoiceChannelResidencies,
  type VoiceChannelResidency,
} from "./voice-following.js";
import { DiscordVoiceReceive } from "./voice-receive.js";
import { destroyVoiceConnectionSafely, DiscordVoiceSessions } from "./voice-session.js";

const logger = createSubsystemLogger("discord/voice");
const DISCORD_VOICE_FATAL_AUTOJOIN_ERROR_PATTERNS = [
  "api key missing",
  "incorrect api key",
  "invalid api key",
  "unauthorized",
  "authentication",
  "permission denied",
  "forbidden",
];

function isVoiceChannelAllowed(params: {
  allowedChannels: VoiceChannelResidency[] | null;
  guildId: string;
  channelId: string;
}): boolean {
  return (
    params.allowedChannels === null ||
    params.allowedChannels.some(
      (entry) => entry.guildId === params.guildId && entry.channelId === params.channelId,
    )
  );
}

function formatAutoJoinFailureKey(entry: { guildId: string; channelId: string }): string {
  return `${entry.guildId}:${entry.channelId}`;
}

function isFatalAutoJoinFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return DISCORD_VOICE_FATAL_AUTOJOIN_ERROR_PATTERNS.some((pattern) =>
    normalized.includes(pattern),
  );
}

type VoiceGuildLifecycle =
  | { status: "inactive"; generation: number }
  | { status: "starting"; generation: number; instance: { guildId: string; channelId: string } }
  | { status: "active"; generation: number; instance: VoiceSessionEntry }
  | { status: "stopped"; generation: number; reason: string };

export class DiscordVoiceManager {
  private sessions = new Map<string, VoiceSessionEntry>();
  private readonly guildLifecycles = new Map<string, VoiceGuildLifecycle>();
  private nextGuildGeneration = 0;
  private readonly joinTasks = new Map<string, Promise<VoiceOperationResult>>();
  private readonly botUserId?: string;
  private readonly client: Client;
  private readonly voiceEnabled: boolean;
  private readonly autoJoinTasks = new Map<string, Promise<void>>();
  private readonly fatalAutoJoinFailures = new Map<
    string,
    { message: string; skipLogged: boolean }
  >();
  private readonly admissionAllowFrom?: string[];
  private readonly ownerAllowFrom?: string[];
  private readonly speakerContext: DiscordVoiceSpeakerContextResolver;
  private readonly membership: DiscordVoiceMembershipTracker;
  private readonly allowedChannels: VoiceChannelResidency[] | null;
  private readonly autoJoinChannels: VoiceChannelResidency[];
  private readonly following: DiscordVoiceFollowing;
  private readonly receive: DiscordVoiceReceive;
  private readonly voiceSessions: DiscordVoiceSessions;
  // Room watchers outlive individual bot sessions; only unsubscribe/destroy retires them.
  private readonly occupancyWatchers = new Set<{ guildId: string; refresh: () => void }>();
  private destroyed = false;

  constructor(params: {
    client: Client;
    cfg: OpenClawConfig;
    discordConfig: DiscordAccountConfig;
    accountId: string;
    runtime: RuntimeEnv;
    botUserId?: string;
  }) {
    this.client = params.client;
    this.botUserId = params.botUserId;
    this.voiceEnabled = resolveDiscordVoiceEnabled(params.discordConfig.voice);
    const voiceAccess = resolveDiscordVoiceAccess(params);
    this.admissionAllowFrom = voiceAccess.admissionAllowFrom;
    this.ownerAllowFrom = voiceAccess.ownerAllowFrom;
    this.allowedChannels =
      params.discordConfig.voice?.allowedChannels === undefined
        ? null
        : normalizeVoiceChannelResidencies(params.discordConfig.voice.allowedChannels);
    this.autoJoinChannels = normalizeVoiceChannelResidencies(params.discordConfig.voice?.autoJoin);
    this.speakerContext = new DiscordVoiceSpeakerContextResolver({
      client: params.client,
      ownerAllowFrom: this.ownerAllowFrom,
    });
    this.membership = new DiscordVoiceMembershipTracker(
      params.client,
      this.speakerContext,
      params.accountId,
    );
    this.receive = new DiscordVoiceReceive({
      accountId: params.accountId,
      admissionAllowFrom: this.admissionAllowFrom,
      botUserId: () => this.botUserId,
      cfg: params.cfg,
      client: params.client,
      discordConfig: params.discordConfig,
      getSession: (guildId) => this.sessions.get(guildId),
      isEntryCurrent: (entry) => this.isEntryCurrent(entry),
      isFollowOwnedGuild: (guildId) => this.following.isFollowOwnedGuild(guildId),
      join: (entry, options) => this.join(entry, options),
      leave: (entry, options) => this.leave(entry, options),
      membership: this.membership,
      runtime: params.runtime,
      speakerContext: this.speakerContext,
    });
    this.following = new DiscordVoiceFollowing({
      accountId: params.accountId,
      allowedChannels: this.allowedChannels,
      autoJoinChannels: this.autoJoinChannels,
      botUserId: () => this.botUserId,
      client: params.client,
      deleteRecoveryAttempt: (guildId) => this.receive.deleteRecoveryAttempt(guildId),
      destroyed: () => this.destroyed,
      destroyVoiceConnection: destroyVoiceConnectionSafely,
      discordConfig: params.discordConfig,
      getRecoveryAttempt: (guildId) => this.receive.getRecoveryAttempt(guildId),
      getSession: (guildId) => this.sessions.get(guildId),
      hasVoiceLifecycle: (guildId) => {
        const lifecycle = this.guildLifecycles.get(guildId);
        return lifecycle?.status === "starting" || lifecycle?.status === "active";
      },
      isAllowedVoiceChannel: (entry) => this.isAllowedVoiceChannel(entry),
      join: (entry, options) => this.join(entry, options),
      leave: (entry, options) => this.leave(entry, options),
      listSessions: () => this.sessions.values(),
      voiceEnabled: this.voiceEnabled,
    });
    this.voiceSessions = new DiscordVoiceSessions({
      accountId: params.accountId,
      botUserId: () => this.botUserId,
      cfg: params.cfg,
      client: params.client,
      destroyed: () => this.destroyed,
      discordConfig: params.discordConfig,
      membership: this.membership,
      onLeaveFollowState: (guildId) => {
        this.following.followedVoiceGuilds.delete(guildId);
        this.following.deleteFollowedUserChannelsForGuild(guildId);
      },
      onSessionStopped: (entry, reason) => {
        const lifecycle = this.guildLifecycles.get(entry.guildId);
        if (lifecycle?.status === "active" && lifecycle.instance === entry) {
          this.guildLifecycles.set(entry.guildId, {
            status: "stopped",
            generation: lifecycle.generation,
            reason,
          });
        }
      },
      receive: this.receive,
      sessions: this.sessions,
    });
  }

  refreshGuildRoster(guildId: string): void {
    this.voiceSessions.refreshGuildRoster(guildId);
  }

  watchChannelOccupancy(
    params: { guildId: string; channelId: string },
    listener: (state: { occupied: boolean }) => void,
  ): () => void {
    if (this.destroyed) {
      return () => undefined;
    }
    const guildId = params.guildId.trim();
    const channelId = params.channelId.trim();
    let wasOccupied = false;
    const watcher = {
      guildId,
      refresh: () => {
        const states = listDiscordVoiceParticipantStates({
          client: this.client,
          guildId,
          channelId,
        });
        if (states === null) {
          return;
        }
        const occupied =
          countDiscordVoiceHumanParticipants({ states, botUserId: this.botUserId }) > 0;
        if (occupied !== wasOccupied) {
          wasOccupied = occupied;
          listener({ occupied });
        }
      },
    };
    this.occupancyWatchers.add(watcher);
    watcher.refresh();
    return () => {
      this.occupancyWatchers.delete(watcher);
    };
  }

  private reconcileChannelOccupancy(guildId?: string): void {
    for (const watcher of this.occupancyWatchers) {
      if (!guildId || watcher.guildId === guildId) {
        watcher.refresh();
      }
    }
  }

  async autoJoin(): Promise<void> {
    if (!this.voiceEnabled || this.destroyed) {
      return;
    }
    this.reconcileChannelOccupancy();
    const entriesByGuild = new Map<string, VoiceChannelResidency>();
    const duplicateGuilds = new Set<string>();
    for (const entry of this.autoJoinChannels) {
      if (entriesByGuild.has(entry.guildId)) {
        duplicateGuilds.add(entry.guildId);
      }
      entriesByGuild.set(entry.guildId, entry);
    }

    logVoiceVerbose(
      `autoJoin: ${this.autoJoinChannels.length} entries, ${entriesByGuild.size} guilds`,
    );
    for (const guildId of duplicateGuilds) {
      const selected = entriesByGuild.get(guildId);
      if (selected) {
        logger.warn(
          `discord voice: autoJoin has multiple entries for guild ${guildId}; using channel ${selected.channelId}`,
        );
      }
    }

    for (const entry of entriesByGuild.values()) {
      await this.enqueueAutoJoin(entry);
    }
    await this.following.startReconciliation();
  }

  async reconcileAutoJoinGuild(guildId: string): Promise<void> {
    this.reconcileChannelOccupancy(guildId);
    const entry = this.resolveAutoJoinTarget(guildId);
    if (!entry?.whenOccupied || !this.voiceEnabled || this.destroyed) {
      return;
    }
    await this.enqueueAutoJoin(entry);
  }

  status(): VoiceOperationResult[] {
    return Array.from(this.guildLifecycles.values())
      .filter(
        (lifecycle): lifecycle is Extract<VoiceGuildLifecycle, { status: "active" }> =>
          lifecycle.status === "active",
      )
      .map(({ instance: session }) => ({
        ok: true,
        message: `connected: guild ${session.guildId} channel ${session.channelId}`,
        guildId: session.guildId,
        channelId: session.channelId,
      }));
  }

  isAllowedVoiceChannel(params: { guildId: string; channelId: string }): boolean {
    return isVoiceChannelAllowed({
      allowedChannels: this.allowedChannels,
      guildId: params.guildId.trim(),
      channelId: params.channelId.trim(),
    });
  }

  async resolveAccessTarget(params: { guildId: string; channelId: string }) {
    const [guild, channel] = await Promise.all([
      this.client.fetchGuild(params.guildId).catch(() => null),
      this.client.fetchChannel(params.channelId).catch(() => null),
    ]);
    if (!guild || !channel) {
      return undefined;
    }
    const context = await resolveFetchedDiscordThreadLikeChannelContext({
      client: this.client,
      channel,
      channelIdFallback: params.channelId,
    });
    return {
      guild,
      ...(context.channelName ? { channelName: context.channelName } : {}),
      channelSlug: context.channelSlug,
      ...(context.parentId ? { parentId: context.parentId } : {}),
      ...(context.threadParentName ? { parentName: context.threadParentName } : {}),
      ...(context.threadParentSlug ? { parentSlug: context.threadParentSlug } : {}),
      scope: context.isThreadChannel ? ("thread" as const) : ("channel" as const),
    };
  }

  async join(
    params: { guildId: string; channelId: string },
    options?: VoiceJoinOptions,
  ): Promise<VoiceOperationResult> {
    if (this.destroyed) {
      return { ok: false, message: "Discord voice manager is stopped." };
    }
    if (!this.voiceEnabled) {
      return {
        ok: false,
        message: "Discord voice is disabled (channels.discord.voice.enabled).",
      };
    }
    const guildId = params.guildId.trim();
    const channelId = params.channelId.trim();
    if (!guildId || !channelId) {
      return { ok: false, message: "Missing guildId or channelId." };
    }
    if (!this.isAllowedVoiceChannel({ guildId, channelId })) {
      logger.warn(
        `discord voice: join rejected for non-allowed channel guild=${guildId} channel=${channelId}`,
      );
      return {
        ok: false,
        message: `${formatMention({ channelId })} is not allowed by channels.discord.voice.allowedChannels.`,
        guildId,
        channelId,
      };
    }
    logVoiceVerbose(`join requested: guild ${guildId} channel ${channelId}`);

    while (true) {
      const activeJoinTask = this.joinTasks.get(guildId);
      if (!activeJoinTask) {
        break;
      }
      logVoiceVerbose(`join: waiting for active guild join guild ${guildId} channel ${channelId}`);
      await activeJoinTask.catch(() => undefined);
      if (this.destroyed) {
        return { ok: false, message: "Discord voice manager is stopped.", guildId, channelId };
      }
    }

    const generation = ++this.nextGuildGeneration;
    const starting: VoiceGuildLifecycle = {
      status: "starting",
      generation,
      instance: { guildId, channelId },
    };
    this.guildLifecycles.set(guildId, starting);
    const isCurrent = () => {
      const lifecycle = this.guildLifecycles.get(guildId);
      return lifecycle?.status === "starting" && lifecycle.generation === generation;
    };
    const joinTask = this.voiceSessions.joinUnlocked({ guildId, channelId }, options, {
      generation,
      isCurrent,
    });
    this.joinTasks.set(guildId, joinTask);
    try {
      const result = await joinTask;
      if (result.ok && isCurrent()) {
        const entry = this.sessions.get(guildId);
        if (!entry) {
          this.guildLifecycles.set(guildId, {
            status: "stopped",
            generation,
            reason: "join completed without a session",
          });
          return { ...result, ok: false, message: "Discord voice join was cancelled." };
        }
        this.guildLifecycles.set(guildId, { status: "active", generation, instance: entry });
        this.fatalAutoJoinFailures.delete(formatAutoJoinFailureKey({ guildId, channelId }));
        return { ...result, ...(entry.channelName ? { channelName: entry.channelName } : {}) };
      } else if (!result.ok && isCurrent()) {
        this.guildLifecycles.set(guildId, { status: "inactive", generation });
      }
      return result;
    } finally {
      if (this.joinTasks.get(guildId) === joinTask) {
        this.joinTasks.delete(guildId);
      }
    }
  }

  async leave(
    params: { guildId: string; channelId?: string },
    options?: { preserveFollowState?: boolean; transcriptsSessionId?: string },
  ): Promise<VoiceOperationResult> {
    const guildId = params.guildId.trim();
    const lifecycle = this.guildLifecycles.get(guildId);
    if (lifecycle?.status === "starting") {
      if (options?.transcriptsSessionId && this.sessions.has(guildId)) {
        return await this.voiceSessions.leave(params, options);
      }
      this.guildLifecycles.set(guildId, {
        status: "stopped",
        generation: lifecycle.generation,
        reason: "leave requested during join",
      });
      if (this.sessions.has(guildId)) {
        return await this.voiceSessions.leave(params, options);
      }
      if (!options?.preserveFollowState) {
        this.following.followedVoiceGuilds.delete(guildId);
        this.following.deleteFollowedUserChannelsForGuild(guildId);
      }
      return {
        ok: true,
        message: `Cancelled pending voice join${params.channelId ? ` for ${formatMention({ channelId: params.channelId })}` : ""}.`,
        guildId,
        channelId: params.channelId,
      };
    }
    const result = await this.voiceSessions.leave(params, options);
    if (result.ok) {
      const activeEntry = this.sessions.get(guildId);
      if (options?.transcriptsSessionId && activeEntry) {
        this.guildLifecycles.set(guildId, {
          status: "active",
          generation: activeEntry.generation,
          instance: activeEntry,
        });
        return result;
      }
      const currentLifecycle = this.guildLifecycles.get(guildId);
      if (lifecycle && currentLifecycle && currentLifecycle.generation !== lifecycle.generation) {
        return result;
      }
      const generation = lifecycle?.generation ?? ++this.nextGuildGeneration;
      this.guildLifecycles.set(guildId, {
        status: "stopped",
        generation,
        reason: "leave completed",
      });
    }
    return result;
  }

  async handleVoiceStateUpdate(
    data: APIVoiceState,
    previousVoiceState?: APIVoiceState | null,
  ): Promise<void> {
    const guildId = data.guild_id?.trim();
    const userId = data.user_id?.trim();
    const channelId = data.channel_id?.trim();
    if (!guildId || !userId) {
      return;
    }
    if (this.botUserId && userId === this.botUserId) {
      await this.following.handleBotVoiceStateUpdate({ guildId, channelId });
      await this.reconcileAutoJoinGuild(guildId);
      return;
    }
    this.membership.track(this.sessions.get(guildId), data, previousVoiceState);
    this.reconcileChannelOccupancy(guildId);
    if (this.following.isFollowedUser(userId)) {
      await this.following.handleFollowedUserVoiceStateUpdate({ guildId, channelId, userId });
    }
    const autoJoinTarget = this.resolveAutoJoinTarget(guildId);
    if (autoJoinTarget?.whenOccupied) {
      await this.enqueueAutoJoin(autoJoinTarget);
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.occupancyWatchers.clear();
    this.following.destroy();
    for (const entry of this.sessions.values()) {
      entry.stop();
    }
    for (const [guildId, lifecycle] of this.guildLifecycles) {
      this.guildLifecycles.set(guildId, {
        status: "stopped",
        generation: lifecycle.generation,
        reason: "manager destroyed",
      });
    }
    this.sessions.clear();
    this.receive.clearRecoveryAttempts();
  }

  private isEntryCurrent(entry: VoiceSessionEntry): boolean {
    const lifecycle = this.guildLifecycles.get(entry.guildId);
    return (
      lifecycle?.status === "active" &&
      lifecycle.generation === entry.generation &&
      lifecycle.instance === entry &&
      entry.sessionLifecycle.status === "active"
    );
  }

  private resolveAutoJoinTarget(guildId: string): VoiceChannelResidency | undefined {
    return this.autoJoinChannels.toReversed().find((entry) => entry.guildId === guildId.trim());
  }

  private enqueueAutoJoin(entry: VoiceChannelResidency): Promise<void> {
    const previous = this.autoJoinTasks.get(entry.guildId) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(async () => await this.reconcileAutoJoinEntry(entry))
      .finally(() => {
        if (this.autoJoinTasks.get(entry.guildId) === task) {
          this.autoJoinTasks.delete(entry.guildId);
        }
      });
    this.autoJoinTasks.set(entry.guildId, task);
    return task;
  }

  private async reconcileAutoJoinEntry(entry: VoiceChannelResidency): Promise<void> {
    if (this.destroyed) {
      return;
    }
    const failureKey = formatAutoJoinFailureKey(entry);
    const fatalFailure = this.fatalAutoJoinFailures.get(failureKey);
    if (fatalFailure) {
      if (!fatalFailure.skipLogged) {
        logger.warn(
          `discord voice: autoJoin suppressed guild=${entry.guildId} channel=${entry.channelId} after fatal startup failure; retry with /vc join or reload config after fixing credentials: ${fatalFailure.message}`,
        );
        fatalFailure.skipLogged = true;
      }
      return;
    }

    if (entry.whenOccupied) {
      const states = listDiscordVoiceParticipantStates({
        client: this.client,
        guildId: entry.guildId,
        channelId: entry.channelId,
      });
      if (states === null) {
        logVoiceVerbose(
          `autoJoin waiting for guild voice snapshot guild=${entry.guildId} channel=${entry.channelId}`,
        );
        return;
      }
      const humanCount = countDiscordVoiceHumanParticipants({
        states,
        botUserId: this.botUserId,
      });
      const existing = this.sessions.get(entry.guildId);
      if (humanCount === 0) {
        if (!existing?.autoJoinWhenOccupied || existing.channelId !== entry.channelId) {
          return;
        }
        logger.info(
          `discord voice: occupied autoJoin leaving empty channel guild=${entry.guildId} channel=${entry.channelId}`,
        );
        const result = await this.leave({ guildId: entry.guildId, channelId: entry.channelId });
        if (!result.ok) {
          logger.warn(
            `discord voice: occupied autoJoin failed to leave guild=${entry.guildId} channel=${entry.channelId}: ${result.message}`,
          );
        }
        return;
      }
      const lifecycle = this.guildLifecycles.get(entry.guildId);
      if (existing || lifecycle?.status === "starting" || lifecycle?.status === "active") {
        return;
      }
      logger.info(
        `discord voice: occupied autoJoin joining guild=${entry.guildId} channel=${entry.channelId} humans=${humanCount}`,
      );
    } else {
      logVoiceVerbose(`autoJoin: joining guild ${entry.guildId} channel ${entry.channelId}`);
    }

    const result = await this.join(entry, { autoJoinWhenOccupied: entry.whenOccupied === true });
    if (!result.ok) {
      logger.warn(
        `discord voice: autoJoin skipped guild=${entry.guildId} channel=${entry.channelId}: ${result.message}`,
      );
      if (isFatalAutoJoinFailure(result.message)) {
        this.fatalAutoJoinFailures.set(failureKey, {
          message: result.message,
          skipLogged: false,
        });
      }
    }
  }
}

export {
  DiscordVoiceGuildCreateListener,
  DiscordVoiceReadyListener,
  DiscordVoiceResumedListener,
  DiscordVoiceStateUpdateListener,
} from "./listeners.js";

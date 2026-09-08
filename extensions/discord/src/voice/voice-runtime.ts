import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createSubsystemLogger, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { APIVoiceState, Client } from "../internal/discord.js";
import { formatMention } from "../mentions.js";
import { resolveDiscordVoiceEnabled } from "./config.js";
import { DiscordVoiceMembershipTracker } from "./membership.js";
import { resolveDiscordVoiceAccess, resolveDiscordVoiceAccessTarget } from "./owner-access.js";
import {
  countDiscordVoiceHumanParticipants,
  createDiscordVoiceOccupancyWatcher,
  listDiscordVoiceParticipantStates,
} from "./participant-context.js";
import {
  logVoiceVerbose,
  type VoiceJoinOptions,
  type VoiceOperationResult,
  type VoiceSessionEntry,
} from "./session.js";
import { DiscordVoiceSpeakerContextResolver } from "./speaker-context.js";
import { resolveDiscordTranscriptsCapture } from "./transcripts-source.js";
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
  | {
      status: "starting";
      generation: number;
      cancelled: boolean;
      instance: { guildId: string; channelId: string; captureOnly: boolean };
    }
  | { status: "active"; generation: number; instance: VoiceSessionEntry }
  | { status: "stopped"; generation: number; reason: string };

type CaptureJoinOrigin = {
  isCurrent: () => boolean;
  isResidencyUnchanged: () => boolean;
};

export class DiscordVoiceManager {
  private sessions = new Map<string, VoiceSessionEntry>();
  private readonly guildLifecycles = new Map<string, VoiceGuildLifecycle>();
  private nextGuildGeneration = 0;
  private readonly joinTasks = new Map<string, Promise<VoiceOperationResult>>();
  private readonly botUserId?: string;
  private readonly client: Client;
  private readonly voiceEnabled: boolean;
  private readonly autoJoinTasks = new Map<string, Promise<VoiceOperationResult | undefined>>();
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
  private readonly getTranscripts: (target: {
    guildId: string;
    channelId: string;
  }) => ReturnType<typeof resolveDiscordTranscriptsCapture>;
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
    this.getTranscripts = ({ guildId, channelId }) =>
      this.destroyed
        ? undefined
        : resolveDiscordTranscriptsCapture(
            { guildId, channelId, accountId: params.accountId },
            this,
          );
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
      deleteRecoveryAttempt: (guildId) => this.receive.daveRecoveryAttempts.delete(guildId),
      destroyed: () => this.destroyed,
      destroyVoiceConnection: destroyVoiceConnectionSafely,
      discordConfig: params.discordConfig,
      getRecoveryAttempt: (guildId) => this.receive.daveRecoveryAttempts.get(guildId),
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
      getTranscripts: this.getTranscripts,
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
    const watcher = createDiscordVoiceOccupancyWatcher(
      { ...params, client: this.client, botUserId: this.botUserId },
      listener,
    );
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
      .filter((lifecycle) => lifecycle.status === "active")
      .map(({ instance: session }) => ({
        ok: true,
        message: `connected: guild ${session.guildId} channel ${session.channelId}`,
        warning: session.transcripts?.warning,
        guildId: session.guildId,
        channelId: session.channelId,
      }));
  }

  isAllowedVoiceChannel(params: { guildId: string; channelId: string }): boolean {
    const guildId = params.guildId.trim();
    const channelId = params.channelId.trim();
    return (
      this.allowedChannels === null ||
      this.allowedChannels.some(
        (entry) => entry.guildId === guildId && entry.channelId === channelId,
      )
    );
  }

  async resolveAccessTarget(params: { guildId: string; channelId: string }) {
    return await resolveDiscordVoiceAccessTarget({ ...params, client: this.client });
  }

  hasRealtimeCapture(target: { guildId: string; channelId: string }): boolean {
    const entry = this.sessions.get(target.guildId);
    return (
      entry?.channelId === target.channelId &&
      this.isEntryCurrent(entry) &&
      entry.realtimeLifecycle.status === "active"
    );
  }

  startTranscriptsCapture(target: { guildId: string; channelId: string }) {
    return this.join(target, { captureOnly: true });
  }

  async stopTranscriptsCapture(target: { guildId: string; channelId: string }): Promise<void> {
    const lifecycle = this.guildLifecycles.get(target.guildId);
    if (lifecycle?.status !== "starting" && lifecycle?.status !== "active") {
      return;
    }
    if (lifecycle.instance.channelId === target.channelId && lifecycle.instance.captureOnly) {
      await this.leave(target, { captureRetirement: true });
    }
  }

  join(
    params: { guildId: string; channelId: string },
    options?: VoiceJoinOptions,
  ): Promise<VoiceOperationResult> {
    const target = { guildId: params.guildId.trim(), channelId: params.channelId.trim() };
    const capture = options?.captureOnly ? this.getTranscripts(target) : undefined;
    const residency = this.guildLifecycles.get(target.guildId);
    // Configured conversation handoffs retain this source subscription and residency,
    // rather than borrowing a fresh subscription or a newer join's transport ownership.
    return this.joinOwned(
      params,
      options,
      options?.captureOnly
        ? {
            isCurrent: () =>
              capture !== undefined &&
              // A recording handoff retains pending transport work for this admitted source.
              this.getTranscripts(target)?.subscriptionToken === capture.subscriptionToken &&
              (capture.started || residency?.status !== "starting" || !residency.cancelled),
            isResidencyUnchanged: () => this.guildLifecycles.get(target.guildId) === residency,
          }
        : undefined,
    );
  }

  private async joinOwned(
    params: { guildId: string; channelId: string },
    options?: VoiceJoinOptions,
    captureOrigin?: CaptureJoinOrigin,
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
    const captureIsCurrent = () => captureOrigin?.isCurrent() ?? true;
    let deferredTargetValidated = false;
    while (true) {
      const activeJoinTask = this.joinTasks.get(guildId);
      if (activeJoinTask) {
        logVoiceVerbose(
          `join: waiting for active guild join guild ${guildId} channel ${channelId}`,
        );
        await activeJoinTask.catch(() => undefined);
        continue;
      }
      if (this.destroyed) {
        return { ok: false, message: "Discord voice manager is stopped.", guildId, channelId };
      }
      // A queued recovery must not invalidate the manual join it just waited behind.
      if (!captureIsCurrent()) {
        return { ok: false, message: "Discord voice join was cancelled.", guildId, channelId };
      }
      if (options?.captureOnly && !deferredTargetValidated) {
        const entry = this.sessions.get(guildId);
        const liveTarget = entry?.channelId === channelId && this.isEntryCurrent(entry);
        if (!liveTarget && (entry || this.resolveAutoJoinTarget(guildId))) {
          const resolved = await this.voiceSessions.resolveChannel({ guildId, channelId });
          if (this.destroyed || !captureIsCurrent()) {
            return { ok: false, message: "Discord voice join was cancelled.", guildId, channelId };
          }
          if (!resolved.ok) {
            return resolved.error;
          }
          // Validation claims no residency. Reread joins and entries after the lookup;
          // never scan an old entry or displace a newer transport with this capture.
          deferredTargetValidated = true;
          continue;
        }
      }
      break;
    }
    if (captureOrigin) {
      const entry = this.sessions.get(guildId);
      const autoJoin = this.resolveAutoJoinTarget(guildId);
      // Recheck after queued joins, before claiming a generation: a valid capture
      // never displaces existing or configured residency, including during recovery.
      // A transport left during validation does not turn a dormant start into a join.
      if (
        entry ||
        (autoJoin && (autoJoin.channelId !== channelId || !captureOrigin.isResidencyUnchanged())) ||
        (deferredTargetValidated && !autoJoin)
      ) {
        if (entry?.channelId === channelId) {
          this.receive.captureCurrentSpeakers(entry);
        }
        return {
          ok: true,
          message: "Capture registered for the selected voice channel.",
          guildId,
          channelId,
          ...(entry?.channelId === channelId && entry.channelName
            ? { channelName: entry.channelName }
            : {}),
        };
      }
      if (options?.captureOnly && autoJoin?.channelId === channelId) {
        return (
          (await this.enqueueAutoJoin(autoJoin, captureOrigin)) ?? {
            ok: true,
            message: "Capture waiting for the configured voice channel.",
            guildId,
            channelId,
          }
        );
      }
    }
    const waitingForOccupancy = () => {
      if (!options?.autoJoinWhenOccupied) {
        return false;
      }
      const count = this.countHumanParticipants({ guildId, channelId });
      return count === null || count === 0;
    };
    const waitingResult = {
      ok: true,
      message: "Waiting for an occupied voice channel.",
      guildId,
      channelId,
    };
    if (waitingForOccupancy()) {
      return waitingResult;
    }
    const generation = ++this.nextGuildGeneration;
    const starting: VoiceGuildLifecycle = {
      status: "starting",
      generation,
      cancelled: false,
      instance: { guildId, channelId, captureOnly: options?.captureOnly === true },
    };
    this.guildLifecycles.set(guildId, starting);
    const isCurrent = () => {
      const lifecycle = this.guildLifecycles.get(guildId);
      return (
        lifecycle?.status === "starting" &&
        lifecycle.generation === generation &&
        captureIsCurrent()
      );
    };
    const joinTask = this.voiceSessions.joinUnlocked({ guildId, channelId }, options, {
      generation,
      isCurrent,
    });
    this.joinTasks.set(guildId, joinTask);
    try {
      const result = await joinTask;
      const entry = this.sessions.get(guildId);
      if (
        !entry ||
        entry.generation !== generation ||
        !isCurrent() ||
        (!result.ok && entry.captureOnly && !entry.transcripts)
      ) {
        // Stop only this attempt's transport; cancellation or failed promotion can leave no owner.
        if (entry?.generation === generation) {
          entry.stop("voice join ended without an owner");
        }
        if (this.guildLifecycles.get(guildId) === starting) {
          this.guildLifecycles.set(guildId, { status: "inactive", generation });
        }
        return result.ok
          ? { ...result, ok: false, message: "Discord voice join was cancelled." }
          : result;
      }
      // Starting owns a pending normal join. Commit residency only on success; a failed
      // promotion keeps the previous owner active so capture, stop, and occupancy still work.
      if (result.ok && !options?.captureOnly) {
        entry.captureOnly = false;
        entry.autoJoinWhenOccupied = options?.autoJoinWhenOccupied === true;
      }
      this.guildLifecycles.set(guildId, { status: "active", generation, instance: entry });
      if (result.ok) {
        this.fatalAutoJoinFailures.delete(formatAutoJoinFailureKey({ guildId, channelId }));
        // Recovery can finish after the last human leaves. Keep capture registered, not presence.
        if (waitingForOccupancy()) {
          await this.leave({ guildId, channelId });
          return waitingResult;
        }
        // Speech can begin before readiness installs listeners; continuous packets emit no new start.
        if (entry.transcripts) {
          this.receive.captureCurrentSpeakers(entry);
        }
        return { ...result, ...(entry.channelName ? { channelName: entry.channelName } : {}) };
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
    options?: { preserveFollowState?: boolean; captureRetirement?: true },
  ): Promise<VoiceOperationResult> {
    const guildId = params.guildId.trim();
    const lifecycle = this.guildLifecycles.get(guildId);
    if (lifecycle?.status === "starting") {
      // Queued initial captures retain this join owner after cleanup. Explicit
      // leave cancels that intent; retiring another capture does not cancel it.
      lifecycle.cancelled = !options?.captureRetirement;
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
    this.receive.daveRecoveryAttempts.clear();
  }

  private isEntryCurrent(entry: VoiceSessionEntry): boolean {
    const lifecycle = this.guildLifecycles.get(entry.guildId);
    if (
      !lifecycle ||
      lifecycle.generation !== entry.generation ||
      entry.sessionLifecycle.status !== "active"
    ) {
      return false;
    }
    // Conversation promotion must not pause an already-ready recorder. A starting
    // generation may receive only through its exact existing same-channel transport.
    return lifecycle.status === "active"
      ? lifecycle.instance === entry
      : lifecycle.status === "starting" &&
          lifecycle.instance.channelId === entry.channelId &&
          this.sessions.get(entry.guildId) === entry;
  }

  private resolveAutoJoinTarget(guildId: string): VoiceChannelResidency | undefined {
    return this.autoJoinChannels.toReversed().find((entry) => entry.guildId === guildId.trim());
  }

  private countHumanParticipants(target: { guildId: string; channelId: string }): number | null {
    const states = listDiscordVoiceParticipantStates({ client: this.client, ...target });
    return states === null
      ? null
      : countDiscordVoiceHumanParticipants({ states, botUserId: this.botUserId });
  }

  private enqueueAutoJoin(
    entry: VoiceChannelResidency,
    captureOrigin?: CaptureJoinOrigin,
  ): Promise<VoiceOperationResult | undefined> {
    const previous = this.autoJoinTasks.get(entry.guildId) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(async () => await this.reconcileAutoJoinEntry(entry, captureOrigin))
      .finally(() => {
        if (this.autoJoinTasks.get(entry.guildId) === task) {
          this.autoJoinTasks.delete(entry.guildId);
        }
      });
    this.autoJoinTasks.set(entry.guildId, task);
    return task;
  }

  private async reconcileAutoJoinEntry(
    entry: VoiceChannelResidency,
    captureOrigin?: CaptureJoinOrigin,
  ): Promise<VoiceOperationResult | undefined> {
    if (this.destroyed) {
      return { ok: false, message: "Discord voice manager is stopped." };
    }
    if (captureOrigin && !captureOrigin.isCurrent()) {
      return { ok: false, message: "Discord voice join was cancelled." };
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
      return { ok: false, message: fatalFailure.message };
    }

    // Capture-triggered work keeps its original source/residency guards through
    // joinOwned. Ordinary reconciliation alone owns leaving an empty channel.
    if (entry.whenOccupied && !captureOrigin) {
      const humanCount = this.countHumanParticipants(entry);
      if (humanCount === null) {
        logVoiceVerbose(
          `autoJoin waiting for guild voice snapshot guild=${entry.guildId} channel=${entry.channelId}`,
        );
        return undefined;
      }
      const existing = this.sessions.get(entry.guildId);
      if (humanCount === 0) {
        if (!existing?.autoJoinWhenOccupied || existing.channelId !== entry.channelId) {
          return undefined;
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
        return undefined;
      }
      const lifecycle = this.guildLifecycles.get(entry.guildId);
      if (existing || lifecycle?.status === "starting" || lifecycle?.status === "active") {
        return undefined;
      }
      logger.info(
        `discord voice: occupied autoJoin joining guild=${entry.guildId} channel=${entry.channelId} humans=${humanCount}`,
      );
    } else {
      logVoiceVerbose(`autoJoin: joining guild ${entry.guildId} channel ${entry.channelId}`);
    }

    const result = await this.joinOwned(
      entry,
      { autoJoinWhenOccupied: entry.whenOccupied === true },
      captureOrigin,
    );
    // A retired capture's late provider failure must not suppress ordinary autoJoin.
    if (captureOrigin && !captureOrigin.isCurrent()) {
      return { ok: false, message: "Discord voice join was cancelled." };
    }
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
    return result;
  }
}

export {
  DiscordVoiceGuildCreateListener,
  DiscordVoiceReadyListener,
  DiscordVoiceResumedListener,
  DiscordVoiceStateUpdateListener,
} from "./listeners.js";

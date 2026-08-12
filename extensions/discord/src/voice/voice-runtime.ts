import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import type { APIVoiceState, Client } from "../internal/discord.js";
import { formatMention } from "../mentions.js";
import { resolveDiscordVoiceEnabled } from "./config.js";
import { DiscordVoiceMembershipTracker } from "./membership.js";
import { resolveDiscordVoiceAccess } from "./owner-access.js";
import { logVoiceVerbose, type VoiceOperationResult, type VoiceSessionEntry } from "./session.js";
import { DiscordVoiceSpeakerContextResolver } from "./speaker-context.js";
import {
  DiscordVoiceFollowing,
  normalizeVoiceChannelResidencies,
  type VoiceChannelResidency,
} from "./voice-following.js";
import { DiscordVoiceReceive } from "./voice-receive.js";
import {
  destroyVoiceConnectionSafely,
  DiscordVoiceSessions,
  type VoiceJoinOptions,
} from "./voice-session.js";

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

export class DiscordVoiceManager {
  private sessions = new Map<string, VoiceSessionEntry>();
  private readonly joinTasks = new Map<string, Promise<VoiceOperationResult>>();
  private botUserId?: string;
  private readonly voiceEnabled: boolean;
  private autoJoinTask: Promise<void> | null = null;
  private readonly fatalAutoJoinFailures = new Map<
    string,
    { message: string; skipLogged: boolean }
  >();
  private readonly admissionAllowFrom?: string[];
  private readonly ownerAllowFrom?: string[];
  private readonly speakerContext: DiscordVoiceSpeakerContextResolver;
  private readonly membership: DiscordVoiceMembershipTracker;
  private readonly allowedChannels: VoiceChannelResidency[] | null;
  private readonly following: DiscordVoiceFollowing;
  private readonly receive: DiscordVoiceReceive;
  private readonly voiceSessions: DiscordVoiceSessions;
  private readonly daveRecoveryAttempts: Map<string, number>;
  private readonly followedUserChannels: Map<string, VoiceChannelResidency>;
  private readonly followedVoiceGuilds: Set<string>;
  private destroyed = false;

  constructor(
    private params: {
      client: Client;
      cfg: OpenClawConfig;
      discordConfig: DiscordAccountConfig;
      accountId: string;
      runtime: RuntimeEnv;
      botUserId?: string;
    },
  ) {
    this.botUserId = params.botUserId;
    this.voiceEnabled = resolveDiscordVoiceEnabled(params.discordConfig.voice);
    const voiceAccess = resolveDiscordVoiceAccess(params);
    this.admissionAllowFrom = voiceAccess.admissionAllowFrom;
    this.ownerAllowFrom = voiceAccess.ownerAllowFrom;
    this.allowedChannels =
      params.discordConfig.voice?.allowedChannels === undefined
        ? null
        : normalizeVoiceChannelResidencies(params.discordConfig.voice.allowedChannels);
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
      admissionAllowFrom: this.admissionAllowFrom,
      botUserId: () => this.botUserId,
      cfg: params.cfg,
      client: params.client,
      discordConfig: params.discordConfig,
      getSession: (guildId) => this.sessions.get(guildId),
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
      botUserId: () => this.botUserId,
      client: params.client,
      deleteRecoveryAttempt: (guildId) => this.receive.deleteRecoveryAttempt(guildId),
      destroyed: () => this.destroyed,
      destroyVoiceConnection: destroyVoiceConnectionSafely,
      discordConfig: params.discordConfig,
      getRecoveryAttempt: (guildId) => this.receive.getRecoveryAttempt(guildId),
      getSession: (guildId) => this.sessions.get(guildId),
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
      receive: this.receive,
      sessions: this.sessions,
    });
    this.daveRecoveryAttempts = this.receive.daveRecoveryAttempts;
    this.followedUserChannels = this.following.followedUserChannels;
    this.followedVoiceGuilds = this.following.followedVoiceGuilds;
  }

  setBotUserId(id?: string): void {
    if (id) {
      this.botUserId = id;
    }
  }

  refreshGuildRoster(guildId: string): void {
    this.voiceSessions.refreshGuildRoster(guildId);
  }

  isEnabled(): boolean {
    return this.voiceEnabled;
  }

  async autoJoin(): Promise<void> {
    if (!this.voiceEnabled || this.destroyed) {
      return;
    }
    if (this.autoJoinTask) {
      return this.autoJoinTask;
    }
    this.autoJoinTask = (async () => {
      const entries = this.params.discordConfig.voice?.autoJoin ?? [];
      const entriesByGuild = new Map<string, { guildId: string; channelId: string }>();
      const duplicateGuilds = new Set<string>();
      for (const entry of entries) {
        const guildId = entry.guildId.trim();
        const channelId = entry.channelId.trim();
        if (!guildId || !channelId) {
          continue;
        }
        if (entriesByGuild.has(guildId)) {
          duplicateGuilds.add(guildId);
        }
        entriesByGuild.set(guildId, { guildId, channelId });
      }

      logVoiceVerbose(`autoJoin: ${entries.length} entries, ${entriesByGuild.size} guilds`);
      for (const guildId of duplicateGuilds) {
        const selected = entriesByGuild.get(guildId);
        if (selected) {
          logger.warn(
            `discord voice: autoJoin has multiple entries for guild ${guildId}; using channel ${selected.channelId}`,
          );
        }
      }

      for (const entry of entriesByGuild.values()) {
        const failureKey = formatAutoJoinFailureKey(entry);
        const fatalFailure = this.fatalAutoJoinFailures.get(failureKey);
        if (fatalFailure) {
          if (!fatalFailure.skipLogged) {
            logger.warn(
              `discord voice: autoJoin suppressed guild=${entry.guildId} channel=${entry.channelId} after fatal startup failure; retry with /vc join or reload config after fixing credentials: ${fatalFailure.message}`,
            );
            fatalFailure.skipLogged = true;
          }
          continue;
        }
        logVoiceVerbose(`autoJoin: joining guild ${entry.guildId} channel ${entry.channelId}`);
        const result = await this.join(entry);
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
      await this.following.startReconciliation();
    })().finally(() => {
      this.autoJoinTask = null;
    });
    return this.autoJoinTask;
  }

  status(): VoiceOperationResult[] {
    return Array.from(this.sessions.values()).map((session) => ({
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

    const joinTask = this.voiceSessions.joinUnlocked({ guildId, channelId }, options);
    this.joinTasks.set(guildId, joinTask);
    try {
      const result = await joinTask;
      if (result.ok) {
        this.fatalAutoJoinFailures.delete(formatAutoJoinFailureKey({ guildId, channelId }));
      }
      return result;
    } finally {
      if (this.joinTasks.get(guildId) === joinTask) {
        this.joinTasks.delete(guildId);
      }
    }
  }

  leave(
    params: { guildId: string; channelId?: string },
    options?: { preserveFollowState?: boolean; transcriptsSessionId?: string },
  ): Promise<VoiceOperationResult> {
    return this.voiceSessions.leave(params, options);
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
      return;
    }
    this.membership.track(this.sessions.get(guildId), data, previousVoiceState);
    if (this.following.isFollowedUser(userId)) {
      await this.following.handleFollowedUserVoiceStateUpdate({ guildId, channelId, userId });
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.following.destroy();
    for (const entry of this.sessions.values()) {
      entry.stop();
    }
    this.sessions.clear();
    this.receive.clearRecoveryAttempts();
  }

  private handleSpeakingStart(entry: VoiceSessionEntry, userId: string): Promise<void> {
    return this.receive.handleSpeakingStart(entry, userId);
  }

  private handleReceiveError(entry: VoiceSessionEntry, err: unknown): void {
    this.receive.handleReceiveError(entry, err);
  }

  private scheduleCaptureFinalize(entry: VoiceSessionEntry, userId: string, reason: string): void {
    this.receive.scheduleCaptureFinalize(entry, userId, reason);
  }

  private processSegment(params: {
    entry: VoiceSessionEntry;
    wavPath: string;
    userId: string;
    durationSeconds: number;
  }): Promise<void> {
    return this.receive.processSegment(params);
  }
}

export {
  DiscordVoiceGuildCreateListener,
  DiscordVoiceReadyListener,
  DiscordVoiceResumedListener,
  DiscordVoiceStateUpdateListener,
} from "./listeners.js";

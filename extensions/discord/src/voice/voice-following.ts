import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  getGuildVoiceState,
  isUnknownDiscordVoiceStateError,
  type Client,
} from "../internal/discord.js";
import type { VoicePlugin } from "../internal/voice.js";
import { DECRYPT_FAILURE_WINDOW_MS } from "./receive-recovery.js";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";
import { logVoiceVerbose, type VoiceOperationResult, type VoiceSessionEntry } from "./session.js";

const logger = createSubsystemLogger("discord/voice");
const FOLLOW_USERS_RECONCILE_INTERVAL_MS = 10_000;
const FOLLOW_USERS_RECONCILE_MAX_GUILDS_PER_RUN = 4;
const FOLLOW_USERS_RECONCILE_MAX_REST_LOOKUPS_PER_RUN = 32;

export type VoiceChannelResidency = {
  guildId: string;
  channelId: string;
};

type FollowUserReconcileGuildPlan = {
  guildId: string;
  userIds: string[];
  checkedAllUsers: boolean;
  checkBotVoiceState: boolean;
};

type FollowUserReconcileUserSelection = {
  userIds: string[];
  completedCycle: boolean;
};

export function normalizeVoiceChannelResidencies(
  entries: Array<{ guildId?: string; channelId?: string }> | undefined,
): VoiceChannelResidency[] {
  const normalized: VoiceChannelResidency[] = [];
  for (const entry of entries ?? []) {
    const guildId = entry.guildId?.trim();
    const channelId = entry.channelId?.trim();
    if (guildId && channelId) {
      normalized.push({ guildId, channelId });
    }
  }
  return normalized;
}

function normalizeDiscordUserId(value: string): string | undefined {
  const trimmed = value.trim();
  const withoutDiscordPrefix = trimmed.startsWith("discord:") ? trimmed.slice(8) : trimmed;
  const withoutUserPrefix = withoutDiscordPrefix.startsWith("user:")
    ? withoutDiscordPrefix.slice(5)
    : withoutDiscordPrefix;
  return withoutUserPrefix.trim() || undefined;
}

function normalizeDiscordUserIds(entries: string[] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries ?? []) {
    const id = normalizeDiscordUserId(entry);
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}

function resolveFollowUsersEnabled(voiceConfig: DiscordAccountConfig["voice"]): boolean {
  return voiceConfig?.followUsersEnabled !== false;
}

function logFollowUserReconcileVerbose(reason: string, message: string): void {
  if (reason === "interval") {
    logger.trace(`discord voice: ${message}`);
    return;
  }
  logVoiceVerbose(message);
}

function resolveVoiceConnectionGroup(accountId: string): string {
  return `openclaw:${accountId}`;
}

export class DiscordVoiceFollowing {
  private readonly followUserIds: Set<string>;
  readonly followedUserChannels = new Map<string, VoiceChannelResidency>();
  readonly followedVoiceGuilds = new Set<string>();
  private followUsersReconcileTimer: NodeJS.Timeout | null = null;
  private followUsersReconcileTask: Promise<void> | null = null;
  private followUsersReconcileGuildCursor = 0;
  private followUsersReconcileBotGuildCursor = 0;
  private readonly followUsersReconcileUserCursors = new Map<string, number>();
  private readonly followEventGenerations = new Map<string, number>();

  constructor(
    private readonly params: {
      accountId: string;
      allowedChannels: VoiceChannelResidency[] | null;
      autoJoinChannels: VoiceChannelResidency[];
      botUserId: () => string | undefined;
      client: Client;
      deleteRecoveryAttempt: (guildId: string) => void;
      destroyed: () => boolean;
      discordConfig: DiscordAccountConfig;
      destroyVoiceConnection: (params: {
        connection: ReturnType<ReturnType<typeof loadDiscordVoiceSdk>["joinVoiceChannel"]>;
        voiceSdk: ReturnType<typeof loadDiscordVoiceSdk>;
        reason: string;
      }) => void;
      getRecoveryAttempt: (guildId: string) => number | undefined;
      getSession: (guildId: string) => VoiceSessionEntry | undefined;
      hasVoiceLifecycle: (guildId: string) => boolean;
      isAllowedVoiceChannel: (entry: VoiceChannelResidency) => boolean;
      join: (
        entry: VoiceChannelResidency,
        options?: { preserveFollowState?: boolean },
      ) => Promise<VoiceOperationResult>;
      leave: (
        entry: { guildId: string },
        options?: { preserveFollowState?: boolean },
      ) => Promise<VoiceOperationResult>;
      listSessions: () => Iterable<VoiceSessionEntry>;
      voiceEnabled: boolean;
    },
  ) {
    this.followUserIds = resolveFollowUsersEnabled(params.discordConfig.voice)
      ? normalizeDiscordUserIds(params.discordConfig.voice?.followUsers)
      : new Set();
  }

  isFollowedUser(userId: string): boolean {
    return this.followUserIds.has(userId);
  }

  async startReconciliation(): Promise<void> {
    this.ensureFollowUsersReconcileTimer();
    await this.reconcileFollowedUsers("startup");
  }

  async handleBotVoiceStateUpdate(params: {
    guildId: string;
    channelId: string | undefined;
  }): Promise<void> {
    const { guildId, channelId } = params;
    if (!channelId) {
      return;
    }
    const existing = this.params.getSession(guildId);
    if (this.params.isAllowedVoiceChannel({ guildId, channelId })) {
      if (existing && existing.channelId !== channelId) {
        logger.warn(
          `discord voice: bot moved to allowed channel guild=${guildId} from=${existing.channelId} to=${channelId}; rebuilding voice session`,
        );
        await this.params.join(
          { guildId, channelId },
          { preserveFollowState: this.isFollowOwnedGuild(guildId) },
        );
      }
      return;
    }

    logger.warn(
      `discord voice: bot moved to non-allowed channel guild=${guildId} channel=${channelId}; leaving`,
    );
    if (existing) {
      await this.params.leave({ guildId });
    } else {
      const voiceSdk = loadDiscordVoiceSdk();
      const connection = voiceSdk.getVoiceConnection(
        guildId,
        resolveVoiceConnectionGroup(this.params.accountId),
      );
      if (connection) {
        this.params.destroyVoiceConnection({
          connection,
          voiceSdk,
          reason: `non-allowed voice state guild ${guildId} channel ${channelId}`,
        });
      }
    }

    const target = this.resolveVoiceResidencyTarget(guildId);
    if (target) {
      logger.warn(
        `discord voice: rejoining allowed voice channel guild=${guildId} channel=${target.channelId}`,
      );
      await this.params.join(target);
    }
  }

  async handleFollowedUserVoiceStateUpdate(params: {
    guildId: string;
    channelId: string | undefined;
    userId: string;
  }): Promise<void> {
    if (!this.params.voiceEnabled || this.params.destroyed()) {
      return;
    }
    const { guildId, channelId, userId } = params;
    const followKey = this.formatFollowedUserKey({ guildId, userId });
    const eventGeneration = (this.followEventGenerations.get(followKey) ?? 0) + 1;
    this.followEventGenerations.set(followKey, eventGeneration);
    const isCurrentEvent = () => this.followEventGenerations.get(followKey) === eventGeneration;
    const previousFollowedChannelId = this.followedUserChannels.get(followKey)?.channelId;
    const existing = this.params.getSession(guildId);
    const wasFollowedVoiceSession =
      this.followedUserChannels.has(followKey) || this.followedVoiceGuilds.has(guildId);
    if (!channelId) {
      this.followedUserChannels.delete(followKey);
      if (existing && wasFollowedVoiceSession && !this.hasFollowedUserInChannel(existing)) {
        await this.handoffToAnotherFollowedUserOrLeave({
          guildId,
          userId,
          existing,
          reason: "disconnected",
        });
      } else if (!existing && wasFollowedVoiceSession && this.params.hasVoiceLifecycle(guildId)) {
        await this.params.leave({ guildId });
      }
      return;
    }
    if (!this.params.isAllowedVoiceChannel({ guildId, channelId })) {
      this.followedUserChannels.delete(followKey);
      logger.warn(
        `discord voice: followed user joined non-allowed channel guild=${guildId} user=${userId} channel=${channelId}; ignoring`,
      );
      if (existing && wasFollowedVoiceSession && !this.hasFollowedUserInChannel(existing)) {
        await this.handoffToAnotherFollowedUserOrLeave({
          guildId,
          userId,
          existing,
          reason: "joined non-allowed channel",
        });
      }
      return;
    }
    this.followedUserChannels.set(followKey, { guildId, channelId });
    if (existing?.channelId === channelId) {
      this.followedVoiceGuilds.add(guildId);
      return;
    }
    const recoveryAttemptAt = this.params.getRecoveryAttempt(guildId);
    if (!existing && previousFollowedChannelId === channelId && recoveryAttemptAt !== undefined) {
      if (Date.now() - recoveryAttemptAt < DECRYPT_FAILURE_WINDOW_MS) {
        logger.warn(
          `discord voice: automatic follow suppressed during DAVE recovery cooldown guild=${guildId} channel=${channelId}; retry /vc join after the voice gateway recovers`,
        );
        return;
      }
      this.params.deleteRecoveryAttempt(guildId);
    }
    logger.info(
      `discord voice: following user guild=${guildId} user=${userId} channel=${channelId}`,
    );
    const result = await this.params.join({ guildId, channelId }, { preserveFollowState: true });
    if (!isCurrentEvent()) {
      return;
    }
    if (!result.ok) {
      const current = this.params.getSession(guildId);
      if (current?.channelId === channelId) {
        this.followedVoiceGuilds.add(guildId);
      } else {
        this.followedUserChannels.delete(followKey);
      }
      logger.warn(
        `discord voice: failed to follow user guild=${guildId} user=${userId} channel=${channelId}: ${result.message}`,
      );
      return;
    }
    this.followedVoiceGuilds.add(guildId);
  }

  destroy(): void {
    if (this.followUsersReconcileTimer) {
      clearInterval(this.followUsersReconcileTimer);
      this.followUsersReconcileTimer = null;
    }
    this.followedUserChannels.clear();
    this.followedVoiceGuilds.clear();
    this.followEventGenerations.clear();
  }

  isFollowOwnedGuild(guildId: string): boolean {
    return (
      this.followedVoiceGuilds.has(guildId) ||
      Array.from(this.followedUserChannels.values()).some((entry) => entry.guildId === guildId)
    );
  }

  deleteFollowedUserChannelsForGuild(guildId: string): void {
    for (const [key, entry] of this.followedUserChannels.entries()) {
      if (entry.guildId === guildId) {
        this.followedUserChannels.delete(key);
      }
    }
  }

  private resolveFollowGuildIds(): string[] {
    const guildIds = new Set<string>();
    for (const guildId of Object.keys(this.params.discordConfig.guilds ?? {})) {
      const normalized = guildId.trim();
      if (normalized) {
        guildIds.add(normalized);
      }
    }
    for (const entry of this.params.autoJoinChannels) {
      guildIds.add(entry.guildId);
    }
    for (const entry of this.params.allowedChannels ?? []) {
      guildIds.add(entry.guildId);
    }
    for (const entry of this.params.listSessions()) {
      guildIds.add(entry.guildId);
    }
    return Array.from(guildIds);
  }

  private ensureFollowUsersReconcileTimer(): void {
    if (this.followUserIds.size === 0 || this.params.destroyed()) {
      return;
    }
    if (this.followUsersReconcileTimer) {
      return;
    }
    this.followUsersReconcileTimer = setInterval(() => {
      void this.reconcileFollowedUsers("interval").catch((err: unknown) => {
        logger.warn(`discord voice: follow user reconciliation failed: ${formatErrorMessage(err)}`);
      });
    }, FOLLOW_USERS_RECONCILE_INTERVAL_MS);
    this.followUsersReconcileTimer.unref?.();
  }

  private async reconcileFollowedUsers(reason: string): Promise<void> {
    if (this.followUserIds.size === 0 || this.params.destroyed()) {
      return;
    }
    if (this.followUsersReconcileTask) {
      return this.followUsersReconcileTask;
    }
    this.followUsersReconcileTask = this.runFollowedUsersReconcile(reason).finally(() => {
      this.followUsersReconcileTask = null;
    });
    return this.followUsersReconcileTask;
  }

  private async runFollowedUsersReconcile(reason: string): Promise<void> {
    if (this.params.destroyed()) {
      return;
    }
    const guildIds = this.resolveFollowGuildIds();
    if (guildIds.length === 0) {
      logVoiceVerbose(
        `follow user reconcile skipped reason=${reason}: no Discord guild ids are configured`,
      );
      return;
    }
    logFollowUserReconcileVerbose(
      reason,
      `follow user reconcile reason=${reason}: ${this.followUserIds.size} users across ${guildIds.length} guilds`,
    );
    const plans = this.selectFollowUserReconcilePlans(guildIds, reason);
    for (const plan of plans) {
      for (const userId of plan.userIds) {
        const voiceState = await getGuildVoiceState(
          this.params.client.rest,
          plan.guildId,
          userId,
        ).catch((err: unknown) => {
          if (!isUnknownDiscordVoiceStateError(err)) {
            logger.warn(
              `follow-user reconcile skipped (transient voice-state error) guild=${plan.guildId} user=${userId} trigger=${reason}: ${formatErrorMessage(err)}`,
            );
            return "transient-error" as const;
          }
          logFollowUserReconcileVerbose(
            reason,
            `follow user reconcile reason=${reason}: no voice state guild ${plan.guildId} user ${userId}: ${formatErrorMessage(err)}`,
          );
          return undefined;
        });
        if (this.params.destroyed()) {
          return;
        }
        if (voiceState === "transient-error") {
          continue;
        }
        const channelId = voiceState?.channel_id?.trim();
        await this.handleFollowedUserVoiceStateUpdate({
          guildId: plan.guildId,
          channelId,
          userId,
        });
      }
      if (plan.checkBotVoiceState) {
        if (this.params.destroyed()) {
          return;
        }
        await this.disconnectStaleFollowedBotVoiceState({ guildId: plan.guildId, reason });
      }
    }
  }

  private selectFollowUserReconcilePlans(
    guildIds: string[],
    reason: string,
  ): FollowUserReconcileGuildPlan[] {
    const followedUserIds = Array.from(this.followUserIds);
    if (followedUserIds.length === 0) {
      return [];
    }
    let remainingLookups = FOLLOW_USERS_RECONCILE_MAX_REST_LOOKUPS_PER_RUN;
    const guildLimit = Math.min(guildIds.length, FOLLOW_USERS_RECONCILE_MAX_GUILDS_PER_RUN);
    const start = this.followUsersReconcileGuildCursor % guildIds.length;
    const plans: FollowUserReconcileGuildPlan[] = [];

    for (let offset = 0; offset < guildLimit && remainingLookups > 0; offset += 1) {
      if (this.params.botUserId() && remainingLookups === 1) {
        break;
      }
      const guildId = expectDefined(
        guildIds[(start + offset) % guildIds.length],
        "voice reconciliation guild index",
      );
      const userLimit = this.resolveFollowUserReconcileUserLookupLimit(
        followedUserIds.length,
        remainingLookups,
      );
      if (userLimit <= 0) {
        break;
      }
      const selection = this.selectFollowUserReconcileUserIds(guildId, followedUserIds, userLimit);
      plans.push({
        guildId,
        userIds: selection.userIds,
        checkedAllUsers: selection.completedCycle,
        checkBotVoiceState: false,
      });
      remainingLookups -= selection.userIds.length;
    }

    this.followUsersReconcileGuildCursor = (start + plans.length) % guildIds.length;
    this.assignFollowUserReconcileBotChecks(guildIds, plans, remainingLookups);
    if (
      plans.length < guildIds.length ||
      plans.some((plan) => plan.userIds.length < followedUserIds.length)
    ) {
      logVoiceVerbose(
        `follow user reconcile reason=${reason}: sampling ${plans.length}/${guildIds.length} guilds and up to ${FOLLOW_USERS_RECONCILE_MAX_REST_LOOKUPS_PER_RUN} REST lookups`,
      );
    }
    return plans;
  }

  private assignFollowUserReconcileBotChecks(
    guildIds: string[],
    plans: FollowUserReconcileGuildPlan[],
    remainingLookups: number,
  ): void {
    if (!this.params.botUserId() || remainingLookups <= 0 || plans.length === 0) {
      return;
    }
    const plansByGuild = new Map(plans.map((plan) => [plan.guildId, plan]));
    const start = this.followUsersReconcileBotGuildCursor % guildIds.length;
    let scanned = 0;
    let assigned = 0;
    for (; scanned < guildIds.length && assigned < remainingLookups; scanned += 1) {
      const guildId = expectDefined(
        guildIds[(start + scanned) % guildIds.length],
        "bot voice reconciliation guild index",
      );
      const plan = plansByGuild.get(guildId);
      if (!plan?.checkedAllUsers) {
        continue;
      }
      plan.checkBotVoiceState = true;
      assigned += 1;
    }
    this.followUsersReconcileBotGuildCursor = (start + scanned) % guildIds.length;
  }

  private resolveFollowUserReconcileUserLookupLimit(
    followedUserCount: number,
    remainingLookups: number,
  ): number {
    const userLimit = Math.min(followedUserCount, remainingLookups);
    if (this.params.botUserId() && followedUserCount > userLimit && remainingLookups > 1) {
      return remainingLookups - 1;
    }
    return userLimit;
  }

  private selectFollowUserReconcileUserIds(
    guildId: string,
    followedUserIds: string[],
    limit: number,
  ): FollowUserReconcileUserSelection {
    if (followedUserIds.length <= limit) {
      this.followUsersReconcileUserCursors.set(guildId, 0);
      return { userIds: followedUserIds, completedCycle: true };
    }
    const start = this.followUsersReconcileUserCursors.get(guildId) ?? 0;
    const selected: string[] = [];
    for (let offset = 0; offset < limit; offset += 1) {
      selected.push(
        expectDefined(
          followedUserIds[(start + offset) % followedUserIds.length],
          "followed user selection index",
        ),
      );
    }
    const completedCycle = start + selected.length >= followedUserIds.length;
    this.followUsersReconcileUserCursors.set(
      guildId,
      (start + selected.length) % followedUserIds.length,
    );
    return { userIds: selected, completedCycle };
  }

  private formatFollowedUserKey(params: { guildId: string; userId: string }): string {
    return `${params.guildId}:${params.userId}`;
  }

  private hasFollowedUserInChannel(entry: VoiceChannelResidency): boolean {
    return Array.from(this.followedUserChannels.values()).some(
      (candidate) => candidate.guildId === entry.guildId && candidate.channelId === entry.channelId,
    );
  }

  private resolveFollowedUserHandoffTarget(
    guildId: string,
    currentChannelId: string,
  ): VoiceChannelResidency | null {
    for (const entry of this.followedUserChannels.values()) {
      if (
        entry.guildId === guildId &&
        entry.channelId !== currentChannelId &&
        this.params.isAllowedVoiceChannel(entry)
      ) {
        return entry;
      }
    }
    return null;
  }

  private async handoffToAnotherFollowedUserOrLeave(params: {
    guildId: string;
    userId: string;
    existing: VoiceChannelResidency;
    reason: string;
  }): Promise<void> {
    const target = this.resolveFollowedUserHandoffTarget(params.guildId, params.existing.channelId);
    if (target) {
      logger.info(
        `discord voice: followed user ${params.reason} guild=${params.guildId} user=${params.userId}; moving to remaining followed user channel=${target.channelId}`,
      );
      const result = await this.params.join(target, { preserveFollowState: true });
      if (result.ok) {
        this.followedVoiceGuilds.add(params.guildId);
      } else {
        logger.warn(
          `discord voice: failed to hand off followed user session guild=${params.guildId} channel=${target.channelId}: ${result.message}`,
        );
        this.followedVoiceGuilds.delete(params.guildId);
        this.deleteFollowedUserChannelsForGuild(params.guildId);
        await this.params.leave({ guildId: params.guildId });
      }
      return;
    }
    logger.info(
      `discord voice: followed user ${params.reason} guild=${params.guildId} user=${params.userId}; leaving channel=${params.existing.channelId}`,
    );
    await this.params.leave({ guildId: params.guildId });
  }

  private async disconnectStaleFollowedBotVoiceState(params: {
    guildId: string;
    reason: string;
  }): Promise<void> {
    if (this.params.destroyed()) {
      return;
    }
    const { guildId, reason } = params;
    if (Array.from(this.followedUserChannels.values()).some((entry) => entry.guildId === guildId)) {
      return;
    }
    const existing = this.params.getSession(guildId);
    if (existing) {
      if (this.followedVoiceGuilds.has(guildId)) {
        logger.info(
          `discord voice: follow reconcile leaving local session guild=${guildId} channel=${existing.channelId} reason=${reason}`,
        );
        await this.params.leave({ guildId });
      }
      return;
    }
    const botUserId = this.params.botUserId();
    if (!botUserId) {
      return;
    }
    const botVoiceState = await getGuildVoiceState(
      this.params.client.rest,
      guildId,
      botUserId,
    ).catch((err: unknown) => {
      if (!isUnknownDiscordVoiceStateError(err)) {
        logger.warn(
          `discord voice: follow reconcile skipped transient bot voice state error guild=${guildId} reason=${reason}: ${formatErrorMessage(err)}`,
        );
        return "transient-error" as const;
      }
      logFollowUserReconcileVerbose(
        reason,
        `follow user reconcile reason=${reason}: no bot voice state guild ${guildId}: ${formatErrorMessage(err)}`,
      );
      return undefined;
    });
    if (this.params.destroyed() || botVoiceState === "transient-error") {
      return;
    }
    const botChannelId = botVoiceState?.channel_id?.trim();
    if (!botChannelId) {
      return;
    }
    const voicePlugin = this.params.client.getPlugin<VoicePlugin>("voice");
    const gateway = voicePlugin?.getGateway(guildId);
    if (!gateway) {
      logger.warn(
        `discord voice: follow reconcile cannot disconnect stale bot voice state guild=${guildId} channel=${botChannelId}; gateway unavailable`,
      );
      return;
    }
    logger.info(
      `discord voice: follow reconcile disconnecting stale bot voice state guild=${guildId} channel=${botChannelId} reason=${reason}`,
    );
    gateway.updateVoiceState({
      guild_id: guildId,
      channel_id: null,
      self_mute: false,
      self_deaf: false,
    });
  }

  private resolveVoiceResidencyTarget(guildId: string): VoiceChannelResidency | null {
    const autoJoinTarget = this.params.autoJoinChannels
      .toReversed()
      .find((entry) => entry.guildId === guildId);
    if (autoJoinTarget && this.params.isAllowedVoiceChannel(autoJoinTarget)) {
      return autoJoinTarget;
    }
    if (this.params.allowedChannels === null) {
      return null;
    }
    const guildAllowed = this.params.allowedChannels.filter((entry) => entry.guildId === guildId);
    return guildAllowed.length === 1
      ? expectDefined(guildAllowed.at(0), "single allowed guild voice channel")
      : null;
  }
}

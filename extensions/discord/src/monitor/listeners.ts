// Discord plugin module implements listeners behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { requestHeartbeat } from "openclaw/plugin-sdk/heartbeat-runtime";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import {
  type Client,
  type DiscordMessageDispatchData,
  GuildCreateListener,
  GuildDeleteListener,
  InteractionCreateListener,
  MessageCreateListener,
  PresenceUpdateListener,
  ReadyListener,
  ThreadUpdateListener,
} from "../internal/discord.js";
import { canViewDiscordGuildChannel } from "../send.permissions.js";
import { discordEventQueueLog, runDiscordListenerWithSlowLog } from "./listeners.queue.js";
export { DiscordReactionListener, DiscordReactionRemoveListener } from "./listeners.reactions.js";
import { type DiscordGuildEntryResolved, resolveDiscordGuildEntry } from "./allow-list.js";
import { clearPresences, setPresence } from "./presence-cache.js";
import { openDiscordPresenceCooldownStore } from "./presence-cooldown-store.js";
import {
  DiscordPresenceEmissionGate,
  resolveDiscordPresenceGateOptions,
} from "./presence-emission-gate.js";
import {
  DISCORD_PRESENCE_GREETING_COOLDOWN_MS,
  isDiscordOfflineStatus,
  isDiscordOnlineStatus,
  resolveDiscordOnlinePresenceEvent,
} from "./presence-events.js";
import { DiscordPresenceBaselineCache } from "./presence-transition-cache.js";
import { isThreadArchived } from "./thread-bindings.discord-api.js";
import { closeDiscordThreadSessions } from "./thread-session-close.js";

type Logger = ReturnType<typeof import("openclaw/plugin-sdk/runtime-env").createSubsystemLogger>;

type DiscordRawMessageEvent = Parameters<MessageCreateListener["handle"]>[0];
export type DiscordMessageEvent = DiscordMessageDispatchData;
type DiscordInteractionEvent = Parameters<InteractionCreateListener["handle"]>[0];

export type DiscordMessageHandler = (
  data: DiscordRawMessageEvent,
  client: Client,
  options?: { abortSignal?: AbortSignal },
) => Promise<void>;

export function registerDiscordListener(listeners: Array<object>, listener: object) {
  if (listeners.some((existing) => existing.constructor === listener.constructor)) {
    return false;
  }
  listeners.push(listener);
  return true;
}

export class DiscordMessageListener extends MessageCreateListener {
  constructor(
    private handler: DiscordMessageHandler,
    private logger?: Logger,
    private onEvent?: () => void,
  ) {
    super();
  }

  async handle(data: DiscordRawMessageEvent, client: Client) {
    this.onEvent?.();
    // This awaits only the durable append. Agent dispatch remains detached behind
    // the ingress drain, so later gateway events never wait for a model turn.
    try {
      await this.handler(data, client);
    } catch (err) {
      const logger = this.logger ?? discordEventQueueLog;
      logger.error(danger(`discord handler failed: ${String(err)}`));
    }
  }
}

export class DiscordInteractionListener extends InteractionCreateListener {
  constructor(
    private logger?: Logger,
    private onEvent?: () => void,
  ) {
    super();
  }

  async handle(data: DiscordInteractionEvent, client: Client) {
    this.onEvent?.();
    // Hand off immediately so slash/component handling can wait on session locks
    // or compaction without blocking later gateway events.
    void Promise.resolve()
      .then(() => client.handleInteraction(data as Parameters<Client["handleInteraction"]>[0], {}))
      .catch((err: unknown) => {
        const logger = this.logger ?? discordEventQueueLog;
        logger.error(danger(`discord interaction handler failed: ${String(err)}`));
      });
  }
}

type PresenceUpdateEvent = Parameters<PresenceUpdateListener["handle"]>[0];
type GuildCreateEvent = Parameters<GuildCreateListener["handle"]>[0];
type GuildDeleteEvent = Parameters<GuildDeleteListener["handle"]>[0];
type GuildPresenceState = { generation: number; inferUnknownAsNewlyAvailable: boolean };

export class DiscordPresenceListener extends PresenceUpdateListener {
  private readonly presenceBaseline: DiscordPresenceBaselineCache;
  private readonly pendingByGuildUser = new Map<string, Promise<void>>();
  private readonly guildPresenceState = new Map<string, GuildPresenceState>();
  private gatewayGeneration = 0;
  private readonly cooldownStore: PluginStateSyncKeyedStore<number>;
  private readonly emissionGate: DiscordPresenceEmissionGate;

  constructor(
    private readonly params: {
      cfg: OpenClawConfig;
      logger?: Logger;
      accountId: string;
      botUserId?: string;
      guildEntries?: Record<string, DiscordGuildEntryResolved>;
      nowMs?: () => number;
      cooldownStore?: PluginStateSyncKeyedStore<number>;
      presenceBaseline?: DiscordPresenceBaselineCache;
      emissionGate?: DiscordPresenceEmissionGate;
    },
  ) {
    super();
    this.cooldownStore = params.cooldownStore ?? openDiscordPresenceCooldownStore();
    this.presenceBaseline = params.presenceBaseline ?? new DiscordPresenceBaselineCache();
    this.emissionGate = params.emissionGate ?? new DiscordPresenceEmissionGate();
  }

  seedGuildSnapshot(data: GuildCreateEvent): void {
    const config = resolveDiscordGuildEntry({
      guildId: data.id,
      guildEntries: this.params.guildEntries,
    })?.presenceEvents;
    if (!config || config.enabled === false) {
      return;
    }
    const keyPrefix = `${this.params.accountId}:${data.id}:`;
    // A repeated GUILD_CREATE is a replacement snapshot after guild availability changes.
    // Invalidate older async work before replacing any baseline state.
    const generation = (this.guildPresenceState.get(data.id)?.generation ?? 0) + 1;
    this.guildPresenceState.set(data.id, { generation, inferUnknownAsNewlyAvailable: false });
    this.detachPendingPrefix(keyPrefix);
    this.presenceBaseline.clearScope(data.id);
    if (data.unavailable === true || !("presences" in data) || !Array.isArray(data.presences)) {
      return;
    }
    // Discord documents snapshots above 75,000 members as partial. Unknown members from those
    // guilds stay suppressed until an explicit offline update establishes the transition.
    this.guildPresenceState.set(data.id, {
      generation,
      inferUnknownAsNewlyAvailable: data.member_count <= 75_000,
    });
    for (const presence of data.presences) {
      const userId = presence.user?.id;
      if (!userId || (config.users !== undefined && !config.users.includes(userId))) {
        continue;
      }
      const key = `${keyPrefix}${userId}`;
      if (isDiscordOfflineStatus(presence.status)) {
        this.recordPresenceBaseline(data.id, key, "offline");
      } else if (isDiscordOnlineStatus(presence.status)) {
        this.recordPresenceBaseline(data.id, key, "online");
      }
    }
  }

  async handle(data: PresenceUpdateEvent, client: Client) {
    const userId = data.user?.id;
    if (!userId) {
      return;
    }
    setPresence(this.params.accountId, userId, data);
    const presenceKey = `${this.params.accountId}:${data.guild_id}:${userId}`;
    const gatewayGeneration = this.gatewayGeneration;
    const guildGeneration = this.guildPresenceState.get(data.guild_id)?.generation ?? 0;
    const previousRun = this.pendingByGuildUser.get(presenceKey) ?? Promise.resolve();
    const run = previousRun.then(
      () =>
        this.handleSerial(data, client, userId, presenceKey, gatewayGeneration, guildGeneration),
      () =>
        this.handleSerial(data, client, userId, presenceKey, gatewayGeneration, guildGeneration),
    );
    this.pendingByGuildUser.set(presenceKey, run);
    try {
      await run;
    } catch (err) {
      const logger = this.params.logger ?? discordEventQueueLog;
      logger.error(danger(`discord presence handler failed: ${String(err)}`));
    } finally {
      if (this.pendingByGuildUser.get(presenceKey) === run) {
        this.pendingByGuildUser.delete(presenceKey);
      }
    }
  }

  resetGatewaySession(): void {
    this.gatewayGeneration += 1;
    // A READY event starts a new Gateway session and rebuilds guild presence state. Hold emission
    // during that rebuild so the re-observation burst cannot wake the agent per member.
    this.emissionGate.noteGatewaySessionReset(this.params.nowMs?.() ?? Date.now());
    this.presenceBaseline.clear();
    this.guildPresenceState.clear();
    // Generations make old REST results inert. Detach their chains so a hung lookup cannot block
    // presence delivery from the replacement gateway session.
    this.pendingByGuildUser.clear();
    clearPresences(this.params.accountId);
  }

  invalidateGuild(guildId: string): void {
    const keyPrefix = `${this.params.accountId}:${guildId}:`;
    const generation = (this.guildPresenceState.get(guildId)?.generation ?? 0) + 1;
    this.guildPresenceState.set(guildId, { generation, inferUnknownAsNewlyAvailable: false });
    this.presenceBaseline.clearScope(guildId);
    this.detachPendingPrefix(keyPrefix);
  }

  private detachPendingPrefix(prefix: string): void {
    for (const key of this.pendingByGuildUser.keys()) {
      if (key.startsWith(prefix)) {
        this.pendingByGuildUser.delete(key);
      }
    }
  }

  private async handleSerial(
    data: PresenceUpdateEvent,
    client: Client,
    userId: string,
    presenceKey: string,
    gatewayGeneration: number,
    guildGeneration: number,
  ) {
    if (!this.isCurrentGeneration(data.guild_id, gatewayGeneration, guildGeneration)) {
      return;
    }
    const config = resolveDiscordGuildEntry({
      guildId: data.guild_id,
      guildEntries: this.params.guildEntries,
    })?.presenceEvents;
    if (!config || config.enabled === false) {
      return;
    }
    // Filter before every baseline read or write. Excluded traffic must not consume bounded state.
    if (config.users !== undefined && !config.users.includes(userId)) {
      return;
    }

    const nowMs = this.params.nowMs?.() ?? Date.now();
    const presenceScope = data.guild_id;
    // A complete GUILD_CREATE lists currently online members. A later first-seen member is newly
    // available to the guild, but may have joined after the snapshot; never assert prior offline.
    const availabilityKind = this.presenceBaseline.isOffline(presenceScope, presenceKey)
      ? "observed-offline"
      : this.guildPresenceState.get(data.guild_id)?.inferUnknownAsNewlyAvailable === true &&
          !this.presenceBaseline.isOnline(presenceScope, presenceKey)
        ? "first-seen-after-snapshot"
        : null;
    const presenceEvent = resolveDiscordOnlinePresenceEvent({
      config,
      data,
      availabilityKind,
      botUserId: this.params.botUserId,
      nowMs,
      lastEmittedAtMs: this.cooldownStore.lookup(presenceKey),
    });
    if (!presenceEvent) {
      if (isDiscordOfflineStatus(data.status)) {
        this.recordPresenceBaseline(data.guild_id, presenceKey, "offline");
      } else if (isDiscordOnlineStatus(data.status)) {
        this.recordPresenceBaseline(data.guild_id, presenceKey, "online");
      }
      return;
    }

    const gateOptions = resolveDiscordPresenceGateOptions(config);
    const reconnectGate = this.emissionGate.evaluateReconnectWindow(nowMs, gateOptions);
    if (!reconnectGate.allowed) {
      if (reconnectGate.shouldLog) {
        const logger = this.params.logger ?? discordEventQueueLog;
        logger.info("Discord presence events suppressed", {
          reason: reconnectGate.reason,
          accountId: this.params.accountId,
          guildId: data.guild_id,
        });
      }
      // Mark online so the member is not re-greeted at window end; a later observed
      // offline-to-online transition still emits normally.
      this.recordPresenceBaseline(data.guild_id, presenceKey, "online");
      return;
    }

    // Reserve before Discord REST lookups so a presence storm cannot bypass the burst cap by
    // filling the permission queue. Release every unqueued attempt; commit only after enqueue.
    const burstNowMs = this.params.nowMs?.() ?? Date.now();
    const burstGate = this.emissionGate.reserveBurst(data.guild_id, burstNowMs, gateOptions);
    if (!burstGate.allowed) {
      if (burstGate.shouldLog) {
        const logger = this.params.logger ?? discordEventQueueLog;
        logger.info("Discord presence events suppressed", {
          reason: burstGate.reason,
          accountId: this.params.accountId,
          guildId: data.guild_id,
        });
      }
      if (burstGate.reason === "burst-pending") {
        // Pending permission checks cap REST concurrency, but they are not emitted greetings.
        // Keep this member retryable after a lookup settles instead of advancing its baseline.
        return;
      }
      this.recordPresenceBaseline(data.guild_id, presenceKey, "online");
      return;
    }
    const burstReservation = burstGate.reservation;
    let burstCommitted = false;
    let cooldownReserved = false;
    try {
      const fetchedUserIsBot =
        data.user.bot === undefined && (await client.fetchUser(userId)).bot === true;
      if (!this.isCurrentGeneration(data.guild_id, gatewayGeneration, guildGeneration)) {
        return;
      }
      if (fetchedUserIsBot) {
        this.recordPresenceBaseline(data.guild_id, presenceKey, "online");
        return;
      }
      const canViewTargetChannel = await canViewDiscordGuildChannel(
        data.guild_id,
        presenceEvent.channelId,
        userId,
        {
          cfg: this.params.cfg,
          accountId: this.params.accountId,
          rest: client.rest,
        },
      );
      if (!this.isCurrentGeneration(data.guild_id, gatewayGeneration, guildGeneration)) {
        return;
      }
      if (!canViewTargetChannel) {
        // Presence is guild-wide. Require target-channel visibility so private channel greetings
        // cannot be triggered by unrelated guild members.
        this.recordPresenceBaseline(data.guild_id, presenceKey, "online");
        return;
      }
      const route = resolveAgentRoute({
        cfg: this.params.cfg,
        channel: "discord",
        accountId: this.params.accountId,
        guildId: data.guild_id,
        peer: { kind: "channel", id: presenceEvent.channelId },
      });

      try {
        cooldownReserved = this.cooldownStore.registerIfAbsent(presenceKey, nowMs, {
          ttlMs: DISCORD_PRESENCE_GREETING_COOLDOWN_MS,
        });
        if (!cooldownReserved) {
          // Another live listener won the durable claim while this one awaited Discord. Treat the
          // member as online locally so overlapping provider generations cannot retry the greeting.
          this.recordPresenceBaseline(data.guild_id, presenceKey, "online");
          return;
        }
      } catch (err) {
        const logger = this.params.logger ?? discordEventQueueLog;
        logger.warn(danger(`discord presence cooldown persistence failed: ${String(err)}`));
        return;
      }

      const queued = enqueueSystemEvent(presenceEvent.text, {
        sessionKey: route.sessionKey,
        contextKey: `discord:presence-online:${this.params.accountId}:${data.guild_id}:${userId}`,
        deliveryContext: {
          channel: "discord",
          to: `channel:${presenceEvent.channelId}`,
          accountId: this.params.accountId,
        },
      });
      if (!queued) {
        return;
      }
      this.emissionGate.commitBurst(
        data.guild_id,
        burstReservation,
        this.params.nowMs?.() ?? Date.now(),
      );
      burstCommitted = true;
      this.recordPresenceBaseline(data.guild_id, presenceKey, "online");
      requestHeartbeat({
        source: "notifications-event",
        intent: "immediate",
        reason: "wake",
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        heartbeat: {
          target: "discord",
          to: `channel:${presenceEvent.channelId}`,
          accountId: this.params.accountId,
        },
      });
    } finally {
      if (!burstCommitted) {
        this.emissionGate.releaseBurst(data.guild_id, burstReservation);
      }
      if (cooldownReserved && !burstCommitted && this.cooldownStore.lookup(presenceKey) === nowMs) {
        this.cooldownStore.delete(presenceKey);
      }
    }
  }

  private isCurrentGeneration(
    guildId: string,
    gatewayGeneration: number,
    guildGeneration: number,
  ): boolean {
    return (
      gatewayGeneration === this.gatewayGeneration &&
      guildGeneration === (this.guildPresenceState.get(guildId)?.generation ?? 0)
    );
  }

  private recordPresenceBaseline(guildId: string, key: string, status: "offline" | "online"): void {
    const evictedGuildId =
      status === "offline"
        ? this.presenceBaseline.observeOffline(guildId, key)
        : this.presenceBaseline.observeOnline(guildId, key);
    if (!evictedGuildId) {
      return;
    }
    // Only the guild whose authoritative marker was shed loses snapshot-absence evidence.
    const state = this.guildPresenceState.get(evictedGuildId);
    if (state) {
      state.inferUnknownAsNewlyAvailable = false;
    }
  }
}

export class DiscordPresenceGuildCreateListener extends GuildCreateListener {
  constructor(private readonly presenceListener: DiscordPresenceListener) {
    super();
  }

  handle(data: GuildCreateEvent): void {
    this.presenceListener.seedGuildSnapshot(data);
  }
}

export class DiscordPresenceGuildDeleteListener extends GuildDeleteListener {
  constructor(private readonly presenceListener: DiscordPresenceListener) {
    super();
  }

  handle(data: GuildDeleteEvent): void {
    this.presenceListener.invalidateGuild(data.id);
  }
}

export class DiscordPresenceReadyListener extends ReadyListener {
  constructor(private readonly presenceListener: DiscordPresenceListener) {
    super();
  }

  handle(): void {
    this.presenceListener.resetGatewaySession();
  }
}

type ThreadUpdateEvent = Parameters<ThreadUpdateListener["handle"]>[0];

export class DiscordThreadUpdateListener extends ThreadUpdateListener {
  constructor(
    private cfg: OpenClawConfig,
    private accountId: string,
    private logger?: Logger,
  ) {
    super();
  }

  async handle(data: ThreadUpdateEvent) {
    await runDiscordListenerWithSlowLog({
      logger: this.logger,
      listener: this.constructor.name,
      event: this.type,
      run: async () => {
        // Discord only fires THREAD_UPDATE when a field actually changes, so
        // `thread_metadata.archived === true` in this payload means the thread
        // just transitioned to the archived state.
        if (!isThreadArchived(data)) {
          return;
        }
        const threadId = "id" in data && typeof data.id === "string" ? data.id : undefined;
        if (!threadId) {
          return;
        }
        const logger = this.logger ?? discordEventQueueLog;
        const count = await closeDiscordThreadSessions({
          cfg: this.cfg,
          accountId: this.accountId,
          threadId,
        });
        if (count > 0) {
          logger.info("Discord thread archived — reset sessions", { threadId, count });
        }
      },
      onError: (err) => {
        const logger = this.logger ?? discordEventQueueLog;
        logger.error(danger(`discord thread-update handler failed: ${String(err)}`));
      },
    });
  }
}

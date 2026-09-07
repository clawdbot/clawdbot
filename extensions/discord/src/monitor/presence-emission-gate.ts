// Discord plugin module gates presence-event emission after reconnects and during bursts.
const DISCORD_PRESENCE_RECONNECT_SUPPRESS_MS = 5 * 60 * 1000;
const DISCORD_PRESENCE_BURST_LIMIT = 8;
const DISCORD_PRESENCE_BURST_WINDOW_MS = 60 * 1000;

type DiscordPresenceGateConfig = {
  reconnectSuppressSeconds?: number;
  burstLimit?: number;
  burstWindowSeconds?: number;
};

type DiscordPresenceGateOptions = {
  reconnectSuppressMs: number;
  burstLimit: number;
  burstWindowMs: number;
};

export function resolveDiscordPresenceGateOptions(
  config: DiscordPresenceGateConfig | undefined,
): DiscordPresenceGateOptions {
  return {
    reconnectSuppressMs:
      config?.reconnectSuppressSeconds !== undefined
        ? config.reconnectSuppressSeconds * 1000
        : DISCORD_PRESENCE_RECONNECT_SUPPRESS_MS,
    burstLimit: config?.burstLimit ?? DISCORD_PRESENCE_BURST_LIMIT,
    burstWindowMs:
      config?.burstWindowSeconds !== undefined
        ? config.burstWindowSeconds * 1000
        : DISCORD_PRESENCE_BURST_WINDOW_MS,
  };
}

type DiscordPresenceReconnectDecision =
  | { allowed: true }
  | { allowed: false; reason: "reconnect-window"; shouldLog: boolean };

type DiscordPresenceBurstEntry = {
  id: number;
  atMs: number;
  committed: boolean;
};

type DiscordPresenceBurstState = {
  reservations: DiscordPresenceBurstEntry[];
  logged: boolean;
};

type DiscordPresenceBurstReservation = number;

type DiscordPresenceBurstDecision =
  | { allowed: true; reservation: DiscordPresenceBurstReservation }
  | { allowed: false; reason: "burst" | "burst-pending"; shouldLog: boolean };

/**
 * Per-account lifecycle gate for online-presence events. Reconnect state belongs to the Gateway
 * session, while burst state follows the guild-owned configuration that supplies its limits.
 */
export class DiscordPresenceEmissionGate {
  private lastSessionResetAtMs?: number;
  private reconnectLogged = false;
  // Sharing this history across guilds lets one guild's settings prune or consume another's
  // window. Keep each configured guild's rate-limit state and logging episode independent.
  private readonly burstByGuild = new Map<string, DiscordPresenceBurstState>();
  private nextReservationId = 0;

  noteGatewaySessionReset(nowMs: number): void {
    this.lastSessionResetAtMs = nowMs;
    this.reconnectLogged = false;
  }

  evaluateReconnectWindow(
    nowMs: number,
    options: DiscordPresenceGateOptions,
  ): DiscordPresenceReconnectDecision {
    if (
      this.lastSessionResetAtMs !== undefined &&
      options.reconnectSuppressMs > 0 &&
      nowMs - this.lastSessionResetAtMs < options.reconnectSuppressMs
    ) {
      const shouldLog = !this.reconnectLogged;
      this.reconnectLogged = true;
      return { allowed: false, reason: "reconnect-window", shouldLog };
    }
    return { allowed: true };
  }

  reserveBurst(
    guildId: string,
    nowMs: number,
    options: DiscordPresenceGateOptions,
  ): DiscordPresenceBurstDecision {
    const state = this.burstByGuild.get(guildId) ?? { reservations: [], logged: false };
    state.reservations = state.reservations.filter(
      (reservation) => !reservation.committed || nowMs - reservation.atMs < options.burstWindowMs,
    );
    this.burstByGuild.set(guildId, state);
    if (state.reservations.length >= options.burstLimit) {
      const shouldLog = !state.logged;
      state.logged = true;
      const reason = state.reservations.some((reservation) => !reservation.committed)
        ? "burst-pending"
        : "burst";
      return { allowed: false, reason, shouldLog };
    }
    state.logged = false;
    const reservation = { id: this.nextReservationId++, atMs: nowMs, committed: false };
    state.reservations.push(reservation);
    return { allowed: true, reservation: reservation.id };
  }

  commitBurst(guildId: string, reservation: DiscordPresenceBurstReservation, nowMs: number): void {
    const entry = this.burstByGuild
      .get(guildId)
      ?.reservations.find((candidate) => candidate.id === reservation);
    if (!entry) {
      return;
    }
    // Admission reservations cap concurrent Discord lookups. Start the sliding window only when
    // an event is actually queued so slow lookups do not shorten the configured emission window.
    entry.atMs = nowMs;
    entry.committed = true;
  }

  releaseBurst(guildId: string, reservation: DiscordPresenceBurstReservation): void {
    const state = this.burstByGuild.get(guildId);
    if (!state) {
      return;
    }
    state.reservations = state.reservations.filter((candidate) => candidate.id !== reservation);
    if (state.reservations.length === 0 && !state.logged) {
      this.burstByGuild.delete(guildId);
    }
  }
}

import type { VoiceRealtimeSession, VoiceSessionEntry } from "./session.js";

/** Failed startup, promotion, and terminal cleanup stays with the voice manager. */
export class DiscordRealtimeCleanup {
  private readonly pending = new Map<VoiceRealtimeSession, string>();
  private readonly closing = new Set<VoiceRealtimeSession>();

  close(guildId: string, session: VoiceRealtimeSession): void {
    if (this.closing.has(session)) {
      return;
    }
    this.pending.set(session, guildId);
    this.closing.add(session);
    try {
      session.close();
      this.pending.delete(session);
    } finally {
      this.closing.delete(session);
    }
  }

  stopEntry(entry: VoiceSessionEntry, reason: string): void {
    const lifecycle = entry.realtimeLifecycle;
    const errors: unknown[] = [];
    if (lifecycle.status === "starting" || lifecycle.status === "active") {
      try {
        this.close(entry.guildId, lifecycle.instance);
      } catch (error) {
        errors.push(error);
      }
    }
    entry.realtimeLifecycle = { status: "stopped", generation: lifecycle.generation, reason };
    // Buffering resources cannot drain silence padding; terminal teardown must reach Idle now.
    try {
      entry.player.stop(true);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw errors[0];
    }
  }

  stopAll(entries: Iterable<VoiceSessionEntry>): void {
    const errors: unknown[] = [];
    // Retry older failures once; newly failed stops stay pending for the next explicit call.
    try {
      this.retry();
    } catch (error) {
      errors.push(error);
    }
    for (const entry of entries) {
      try {
        entry.stop();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw errors[0];
    }
  }

  retry(guildId?: string): boolean {
    let attempted = false;
    const errors: unknown[] = [];
    for (const [session, ownerGuildId] of this.pending) {
      if (guildId !== undefined && ownerGuildId !== guildId) {
        continue;
      }
      attempted = true;
      try {
        this.close(ownerGuildId, session);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw errors[0];
    }
    return attempted;
  }
}

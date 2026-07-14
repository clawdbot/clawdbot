import {
  GatewayDispatchEvents,
  type APIBaseVoiceState,
  type APIVoiceState,
  type GatewayDispatchPayload,
  type GatewayGuildCreateDispatchData,
  type GatewayGuildDeleteDispatchData,
  type GatewayVoiceStateUpdateDispatchData,
} from "discord-api-types/v10";

export class DiscordGatewayVoiceStateCache {
  private readonly statesByGuild = new Map<string, Map<string, APIVoiceState>>();

  clear(): void {
    this.statesByGuild.clear();
  }

  listVoiceChannelStates(guildId: string, channelId: string): APIVoiceState[] {
    const states = this.statesByGuild.get(guildId);
    if (!states) {
      return [];
    }
    const result: APIVoiceState[] = [];
    for (const state of states.values()) {
      if (state.channel_id === channelId) {
        result.push({ ...state });
      }
    }
    return result;
  }

  apply(payload: GatewayDispatchPayload): void {
    if (payload.t === GatewayDispatchEvents.Ready) {
      // READY starts a fresh session. Its following GUILD_CREATE events rebuild
      // the authoritative voice roster; retaining the old session leaks stale users.
      this.clear();
      return;
    }
    if (payload.t === GatewayDispatchEvents.GuildCreate) {
      const guild = payload.d as GatewayGuildCreateDispatchData;
      if (guild.unavailable) {
        this.statesByGuild.delete(guild.id);
        return;
      }
      const states = new Map<string, APIVoiceState>();
      for (const state of guild.voice_states as APIBaseVoiceState[]) {
        if (state.channel_id) {
          states.set(state.user_id, { ...state, guild_id: guild.id });
        }
      }
      this.statesByGuild.set(guild.id, states);
      return;
    }
    if (payload.t === GatewayDispatchEvents.VoiceStateUpdate) {
      const state = payload.d as GatewayVoiceStateUpdateDispatchData;
      const guildId = state.guild_id?.trim();
      if (!guildId) {
        return;
      }
      const states = this.statesByGuild.get(guildId) ?? new Map<string, APIVoiceState>();
      if (state.channel_id) {
        states.set(state.user_id, { ...state, guild_id: guildId });
      } else {
        states.delete(state.user_id);
      }
      this.statesByGuild.set(guildId, states);
      return;
    }
    if (payload.t === GatewayDispatchEvents.GuildDelete) {
      const guild = payload.d as GatewayGuildDeleteDispatchData;
      this.statesByGuild.delete(guild.id);
    }
  }
}

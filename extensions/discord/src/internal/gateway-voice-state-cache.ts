import {
  GatewayDispatchEvents,
  type APIBaseVoiceState,
  type APIVoiceState,
  type GatewayDispatchPayload,
  type GatewayGuildCreateDispatchData,
  type GatewayGuildDeleteDispatchData,
  type GatewayVoiceStateUpdateDispatchData,
} from "discord-api-types/v10";

export type DiscordGatewayVoiceStateTransition = {
  current: APIVoiceState;
  previous?: APIVoiceState;
};

export class DiscordGatewayVoiceStateCache {
  private readonly statesByGuild = new Map<string, Map<string, APIVoiceState>>();
  private transitionsByState = new WeakMap<object, DiscordGatewayVoiceStateTransition>();

  clear(): void {
    this.statesByGuild.clear();
    this.transitionsByState = new WeakMap();
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

  takeTransition(state: APIVoiceState): DiscordGatewayVoiceStateTransition | null {
    const transition = this.transitionsByState.get(state);
    if (!transition) {
      return null;
    }
    this.transitionsByState.delete(state);
    return {
      current: { ...transition.current },
      ...(transition.previous ? { previous: { ...transition.previous } } : {}),
    };
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
      const membersByUserId = new Map(
        (guild.members ?? []).map((member) => [member.user.id, member] as const),
      );
      for (const state of guild.voice_states as APIBaseVoiceState[]) {
        if (state.channel_id) {
          const member = state.member ?? membersByUserId.get(state.user_id);
          states.set(state.user_id, {
            ...state,
            ...(member ? { member } : {}),
            guild_id: guild.id,
          });
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
      const previous = states.get(state.user_id);
      // Discord may omit member metadata from a later state update. Keep the
      // snapshot identity so participant labels and human/bot policy stay stable.
      const current = {
        ...state,
        ...(state.member ? {} : previous?.member ? { member: previous.member } : {}),
        guild_id: guildId,
      };
      this.transitionsByState.set(state, {
        current,
        ...(previous ? { previous: { ...previous } } : {}),
      });
      if (state.channel_id) {
        states.set(state.user_id, current);
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

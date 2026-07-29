// Discord plugin module wires Gateway lifecycle events into the voice manager.
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  type APIVoiceState,
  type Client,
  GatewayDispatchEvents,
  type GatewayGuildCreateDispatchData,
  ReadyListener,
  ResumedListener,
  VoiceStateUpdateListener,
} from "../internal/discord.js";
import type { GatewayPlugin } from "../internal/gateway.js";

const logger = createSubsystemLogger("discord/voice");

// Keep this leaf contract structural so manager.ts can re-export listeners without a cycle.
type DiscordVoiceListenerManager = {
  autoJoin: () => Promise<unknown>;
  refreshGuildRoster: (guildId: string) => void;
  handleVoiceStateUpdate: (
    state: APIVoiceState,
    previousState?: APIVoiceState | null,
  ) => Promise<void>;
};

function startAutoJoin(manager: Pick<DiscordVoiceListenerManager, "autoJoin">) {
  void manager
    .autoJoin()
    .catch((err: unknown) =>
      logger.warn(`discord voice: autoJoin failed: ${formatErrorMessage(err)}`),
    );
}

export class DiscordVoiceReadyListener extends ReadyListener {
  constructor(private manager: DiscordVoiceListenerManager) {
    super();
  }

  async handle(_data: unknown, _client: Client): Promise<void> {
    startAutoJoin(this.manager);
  }
}

export class DiscordVoiceResumedListener extends ResumedListener {
  constructor(private manager: DiscordVoiceListenerManager) {
    super();
  }

  async handle(_data: unknown, _client: Client): Promise<void> {
    startAutoJoin(this.manager);
  }
}

export class DiscordVoiceGuildCreateListener {
  readonly type = GatewayDispatchEvents.GuildCreate;

  constructor(private manager: DiscordVoiceListenerManager) {}

  async handle(data: GatewayGuildCreateDispatchData, _client: Client): Promise<void> {
    if (!data.unavailable) {
      this.manager.refreshGuildRoster(data.id);
    }
  }
}

export class DiscordVoiceStateUpdateListener extends VoiceStateUpdateListener {
  constructor(private manager: DiscordVoiceListenerManager) {
    super();
  }

  async handle(data: APIVoiceState, client: Client): Promise<void> {
    const transition = client.getPlugin<GatewayPlugin>("gateway")?.takeVoiceStateTransition(data);
    await this.manager.handleVoiceStateUpdate(
      data,
      transition ? (transition.previous ?? null) : undefined,
    );
  }
}

import type {
  DiscordGatewayAdapterCreator,
  DiscordGatewayAdapterLibraryMethods,
} from "@discordjs/voice";
import type { GatewaySendPayload } from "discord-api-types/v10";
import { Plugin, type Client } from "./client.js";
import type { GatewayPlugin } from "./gateway.js";

export class VoicePlugin extends Plugin {
  readonly id = "voice";
  protected client?: Client;
  readonly adapters = new Map<string, DiscordGatewayAdapterLibraryMethods>();
  private gatewayPlugin?: GatewayPlugin;

  registerClient(client: Client): void {
    this.client = client;
    this.gatewayPlugin = client.getPlugin<GatewayPlugin>("gateway");
    if (!this.gatewayPlugin) {
      throw new Error("Discord voice cannot be used without a gateway connection.");
    }
  }

  getGateway(_guildId: string): GatewayPlugin | undefined {
    return this.gatewayPlugin;
  }

  getGatewayAdapterCreator(guildId: string): DiscordGatewayAdapterCreator {
    const gateway = this.getGateway(guildId);
    if (!gateway) {
      throw new Error("Discord voice cannot be used without a gateway connection.");
    }
    return (methods) => {
      this.adapters.set(guildId, methods);
      return {
        sendPayload(payload) {
          try {
            gateway.send(payload as GatewaySendPayload, true);
            return true;
          } catch {
            return false;
          }
        },
        destroy: () => {
          this.adapters.delete(guildId);
        },
      };
    };
  }
}

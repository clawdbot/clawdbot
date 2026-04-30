import type { APIApplicationCommand, APIInteraction } from "discord-api-types/v10";
import { DiscordCommandDeployer, type DeployCommandOptions } from "./command-deploy.js";
import type { BaseCommand } from "./commands.js";
import { BaseMessageInteractiveComponent, parseCustomId, type Modal } from "./components.js";
import { DiscordEntityCache } from "./entity-cache.js";
import { DiscordEventQueue, type DiscordEventQueueOptions } from "./event-queue.js";
import { dispatchInteraction } from "./interaction-dispatch.js";
import { RequestClient, type RequestClientOptions } from "./rest.js";
import type { Guild, GuildMember, User } from "./structures.js";

export interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: `/${string}`;
  handler(req: Request, ctx?: Context): Response | Promise<Response>;
  protected?: boolean;
  disabled?: boolean;
}

export interface Context {
  waitUntil?(promise: Promise<unknown>): void;
  env?: unknown;
}

export abstract class Plugin {
  abstract readonly id: string;
  registerClient?(client: Client): Promise<void> | void;
  registerRoutes?(client: Client): Promise<void> | void;
  onRequest?(req: Request, ctx: Context): Promise<Response | undefined> | Response | undefined;
}

export type AnyListener = {
  type: string;
  handle(data: unknown, client: Client): Promise<void> | void;
};

export interface ClientOptions {
  baseUrl: string;
  clientId: string;
  deploySecret?: string;
  publicKey: string | string[];
  token: string;
  requestOptions?: RequestClientOptions;
  autoDeploy?: boolean;
  disableDeployRoute?: boolean;
  disableInteractionsRoute?: boolean;
  disableEventsRoute?: boolean;
  devGuilds?: string[];
  eventQueue?: DiscordEventQueueOptions;
  restCacheTtlMs?: number;
}

export class ComponentRegistry<
  T extends { customId: string; customIdParser?: typeof parseCustomId; type?: number },
> {
  private entries = new Map<string, T[]>();
  private wildcardEntries: T[] = [];

  register(entry: T): void {
    const key = parseRegistryKey(entry.customId, entry.customIdParser);
    if (key === "*") {
      if (!this.wildcardEntries.includes(entry)) {
        this.wildcardEntries.push(entry);
      }
      return;
    }
    const entries = this.entries.get(key) ?? [];
    if (!entries.includes(entry)) {
      entries.push(entry);
      this.entries.set(key, entries);
    }
  }

  resolve(customId: string, options?: { componentType?: number }): T | undefined {
    for (const entries of this.entries.values()) {
      const match = entries.find((entry) => {
        if (options?.componentType !== undefined && entry.type !== options.componentType) {
          return false;
        }
        const parser = entry.customIdParser ?? parseCustomId;
        return parseRegistryKey(entry.customId, parser) === parseRegistryKey(customId, parser);
      });
      if (match) {
        return match;
      }
    }
    return this.wildcardEntries.find((entry) => {
      if (options?.componentType !== undefined && entry.type !== options.componentType) {
        return false;
      }
      return true;
    });
  }
}

function parseRegistryKey(customId: string, parser: typeof parseCustomId = parseCustomId): string {
  return parser(customId).key;
}

export class Client {
  routes: Route[] = [];
  plugins: Array<{ id: string; plugin: Plugin }> = [];
  options: ClientOptions;
  commands: BaseCommand[];
  listeners: AnyListener[];
  rest: RequestClient;
  componentHandler = new ComponentRegistry<BaseMessageInteractiveComponent>();
  private commandDeployer: DiscordCommandDeployer;
  private entityCache: DiscordEntityCache;
  private eventQueue?: DiscordEventQueue;
  modalHandler = new ComponentRegistry<Modal>();
  shardId?: number;
  totalShards?: number;

  constructor(
    options: ClientOptions,
    handlers: {
      commands?: BaseCommand[];
      listeners?: AnyListener[];
      components?: BaseMessageInteractiveComponent[];
      modals?: Modal[];
    },
    plugins: Plugin[] = [],
  ) {
    if (!options.clientId) {
      throw new Error("Missing Discord application ID");
    }
    if (!options.token) {
      throw new Error("Missing Discord bot token");
    }
    this.options = { ...options, baseUrl: options.baseUrl.replace(/\/+$/, "") };
    this.commands = handlers.commands ?? [];
    this.listeners = handlers.listeners ?? [];
    this.rest = new RequestClient(options.token, options.requestOptions);
    this.eventQueue = this.options.eventQueue
      ? new DiscordEventQueue(this.options.eventQueue)
      : undefined;
    this.entityCache = new DiscordEntityCache({
      client: this,
      rest: () => this.rest,
      ttlMs: this.options.restCacheTtlMs,
    });
    this.commandDeployer = new DiscordCommandDeployer({
      clientId: this.options.clientId,
      commands: this.commands,
      devGuilds: this.options.devGuilds,
      rest: () => this.rest,
    });
    for (const component of handlers.components ?? []) {
      this.componentHandler.register(component);
    }
    for (const command of this.commands) {
      for (const component of command.components ?? []) {
        this.componentHandler.register(component);
      }
    }
    for (const modal of handlers.modals ?? []) {
      this.modalHandler.register(modal);
    }
    for (const plugin of plugins) {
      void plugin.registerClient?.(this);
      void plugin.registerRoutes?.(this);
      this.plugins.push({ id: plugin.id, plugin });
    }
  }

  getPlugin<T = Plugin>(id: string): T | undefined {
    return this.plugins.find((entry) => entry.id === id)?.plugin as T | undefined;
  }

  registerListener(listener: AnyListener): AnyListener {
    if (!this.listeners.includes(listener)) {
      this.listeners.push(listener);
    }
    return listener;
  }

  unregisterListener(listener: AnyListener): boolean {
    const index = this.listeners.indexOf(listener);
    if (index < 0) {
      return false;
    }
    this.listeners.splice(index, 1);
    return true;
  }

  getRuntimeMetrics() {
    return {
      request: this.rest.getSchedulerMetrics(),
      eventQueue: this.eventQueue?.getMetrics(),
    };
  }

  async fetchUser(id: string): Promise<User> {
    return await this.entityCache.fetchUser(id);
  }

  async fetchChannel(id: string) {
    return await this.entityCache.fetchChannel(id);
  }

  async fetchGuild(id: string): Promise<Guild> {
    return await this.entityCache.fetchGuild(id);
  }

  async fetchMember(guildId: string, userId: string): Promise<GuildMember> {
    return await this.entityCache.fetchMember(guildId, userId);
  }

  async getDiscordCommands(): Promise<APIApplicationCommand[]> {
    return await this.commandDeployer.getCommands();
  }

  async deployCommands(options: DeployCommandOptions = {}) {
    return await this.commandDeployer.deploy(options);
  }

  async reconcileCommands() {
    return await this.deployCommands({ mode: "reconcile" });
  }

  async handleInteraction(rawData: APIInteraction, _ctx?: Context): Promise<void> {
    await dispatchInteraction(this, rawData);
  }

  async dispatchGatewayEvent(type: string, data: unknown): Promise<void> {
    this.entityCache.invalidateForGatewayEvent(type, data);
    const listeners = this.listeners.filter((entry) => entry.type === type);
    if (!this.eventQueue) {
      for (const listener of listeners) {
        await listener.handle(data, this);
      }
      return;
    }
    await Promise.all(
      listeners.map((listener) =>
        this.eventQueue!.enqueue({
          eventType: type,
          listenerName: listener.constructor.name || "AnonymousListener",
          run: async () => {
            await listener.handle(data, this);
          },
        }),
      ),
    );
  }
}

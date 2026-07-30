// Discord plugin module implements command deploy behavior.
import { createHash } from "node:crypto";
import { ApplicationCommandType, type APIApplicationCommand } from "discord-api-types/v10";
import type { DiscordCommandDeployHashStore } from "../command-deploy-store.js";
import {
  createApplicationCommand,
  deleteApplicationCommand,
  editApplicationCommand,
  listApplicationCommands,
  overwriteApplicationCommands,
  overwriteGuildApplicationCommands,
} from "./api.js";
import { commandsEqual, stableComparableObject } from "./command-comparison.js";
import type { BaseCommand } from "./commands.js";
import type { RequestClient } from "./rest.js";

export type DeployCommandOptions = {
  mode?: "overwrite" | "reconcile";
  force?: boolean;
};

type SerializedCommand = ReturnType<BaseCommand["serialize"]>;

const DISCORD_APPLICATION_COMMAND_LIMIT_REACHED = 30032;

export class DiscordCommandDeployer {
  private readonly hashes = new Map<string, string>();
  private readonly loadedKeys = new Set<string>();

  constructor(
    private readonly params: {
      clientId: string;
      commands: BaseCommand[];
      devGuilds?: string[];
      hashStore?: DiscordCommandDeployHashStore;
      rest: () => RequestClient;
    },
  ) {}

  async getCommands(): Promise<APIApplicationCommand[]> {
    return await listApplicationCommands(this.rest, this.params.clientId);
  }

  async deploy(options: DeployCommandOptions = {}) {
    const commands = this.params.commands.filter((command) => command.name !== "*");
    const globalCommands = commands.filter((command) => !command.guildIds);
    const serializedGlobal = globalCommands.map((command) => command.serialize());
    for (const [guildId, entries] of groupGuildCommands(commands)) {
      await this.putCommandSetIfChanged(
        this.scopedCacheKey(`guild:${guildId}`),
        entries,
        async () => {
          await overwriteGuildApplicationCommands(
            this.rest,
            this.params.clientId,
            guildId,
            entries,
          );
        },
        options,
      );
    }
    if (this.params.devGuilds?.length) {
      for (const guildId of this.params.devGuilds) {
        const entries = commands.map((command) => command.serialize());
        await this.putCommandSetIfChanged(
          this.scopedCacheKey(`dev-guild:${guildId}`),
          entries,
          async () => {
            await overwriteGuildApplicationCommands(
              this.rest,
              this.params.clientId,
              guildId,
              entries,
            );
          },
          options,
        );
      }
      return { mode: options.mode ?? "reconcile", usedDevGuilds: true };
    }
    if (options.mode !== "overwrite") {
      await this.putCommandSetIfChanged(
        this.scopedCacheKey("global:reconcile"),
        serializedGlobal,
        async () => {
          await this.reconcileGlobalCommands(serializedGlobal);
        },
        options,
      );
      return { mode: "reconcile" as const, usedDevGuilds: false };
    }
    await this.putCommandSetIfChanged(
      this.scopedCacheKey("global:overwrite"),
      serializedGlobal,
      async () => {
        await overwriteApplicationCommands(this.rest, this.params.clientId, serializedGlobal);
      },
      options,
    );
    return { mode: "overwrite" as const, usedDevGuilds: false };
  }

  /**
   * Scope cache keys by Discord application id so multi-bot setups that share a
   * single command-deploy store still reconcile each application separately. The
   * prior unscoped `global:reconcile` / `guild:<id>` keys let a later account
   * with an identical command set reuse the first account's hash and skip its
   * own application's reconcile entirely (#77359).
   */
  private scopedCacheKey(suffix: string): string {
    return `app:${this.params.clientId}:${suffix}`;
  }

  private async reconcileGlobalCommands(desired: SerializedCommand[]) {
    const existing = await this.getCommands();
    const existingByKey = new Map(existing.map((command) => [stableCommandKey(command), command]));
    const desiredCommands = desired.map((command) => ({
      command,
      key: stableCommandKey(command as APIApplicationCommand),
    }));
    const desiredKeys = new Set(desiredCommands.map(({ key }) => key));
    for (const { command, key } of desiredCommands) {
      const current = existingByKey.get(key);
      if (current && !commandsEqual(current, command)) {
        await editApplicationCommand(this.rest, this.params.clientId, current.id, command);
      }
    }
    for (const { command, key } of desiredCommands) {
      if (existingByKey.has(key)) {
        continue;
      }
      try {
        await createApplicationCommand(this.rest, this.params.clientId, command);
      } catch (error) {
        if (!isApplicationCommandLimitError(error)) {
          throw error;
        }
        // Reconcile cannot create before deleting at Discord's hard cap. Bulk
        // overwrite replaces the complete set without an unsafe delete gap.
        await overwriteApplicationCommands(this.rest, this.params.clientId, desired);
        return;
      }
    }
    for (const command of existing) {
      if (!desiredKeys.has(stableCommandKey(command))) {
        await deleteApplicationCommand(this.rest, this.params.clientId, command.id);
      }
    }
  }

  private async putCommandSetIfChanged(
    key: string,
    commands: SerializedCommand[],
    deploy: () => Promise<void>,
    options: { force?: boolean },
  ): Promise<void> {
    const hash = stableCommandSetHash(commands);
    await this.loadPersistedHash(key);
    if (!options.force && this.hashes.get(key) === hash) {
      return;
    }
    await deploy();
    this.hashes.set(key, hash);
    try {
      await this.params.hashStore?.register(key, hash);
    } catch {
      // Cache persistence must not turn a successful Discord deploy into a startup failure.
    }
  }

  private async loadPersistedHash(key: string): Promise<void> {
    if (this.loadedKeys.has(key)) {
      return;
    }
    this.loadedKeys.add(key);
    try {
      const hash = await this.params.hashStore?.lookup(key);
      if (typeof hash === "string" && hash.trim()) {
        this.hashes.set(key, hash);
      }
    } catch {
      // Cache lookup failure is a miss. Reconcile repairs the canonical row after success.
    }
  }

  private get rest(): RequestClient {
    return this.params.rest();
  }
}

function groupGuildCommands(commands: BaseCommand[]): Map<string, SerializedCommand[]> {
  const guildCommands = new Map<string, SerializedCommand[]>();
  for (const command of commands.filter((entry) => entry.guildIds)) {
    for (const guildId of command.guildIds ?? []) {
      const entries = guildCommands.get(guildId) ?? [];
      entries.push(command.serialize());
      guildCommands.set(guildId, entries);
    }
  }
  return guildCommands;
}

function stableCommandKey(command: Pick<APIApplicationCommand, "name" | "type">) {
  return `${command.type ?? ApplicationCommandType.ChatInput}:${command.name}`;
}

function isApplicationCommandLimitError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "discordCode" in error &&
    error.discordCode === DISCORD_APPLICATION_COMMAND_LIMIT_REACHED
  );
}

function stableCommandSetHash(commands: SerializedCommand[]): string {
  const stable = commands
    .map((command) => stableComparableObject(command))
    .toSorted((a, b) =>
      stableCommandKey(a as APIApplicationCommand).localeCompare(
        stableCommandKey(b as APIApplicationCommand),
      ),
    );
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

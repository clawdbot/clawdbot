import { createHash } from "node:crypto";
import { ApplicationCommandType, type APIApplicationCommand } from "discord-api-types/v10";
import {
  createApplicationCommand,
  deleteApplicationCommand,
  editApplicationCommand,
  listApplicationCommands,
  overwriteApplicationCommands,
  overwriteGuildApplicationCommands,
} from "./api.js";
import type { BaseCommand } from "./commands.js";
import type { RequestClient } from "./rest.js";

export type DeployCommandOptions = {
  mode?: "overwrite" | "reconcile";
  force?: boolean;
};

type SerializedCommand = ReturnType<BaseCommand["serialize"]>;

export class DiscordCommandDeployer {
  private readonly hashes = new Map<string, string>();

  constructor(
    private readonly params: {
      clientId: string;
      commands: BaseCommand[];
      devGuilds?: string[];
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
        `guild:${guildId}`,
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
          `dev-guild:${guildId}`,
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
        "global:reconcile",
        serializedGlobal,
        async () => {
          await this.reconcileGlobalCommands(serializedGlobal);
        },
        options,
      );
      return { mode: "reconcile" as const, usedDevGuilds: false };
    }
    await this.putCommandSetIfChanged(
      "global:overwrite",
      serializedGlobal,
      async () => {
        await overwriteApplicationCommands(this.rest, this.params.clientId, serializedGlobal);
      },
      options,
    );
    return { mode: "overwrite" as const, usedDevGuilds: false };
  }

  private async reconcileGlobalCommands(desired: SerializedCommand[]) {
    const existing = await this.getCommands();
    const existingByKey = new Map(existing.map((command) => [stableCommandKey(command), command]));
    const desiredKeys = new Set<string>();
    for (const command of desired) {
      const key = stableCommandKey(command as APIApplicationCommand);
      desiredKeys.add(key);
      const current = existingByKey.get(key);
      if (!current) {
        await createApplicationCommand(this.rest, this.params.clientId, command);
        continue;
      }
      if (!commandsEqual(current, command)) {
        await editApplicationCommand(this.rest, this.params.clientId, current.id, command);
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
    if (!options.force && this.hashes.get(key) === hash) {
      return;
    }
    await deploy();
    this.hashes.set(key, hash);
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

function comparableCommand(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  const omit = new Set([
    "id",
    "application_id",
    "guild_id",
    "version",
    "default_permission",
    "nsfw",
  ]);
  return stableComparableObject(
    Object.fromEntries(
      Object.entries(value).filter(([key, entry]) => !omit.has(key) && entry !== undefined),
    ),
  );
}

function stableComparableObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableComparableObject(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, stableComparableObject(entry)]),
  );
}

function commandsEqual(a: unknown, b: unknown) {
  return JSON.stringify(comparableCommand(a)) === JSON.stringify(comparableCommand(b));
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

// Discord plugin module implements command deploy behavior.
import { createHash } from "node:crypto";
import path from "node:path";
import { ApplicationCommandType, type APIApplicationCommand } from "discord-api-types/v10";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
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

const DISCORD_APPLICATION_COMMAND_LIMIT_REACHED = 30032;

/**
 * Per-`command-deploy-cache.json` path async mutex. `server-channels.ts` can
 * start several Discord deployers concurrently in the same Node.js process;
 * each one shares the same on-disk cache file. Without this lock, two
 * deployers can run `persistHashes` in parallel, both read the same on-disk
 * snapshot before either writes, and the later `rename` then overwrites the
 * earlier writer's entries — defeating the rate-limit cache.
 *
 * This is an in-process lock; cross-process serialization would need an OS
 * file lock. Discord deployers only run inside the gateway process, so an
 * in-process mutex is sufficient for the documented concurrency surface.
 */
const cachePersistLocks = new KeyedAsyncQueue();

async function withCachePersistLock<T>(storePath: string, fn: () => Promise<T>): Promise<T> {
  return await cachePersistLocks.enqueue(storePath, fn);
}

export class DiscordCommandDeployer {
  private readonly hashes = new Map<string, string>();
  private readonly pendingHashes = new Map<string, string>();
  private hashesLoaded = false;

  constructor(
    private readonly params: {
      clientId: string;
      commands: BaseCommand[];
      devGuilds?: string[];
      hashStorePath?: string;
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
   * single deploy-cache file still reconcile each application separately. The
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
    await this.loadPersistedHashes();
    if (!options.force && this.hashes.get(key) === hash) {
      return;
    }
    await deploy();
    this.hashes.set(key, hash);
    this.pendingHashes.set(key, hash);
    await this.persistHashes();
  }

  private async loadPersistedHashes(): Promise<void> {
    if (this.hashesLoaded) {
      return;
    }
    this.hashesLoaded = true;
    const storePath = this.params.hashStorePath;
    if (!storePath) {
      return;
    }
    try {
      const parsed = await privateFileStore(path.dirname(storePath)).readJsonIfExists<{
        hashes?: unknown;
      }>(path.basename(storePath));
      if (!parsed?.hashes || typeof parsed.hashes !== "object") {
        return;
      }
      for (const [key, value] of Object.entries(parsed.hashes)) {
        if (typeof value === "string" && key.trim() && value.trim()) {
          this.hashes.set(key, value);
        }
      }
    } catch {
      // Best-effort cache only. A corrupt or missing file should never block startup.
    }
  }

  private async persistHashes(): Promise<void> {
    const storePath = this.params.hashStorePath;
    if (!storePath) {
      return;
    }
    // Serialize concurrent persists for the same on-disk path. The earlier
    // "re-read inside persistHashes" merge alone is not enough — two
    // deployers running `persistHashes` in true parallel would both read the
    // same snapshot before either writes, and the later `rename` would still
    // overwrite the earlier one's `app:<id>:...` entries. The mutex makes the
    // read-merge-write cycle atomic for in-process callers.
    await withCachePersistLock(storePath, async () => {
      await this.persistHashesLocked(storePath);
    });
  }

  private async persistHashesLocked(storePath: string): Promise<void> {
    try {
      // Re-read the on-disk hashes immediately before writing and merge only
      // keys this deployer changed. Previously loaded hashes can be stale when
      // sibling deployers update the same file, so on-disk wins for untouched
      // keys while pending keys win because this deployer just produced them.
      const storeFile = path.basename(storePath);
      const fileStore = privateFileStore(path.dirname(storePath));
      const merged = new Map<string, string>();
      let onDisk: { hashes?: unknown } | null = null;
      try {
        onDisk = await fileStore.readJsonIfExists<{
          hashes?: unknown;
        }>(storeFile);
      } catch {
        // A corrupt cache should not become permanent. Treat the re-read as
        // empty and replace it with the fresh pending hashes after deploy.
      }
      if (onDisk?.hashes && typeof onDisk.hashes === "object") {
        for (const [key, value] of Object.entries(onDisk.hashes)) {
          if (typeof value === "string" && key.trim() && value.trim()) {
            merged.set(key, value);
          }
        }
      }
      for (const [key, value] of this.pendingHashes.entries()) {
        merged.set(key, value);
      }
      await fileStore.writeJson(
        storeFile,
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          hashes: Object.fromEntries(
            [...merged.entries()].toSorted(([left], [right]) => left.localeCompare(right)),
          ),
        },
        { trailingNewline: true },
      );
      // Refresh in-memory state so future writes from the same deployer also
      // see entries that other deployers added concurrently.
      for (const [key, value] of merged.entries()) {
        this.hashes.set(key, value);
      }
      this.pendingHashes.clear();
    } catch {
      // The cache is only an optimization to avoid redundant Discord writes.
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

function comparableCommand(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  const omit = new Set([
    "application_id",
    "description_localized",
    "dm_permission",
    "guild_id",
    "id",
    "name_localized",
    "nsfw",
    "version",
    "default_permission",
  ]);
  return stableComparableObject(
    Object.fromEntries(
      Object.entries(value).filter(([key, entry]) => !omit.has(key) && entry !== undefined),
    ),
  );
}

const unorderedCommandArrayFields = new Set(["channel_types", "contexts", "integration_types"]);
const optionComparisonOmittedFields = new Set([
  "contexts",
  "default_member_permissions",
  "description_localized",
  "integration_types",
  "name_localized",
]);
const nullableLocalizationFields = new Set(["description_localizations", "name_localizations"]);

function stableComparableObject(value: unknown, pathValue: string[] = []): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => stableComparableObject(entry, pathValue));
    const key = pathValue.at(-1);
    if (
      key &&
      unorderedCommandArrayFields.has(key) &&
      normalized.every(
        (entry) =>
          typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean",
      )
    ) {
      return normalized.toSorted((left, right) => String(left).localeCompare(String(right)));
    }
    return normalized;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, entry]) => {
        if (entry === undefined) {
          return false;
        }
        if (entry === null && nullableLocalizationFields.has(key)) {
          return false;
        }
        if (pathValue.includes("options") && optionComparisonOmittedFields.has(key)) {
          return false;
        }
        if ((key === "required" || key === "autocomplete") && entry === false) {
          return false;
        }
        return true;
      })
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [
        key,
        shouldNormalizeDescriptionValue(pathValue, key, entry)
          ? normalizeDescriptionForComparison(entry)
          : stableComparableObject(entry, [...pathValue, key]),
      ]),
  );
}

function shouldNormalizeDescriptionValue(
  pathLocal: string[],
  key: string,
  entry: unknown,
): entry is string {
  return (
    typeof entry === "string" &&
    (key === "description" || pathLocal.at(-1) === "description_localizations")
  );
}

/**
 * Normalize a Discord command description for equality comparison.
 *
 * Discord's server-side storage performs two transformations that our local
 * desired descriptors do not:
 *
 * 1. Consecutive whitespace (including `\n`) is collapsed to a single space.
 * 2. Whitespace between two CJK (Chinese, Japanese, Korean) characters is
 *    removed entirely. So a local description `"第一行。\n第二行。"` is stored
 *    as `"第一行。第二行。"` on Discord and returned without the `\n`.
 *
 * Without this normalization every startup for any CJK-heavy deployment reads
 * back Discord's collapsed form, computes a diff against the local `\n`-form,
 * decides the command needs updating, and issues a `PATCH`. Under the global
 * per-application rate limit this quickly produces 429 bursts and some
 * commands silently fail to register (see the Discord deploy 429 reports).
 *
 * Applying the same transformation to both sides before comparison makes the
 * equality check match Discord's storage semantics and prevents spurious
 * reconcile writes on every startup.
 */
function normalizeDescriptionForComparison(description: string): string {
  const collapsed = description.replace(/\s+/g, " ");
  // Matches whitespace surrounded by CJK code points. Run twice because a
  // single `replace` consumes the boundary characters, which can leave
  // adjacent matches (e.g. "字 字 字") partially unhandled.
  const cjkBoundaryWhitespace =
    /([\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF])\s+([\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF])/g;
  return collapsed
    .replace(cjkBoundaryWhitespace, "$1$2")
    .replace(cjkBoundaryWhitespace, "$1$2")
    .trim();
}

function commandsEqual(a: unknown, b: unknown) {
  return JSON.stringify(comparableCommand(a)) === JSON.stringify(comparableCommand(b));
}

export const testing = {
  commandsEqual,
  comparableCommand,
  normalizeDescriptionForComparison,
} as const;

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

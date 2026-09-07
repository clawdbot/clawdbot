import { z } from "zod";
import type { DiscordMessage, DiscordSource, SourceRuntime, SourceStatus } from "../../types.js";
import { checkAbort, createResponseParser } from "../http.js";
import { ABORT_LABEL, createClient, DiscordHttpError } from "./client.js";

const snowflake = z.string().regex(/^\d{1,20}$/);
const channelSchema = z.object({
  id: snowflake,
  name: z.string().nullish(),
  parent_id: snowflake.nullish(),
  type: z.number().optional(),
});
const archiveSchema = channelSchema.extend({
  thread_metadata: z.object({
    archive_timestamp: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  }),
});
const messagesSchema = z.array(
  z.object({
    id: snowflake,
    content: z.string(),
    author: z.object({ id: snowflake, bot: z.boolean().optional() }),
  }),
);
const activeSchema = z.object({ threads: z.array(channelSchema) });
const archivesSchema = z.object({ threads: z.array(archiveSchema), has_more: z.boolean() });
const epochMs = 1420070400000n;

type Channel = z.infer<typeof channelSchema>;
type Target = { id: string; parentId: string; name: string };

const parse = createResponseParser(
  () => new Error("Discord returned an unexpected response shape."),
);

export function createDiscordSource(runtime: SourceRuntime): DiscordSource {
  return {
    async collect(config, window) {
      const status: SourceStatus = {
        ok: true,
        warnings: [],
        stats: { apiCalls: 0, channelsScanned: 0, threadsScanned: 0, privateArchivesSkipped: 0 },
      };
      const collected = new Map<string, DiscordMessage>();
      const warn = (scope: string, error: unknown) => {
        checkAbort(runtime.signal, ABORT_LABEL);
        const detail = error instanceof Error ? error.message : "Discord collection failed.";
        const warning = `${scope}: ${detail}`;
        status.warnings.push(
          config.token ? warning.replaceAll(config.token, "[redacted]") : warning,
        );
        status.stale = true;
      };
      checkAbort(runtime.signal, ABORT_LABEL);
      const client = createClient(config, runtime, status);
      const channels = new Map<string, Channel>();
      try {
        for (const channel of parse(
          z.array(channelSchema),
          await client.get(`/guilds/${encodeURIComponent(config.guildId)}/channels`),
        )) {
          channels.set(channel.id, channel);
        }
      } catch (error) {
        warn("Discord guild channels", error);
        status.ok = false;
      }

      const configured = new Set(config.channels.map((channel) => channel.id));
      const targets = new Map<string, Target>();
      for (const id of configured) {
        const channel = channels.get(id);
        // Forum/media/category channels contain threads but have no message history of their own.
        if (channel?.type !== 15 && channel?.type !== 16 && channel?.type !== 4) {
          targets.set(id, { id, parentId: id, name: channel?.name || id });
        }
      }
      const addThread = (thread: Channel) => {
        if (thread.parent_id && configured.has(thread.parent_id)) {
          const parentName = channels.get(thread.parent_id)?.name || thread.parent_id;
          targets.set(thread.id, {
            id: thread.id,
            parentId: thread.parent_id,
            name: `${parentName}/${thread.name || thread.id}`,
          });
        }
      };
      try {
        const active = parse(
          activeSchema,
          await client.get(`/guilds/${encodeURIComponent(config.guildId)}/threads/active`),
        );
        active.threads.forEach(addThread);
      } catch (error) {
        warn("Discord active threads", error);
      }

      const collectArchives = async (path: string, order: "timestamp" | "id" = "timestamp") => {
        let before: string | undefined;
        while (true) {
          checkAbort(runtime.signal, ABORT_LABEL);
          const page = parse(
            archivesSchema,
            await client.get(path, { limit: "100", ...(before ? { before } : {}) }),
          );
          let oldestMs = Infinity;
          let oldestId: string | undefined;
          for (const thread of page.threads) {
            const archivedMs = Date.parse(thread.thread_metadata.archive_timestamp);
            oldestMs = Math.min(oldestMs, archivedMs);
            if (!oldestId || BigInt(thread.id) < BigInt(oldestId)) {
              oldestId = thread.id;
            }
            if (archivedMs >= window.sinceMs) {
              addThread(thread);
            }
          }
          // Joined archives sort by creation ID, so an older thread can still have recent activity.
          if (
            !page.has_more ||
            !oldestId ||
            (order === "timestamp" && oldestMs <= window.sinceMs)
          ) {
            break;
          }
          if (
            before &&
            (order === "id" ? BigInt(oldestId) >= BigInt(before) : oldestMs >= Date.parse(before))
          ) {
            throw new Error("Discord archived-thread pagination did not advance.");
          }
          before = order === "id" ? oldestId : new Date(oldestMs).toISOString();
        }
      };
      for (const id of configured) {
        const channelPath = `/channels/${encodeURIComponent(id)}`;
        try {
          await collectArchives(`${channelPath}/threads/archived/public`);
        } catch (error) {
          warn(`Discord archived threads for channel ${id}`, error);
        }
        try {
          try {
            await collectArchives(`${channelPath}/threads/archived/private`);
          } catch (error) {
            if (!(error instanceof DiscordHttpError) || error.status !== 403) {
              throw error;
            }
            await collectArchives(`${channelPath}/users/@me/threads/archived/private`, "id");
          }
        } catch (error) {
          if (error instanceof DiscordHttpError && error.status === 403) {
            status.stats.privateArchivesSkipped = Number(status.stats.privateArchivesSkipped) + 1;
          } else {
            warn(`Discord private archived threads for channel ${id}`, error);
          }
        }
      }

      const channelCount = [...targets.values()].filter(
        (target) => target.id === target.parentId,
      ).length;
      runtime.logger.info(
        `team-reports: Discord channels/threads listed: ${channelCount} channels, ${targets.size - channelCount} threads`,
      );
      for (const target of targets.values()) {
        let after = ((BigInt(window.sinceMs) - epochMs) << 22n).toString();
        try {
          while (true) {
            checkAbort(runtime.signal, ABORT_LABEL);
            const page = parse(
              messagesSchema,
              await client.get(`/channels/${encodeURIComponent(target.id)}/messages`, {
                limit: "100",
                after,
              }),
            );
            if (page.length === 0) {
              break;
            }
            // Discord returns newest first even when selecting messages after a cursor.
            page.sort((left, right) => (BigInt(left.id) < BigInt(right.id) ? -1 : 1));
            let crossedEnd = false;
            let newest = BigInt(after);
            for (const entry of page) {
              const id = BigInt(entry.id);
              newest = id > newest ? id : newest;
              const atMs = Number((id >> 22n) + epochMs);
              if (atMs >= window.untilMs) {
                crossedEnd = true;
              }
              const content = entry.content.trim();
              if (
                id <= BigInt(after) ||
                atMs < window.sinceMs ||
                atMs >= window.untilMs ||
                entry.author.bot ||
                !content
              ) {
                continue;
              }
              collected.set(entry.id, {
                channelId: target.id,
                parentChannelId: target.parentId,
                channelName: target.name,
                authorId: entry.author.id,
                authorIsBot: false,
                atMs,
                content,
              });
            }
            if (crossedEnd || page.length < 100) {
              break;
            }
            if (newest <= BigInt(after)) {
              throw new Error("Discord message pagination did not advance.");
            }
            after = newest.toString();
          }
          const stat = target.id === target.parentId ? "channelsScanned" : "threadsScanned";
          status.stats[stat] = Number(status.stats[stat]) + 1;
        } catch (error) {
          warn(`Discord messages for channel ${target.id}`, error);
        }
      }
      checkAbort(runtime.signal, ABORT_LABEL);
      const messages = [...collected]
        .toSorted(
          ([leftId, left], [rightId, right]) =>
            left.atMs - right.atMs ||
            left.channelId.localeCompare(right.channelId) ||
            leftId.localeCompare(rightId),
        )
        .map(([, message]) => message);
      runtime.logger.info(
        `team-reports: Discord messages done: ${status.stats.channelsScanned} channels, ${status.stats.threadsScanned} threads, ${messages.length} messages`,
      );
      return { messages, status };
    },
  };
}

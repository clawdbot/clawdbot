import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import { shouldKeepStoreOnlyChildLink } from "./session-utils-core.js";
import {
  listSessionsFromStoreAsync,
  resolveSessionListLineageSqlQuery,
} from "./session-utils-list.js";

/** Mirrors the promoted-column preselection for focused in-memory projection tests. */
export async function listSessionsFromStoreForTest(
  params: Omit<Parameters<typeof listSessionsFromStoreAsync>[0], "sqlSelection">,
) {
  const now = Date.now();
  const agentId = normalizeOptionalString(params.opts.agentId);
  const spawnedBy = normalizeOptionalString(params.opts.spawnedBy);
  const lineage = resolveSessionListLineageSqlQuery(spawnedBy, now);
  const creatorActors = new Map<string, NonNullable<SessionEntry["createdActor"]>>();
  const beforeCreator = Object.entries(params.store).filter(([key, entry]) => {
    if (params.entryFilter && !params.entryFilter(key, entry)) {
      return false;
    }
    if (
      isCronRunSessionKey(key) ||
      (parseAgentSessionKey(key)?.rest === "sessions" && !entry.sessionId && !entry.updatedAt) ||
      (!params.opts.includeGlobal && key === "global") ||
      (!params.opts.includeUnknown && key === "unknown")
    ) {
      return false;
    }
    if (agentId && key !== "global") {
      const parsed = parseAgentSessionKey(key);
      if (!parsed || normalizeAgentId(parsed.agentId) !== normalizeAgentId(agentId)) {
        return false;
      }
    }
    if (params.opts.archived !== "all") {
      const archived = entry.archivedAt !== undefined;
      if (params.opts.archived === true ? !archived : archived) {
        return false;
      }
    }
    if (params.opts.activeMinutes) {
      const cutoff = now - Math.max(1, Math.floor(params.opts.activeMinutes)) * 60_000;
      if (entry.updatedAt < cutoff) {
        return false;
      }
    }
    if (
      params.opts.requireLastInteraction &&
      !(entry.lastInteractionAt && entry.lastInteractionAt > 0)
    ) {
      return false;
    }
    if (params.opts.label && entry.label !== params.opts.label) {
      return false;
    }
    if (spawnedBy) {
      if (lineage.excludeLineageSessionKeys?.includes(key)) {
        if (!lineage.includeLineageSessionKeys?.includes(key)) {
          return false;
        }
      } else if (
        !shouldKeepStoreOnlyChildLink(entry, now) ||
        (entry.spawnedBy !== spawnedBy && entry.parentSessionKey !== spawnedBy)
      ) {
        return false;
      }
    }
    if (entry.createdActor?.id) {
      creatorActors.set(`${entry.createdActor.type}\0${entry.createdActor.id}`, entry.createdActor);
    }
    return true;
  });
  const creatorId = normalizeOptionalString(params.opts.creatorId);
  const selected = creatorId
    ? beforeCreator.filter(([, entry]) => entry.createdActor?.id === creatorId)
    : beforeCreator;
  return await listSessionsFromStoreAsync({
    ...params,
    store: Object.fromEntries(selected),
    sqlSelection: { creatorActors: [...creatorActors.values()], lineage },
  });
}

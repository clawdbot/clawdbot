/** Polls watched adopted sessions for direct upstream human activity. */
import { createHash } from "node:crypto";
import { isEmbeddedAgentRunActive } from "../agents/embedded-agent.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { readRecentUserAssistantTextForSession } from "../config/sessions/transcript.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginRegistryState } from "../plugins/runtime-state.js";
import type { SessionCatalogProvider, SessionUpstreamProbe } from "../plugins/session-catalog.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  recordSessionHumanDirectMessage,
  recordSessionStateEvent,
} from "./session-state-events.js";
import {
  deleteSessionUpstreamLink,
  listWatchedSessionUpstreamLinks,
  readSessionUpstreamLink,
  updateSessionUpstreamLinkMarker,
} from "./session-upstream-links.js";

const SESSION_UPSTREAM_MONITOR_INTERVAL_MS = 60_000;
const SESSION_UPSTREAM_MONITOR_INITIAL_DELAY_MS = 15_000;
const SESSION_UPSTREAM_OWN_USER_TEXT_LIMIT = 10;
const SESSION_UPSTREAM_MISSING_THRESHOLD = 3;

const log = createSubsystemLogger("sessions/upstream-monitor");

type SessionUpstreamMonitorOptions = OpenClawStateDatabaseOptions & {
  providers?: readonly SessionCatalogProvider[];
  now?: () => number;
  loadEntry?: typeof loadSessionEntryReadOnly;
  isRunActive?: typeof isEmbeddedAgentRunActive;
  loadOwnRecentUserTexts?: (params: {
    entry: SessionEntry;
    probe: Omit<SessionUpstreamProbe, "ownRecentUserTexts">;
  }) => Promise<string[]>;
};

type SessionUpstreamMonitor = { stop: () => void };

type SessionUpstreamMissingCounter = {
  count: number;
  linkUpdatedAt: number;
};

function currentProviders(): SessionCatalogProvider[] {
  return (getPluginRegistryState()?.activeRegistry?.sessionCatalogs ?? []).map(
    (registration) => registration.provider,
  );
}

function databaseOptions(options: SessionUpstreamMonitorOptions): OpenClawStateDatabaseOptions {
  return {
    ...(options.env ? { env: options.env } : {}),
    ...(options.path ? { path: options.path } : {}),
  };
}

function normalizeUserText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

// Stable identity of the physical upstream source (host/thread/ref). A re-Continue
// can rebase a session onto a new source whose activity ids (e.g. Claude byte
// offsets) collide with the old source; hashing this into dedupe keys and the CAS
// keeps those from silently deduping genuine new activity or accepting a stale scan.
function upstreamSourceKey(probe: {
  hostId: string;
  threadId: string;
  upstreamRef: unknown;
}): string {
  return createHash("sha256")
    .update(`${probe.hostId}\u0000${probe.threadId}\u0000${JSON.stringify(probe.upstreamRef)}`)
    .digest("hex")
    .slice(0, 16);
}

function upstreamMonitorLinkKey(probe: {
  sessionKey: string;
  agentId: string;
  hostId: string;
  threadId: string;
  upstreamRef: unknown;
}): string {
  return `${probe.sessionKey}\n${probe.agentId}\n${upstreamSourceKey(probe)}`;
}

async function loadOwnRecentUserTexts(
  probe: Omit<SessionUpstreamProbe, "ownRecentUserTexts">,
  entry: SessionEntry,
  options: SessionUpstreamMonitorOptions,
): Promise<string[]> {
  if (options.loadOwnRecentUserTexts) {
    return await options.loadOwnRecentUserTexts({ entry, probe });
  }
  const storePath = resolveSessionStorePathForScope({
    agentId: probe.agentId,
    sessionKey: probe.sessionKey,
    ...(options.env ? { env: options.env } : {}),
  });
  const recent = await readRecentUserAssistantTextForSession({
    agentId: probe.agentId,
    sessionKey: probe.sessionKey,
    storePath,
    limit: SESSION_UPSTREAM_OWN_USER_TEXT_LIMIT,
    preferUpstreamUserText: true,
    role: "user",
  });
  return recent.map((item) => normalizeUserText(item.text)).filter(Boolean);
}

async function probeProvenanceUnchanged(
  probe: SessionUpstreamProbe,
  options: SessionUpstreamMonitorOptions,
): Promise<boolean> {
  const entry = (options.loadEntry ?? loadSessionEntryReadOnly)({
    sessionKey: probe.sessionKey,
    agentId: probe.agentId,
    clone: false,
    ...(options.env ? { env: options.env } : {}),
  });
  if (!entry?.sessionId || (options.isRunActive ?? isEmbeddedAgentRunActive)(entry.sessionId)) {
    return false;
  }
  const current = await loadOwnRecentUserTexts(probe, entry, options);
  return (
    current.length === probe.ownRecentUserTexts.length &&
    current.every((text, index) => text === probe.ownRecentUserTexts[index])
  );
}

async function runSessionUpstreamMonitorTick(
  options: SessionUpstreamMonitorOptions = {},
  missingCounts: Map<string, SessionUpstreamMissingCounter> = new Map(),
): Promise<void> {
  const dbOptions = databaseOptions(options);
  const linksByCatalog = listWatchedSessionUpstreamLinks(dbOptions);
  const watchedLinkKeys = new Set(
    [...linksByCatalog.values()].flatMap((links) => links.map(upstreamMonitorLinkKey)),
  );
  // Monitor-owned counters must follow the watched-link lifecycle or churn would leak keys.
  for (const key of missingCounts.keys()) {
    if (!watchedLinkKeys.has(key)) {
      missingCounts.delete(key);
    }
  }
  const providers = options.providers ?? currentProviders();
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  for (const [catalogId, links] of linksByCatalog) {
    const provider = providerById.get(catalogId);
    if (!provider?.checkUpstreamActivity) {
      continue;
    }
    const probes: SessionUpstreamProbe[] = [];
    for (const link of links) {
      const probe = {
        sessionKey: link.sessionKey,
        agentId: link.agentId,
        threadId: link.threadId,
        hostId: link.hostId,
        upstreamKind: link.upstreamKind,
        upstreamRef: link.upstreamRef,
        marker: link.marker,
      } satisfies Omit<SessionUpstreamProbe, "ownRecentUserTexts">;
      // One corrupt session store must not reject the whole tick; skip that link only.
      try {
        const entry = (options.loadEntry ?? loadSessionEntryReadOnly)({
          sessionKey: probe.sessionKey,
          agentId: probe.agentId,
          clone: false,
          ...(options.env ? { env: options.env } : {}),
        });
        // Active runs may still append upstream user items. Defer the scan so their
        // marker remains available for positive transcript-provenance matching.
        if (
          !entry?.sessionId ||
          (options.isRunActive ?? isEmbeddedAgentRunActive)(entry.sessionId)
        ) {
          continue;
        }
        probes.push({
          ...probe,
          ownRecentUserTexts: await loadOwnRecentUserTexts(probe, entry, options),
        });
      } catch (error) {
        log.warn(`upstream transcript provenance failed for ${probe.sessionKey}: ${String(error)}`);
      }
    }
    if (probes.length === 0) {
      continue;
    }
    const probeBySessionKey = new Map(probes.map((probe) => [probe.sessionKey, probe]));
    const linkUpdatedAtBySessionKey = new Map(
      links.map((link) => [link.sessionKey, link.updatedAt]),
    );
    try {
      const outcomes = await provider.checkUpstreamActivity(probes);
      const missingSessionKeys = new Set(
        outcomes
          .filter((outcome) => outcome.kind === "missing")
          .map((outcome) => outcome.sessionKey),
      );
      for (const probe of probes) {
        if (!missingSessionKeys.has(probe.sessionKey)) {
          missingCounts.delete(upstreamMonitorLinkKey(probe));
        }
      }
      for (const outcome of outcomes) {
        const probe = probeBySessionKey.get(outcome.sessionKey);
        if (!probe) {
          continue;
        }
        const missingCountKey = upstreamMonitorLinkKey(probe);
        if (outcome.kind === "missing") {
          const expectedUpdatedAt = linkUpdatedAtBySessionKey.get(outcome.sessionKey);
          if (expectedUpdatedAt === undefined) {
            missingCounts.delete(missingCountKey);
            continue;
          }
          const previous = missingCounts.get(missingCountKey);
          const missingCount = Math.min(
            SESSION_UPSTREAM_MISSING_THRESHOLD,
            (previous?.linkUpdatedAt === expectedUpdatedAt ? previous.count : 0) + 1,
          );
          missingCounts.set(missingCountKey, {
            count: missingCount,
            linkUpdatedAt: expectedUpdatedAt,
          });
          if (missingCount < SESSION_UPSTREAM_MISSING_THRESHOLD) {
            continue;
          }
          const currentLink = readSessionUpstreamLink(probe.sessionKey, probe.agentId, dbOptions);
          if (
            !currentLink ||
            currentLink.updatedAt !== expectedUpdatedAt ||
            upstreamSourceKey(currentLink) !== upstreamSourceKey(probe)
          ) {
            missingCounts.delete(missingCountKey);
            continue;
          }
          const sourceKey = upstreamSourceKey(probe);
          const recorded = recordSessionStateEvent(
            {
              sessionKey: probe.sessionKey,
              agentId: probe.agentId,
              kind: "upstream_missing",
              actorType: "system",
              dedupeKey: `upstream-missing:${probe.sessionKey}:${sourceKey}:${currentLink.updatedAt}`,
              summary: `upstream missing via ${catalogId}`,
              payload: { channel: catalogId },
            },
            { ...dbOptions, now: (options.now ?? Date.now)() },
          );
          if (!recorded) {
            missingCounts.set(missingCountKey, {
              count: SESSION_UPSTREAM_MISSING_THRESHOLD - 1,
              linkUpdatedAt: expectedUpdatedAt,
            });
            continue;
          }
          deleteSessionUpstreamLink(probe.sessionKey, probe.agentId, dbOptions);
          missingCounts.delete(missingCountKey);
          continue;
        }
        missingCounts.delete(missingCountKey);
        const activity = outcome;
        if (!Number.isSafeInteger(activity.humanTurns) || activity.humanTurns < 0) {
          continue;
        }
        try {
          // A run can start while the provider is scanning. Recheck ownership and
          // provenance before any marker advance so its prompt remains deferred.
          if (!(await probeProvenanceUnchanged(probe, options))) {
            continue;
          }
        } catch (error) {
          log.warn(
            `upstream transcript provenance failed for ${probe.sessionKey}: ${String(error)}`,
          );
          continue;
        }
        // CAS guard AFTER the last await: a Continue can refresh this link (new
        // host/thread/source) while the scan or provenance check was in flight.
        // From here to the record the path is synchronous, so a stale scan can
        // neither record from the old source nor clobber the refreshed marker.
        const expectedUpdatedAt = linkUpdatedAtBySessionKey.get(activity.sessionKey);
        const currentLink = readSessionUpstreamLink(probe.sessionKey, probe.agentId, dbOptions);
        // Compare source identity too: a same-millisecond Continue can refresh the
        // row without changing updated_at, so the timestamp alone is not a reliable
        // optimistic lock.
        if (
          !currentLink ||
          currentLink.updatedAt !== expectedUpdatedAt ||
          upstreamSourceKey({
            hostId: currentLink.hostId,
            threadId: currentLink.threadId,
            upstreamRef: currentLink.upstreamRef,
          }) !== upstreamSourceKey(probe)
        ) {
          continue;
        }
        if (activity.humanTurns === 0) {
          updateSessionUpstreamLinkMarker(probe.sessionKey, probe.agentId, activity.nextMarker, {
            ...dbOptions,
            now: (options.now ?? Date.now)(),
            ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
          });
          continue;
        }
        if (!Number.isFinite(activity.occurredAt) || !activity.dedupeId) {
          continue;
        }
        const recorded = recordSessionHumanDirectMessage(
          {
            sessionKey: probe.sessionKey,
            agentId: probe.agentId,
            actor: { actorType: "human" },
            channel: catalogId,
            dedupeKey: `upstream:${probe.sessionKey}:${upstreamSourceKey(probe)}:${activity.dedupeId}`,
            ...(activity.humanTurns > 1 ? { payload: { turns: activity.humanTurns } } : {}),
            occurredAt: activity.occurredAt as number,
          },
          // Local clock for bookkeeping: upstream occurredAt is event history only
          // and is clamped inside the recorder against this same clock.
          { ...dbOptions, now: (options.now ?? Date.now)() },
        );
        if (!recorded) {
          continue;
        }
        // Commit the scan marker only after the durable event insert/dedupe succeeds.
        updateSessionUpstreamLinkMarker(probe.sessionKey, probe.agentId, activity.nextMarker, {
          ...dbOptions,
          now: (options.now ?? Date.now)(),
          ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
        });
      }
    } catch (error) {
      log.warn(`upstream activity probe failed for ${catalogId}: ${String(error)}`);
    }
  }
}

export function startSessionUpstreamMonitor(
  options: SessionUpstreamMonitorOptions = {},
): SessionUpstreamMonitor {
  let stopped = false;
  let running = false;
  const missingCounts = new Map<string, SessionUpstreamMissingCounter>();
  const run = () => {
    if (stopped || running) {
      return;
    }
    running = true;
    void runSessionUpstreamMonitorTick(options, missingCounts)
      .catch((error: unknown) => {
        log.warn(`upstream monitor tick failed: ${String(error)}`);
      })
      .finally(() => {
        running = false;
      });
  };
  // Session catalogs own this bounded freshness exception; plugin metadata remains restart-stable.
  const initialTimer = setTimeout(run, SESSION_UPSTREAM_MONITOR_INITIAL_DELAY_MS);
  initialTimer.unref?.();
  const interval = setInterval(run, SESSION_UPSTREAM_MONITOR_INTERVAL_MS);
  interval.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearTimeout(initialTimer);
      clearInterval(interval);
    },
  };
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.sessionUpstreamMonitorTestApi")
  ] = { runSessionUpstreamMonitorTick };
}

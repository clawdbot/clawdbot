/** Doctor repair for legacy pre-7.1 boot session entries that block BOOT.md startup. */
import { applySessionEntryLifecycleMutation } from "../config/sessions/session-accessor.lifecycle.js";
import { listSqliteSessionEntriesReadOnly } from "../config/sessions/session-accessor.sqlite.js";
import {
  resolveAllAgentSessionStoreTargetsSync,
  type SessionStoreTarget,
} from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  HealthFinding,
  HealthRepairEffect,
  HealthRepairResult,
} from "../flows/health-checks.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { shortenHomePath } from "../utils.js";

const LEGACY_BOOT_SESSION_CHECK_ID = "core/doctor/legacy-boot-session-state";

type LegacyBootSessionEntry = {
  sessionKey: string;
  agentId: string;
  storePath: string;
  entry: SessionEntry;
};

/**
 * Detects legacy boot entries persisted before the 7.1 lifecycleRevision field.
 * Evidence: sessionKey ends in `:boot`, entry has no lifecycleRevision, and the
 * owning agentId derived from the sessionKey matches.
 */
function isLegacyBootSessionEntry(
  sessionKey: string,
  entry: { lifecycleRevision?: string },
): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return false;
  }
  const keyParts = sessionKey.split(":");
  const suffix = keyParts.slice(2).join(":");
  return suffix === "boot" && !entry.lifecycleRevision;
}

/**
 * Reads all entries from a session store and returns legacy boot entries.
 * Propagates lock errors — an unreadable store must not be reported as clean.
 * listSqliteSessionEntriesReadOnly already returns [] for missing stores,
 * so callers only receive errors for genuine runtime failures (locks, etc.).
 */
function collectLegacyBootSessionEntriesForTarget(
  target: SessionStoreTarget,
  env: NodeJS.ProcessEnv,
): LegacyBootSessionEntry[] {
  const entries = listSqliteSessionEntriesReadOnly({
    agentId: target.agentId,
    storePath: target.storePath,
    env,
  });
  return entries
    .filter(({ sessionKey, entry }) => isLegacyBootSessionEntry(sessionKey, entry))
    .map(({ sessionKey, entry }) => ({
      sessionKey,
      agentId: parseAgentSessionKey(sessionKey)?.agentId ?? target.agentId,
      storePath: target.storePath,
      entry,
    }));
}

function resolveLegacyBootSessionEntries(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): LegacyBootSessionEntry[] {
  const env = params.env ?? process.env;
  const targets = resolveAllAgentSessionStoreTargetsSync(params.cfg, { env });
  const entries: LegacyBootSessionEntry[] = [];
  for (const target of targets) {
    entries.push(...collectLegacyBootSessionEntriesForTarget(target, env));
  }
  return entries;
}

function legacyBootSessionFinding(entry: LegacyBootSessionEntry): HealthFinding {
  return {
    checkId: LEGACY_BOOT_SESSION_CHECK_ID,
    severity: "warning",
    message: `Legacy boot session entry ${entry.sessionKey} lacks lifecycleRevision and can block BOOT.md startup.`,
    path: entry.storePath,
    target: entry.sessionKey,
    fixHint: "Run `openclaw doctor --fix` to remove legacy boot session entries before startup.",
  };
}

/** Detects boot session entries persisted before the 7.1 lifecycleRevision field. */
export function detectLegacyBootSessionEntries(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): HealthFinding[] {
  return resolveLegacyBootSessionEntries(params).map(legacyBootSessionFinding);
}

function groupEntriesByStore(
  entries: readonly LegacyBootSessionEntry[],
): Map<string, LegacyBootSessionEntry[]> {
  const grouped = new Map<string, LegacyBootSessionEntry[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.storePath) ?? [];
    list.push(entry);
    grouped.set(entry.storePath, list);
  }
  return grouped;
}

function formatChange(entry: LegacyBootSessionEntry): string {
  return `Removed legacy boot session entry ${entry.sessionKey} from ${shortenHomePath(
    entry.storePath,
  )}`;
}

/** Removes verified legacy boot session entries. Idempotent: repeated calls are no-ops. */
export async function repairLegacyBootSessionEntries(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
}): Promise<HealthRepairResult> {
  const entries = resolveLegacyBootSessionEntries({ cfg: params.cfg, env: params.env });
  if (entries.length === 0) {
    return { changes: [] };
  }

  const effects: HealthRepairEffect[] = entries.map((entry) => ({
    kind: "state",
    action:
      params.dryRun === true
        ? "would-remove-legacy-boot-session-entry"
        : "remove-legacy-boot-session-entry",
    target: `${entry.storePath}:${entry.sessionKey}`,
    dryRunSafe: false,
  }));

  if (params.dryRun === true) {
    return {
      status: "repaired",
      changes: entries.map((entry) => `Would ${formatChange(entry).toLowerCase()}`),
      effects,
    };
  }

  const changes: string[] = [];
  const warnings: string[] = [];
  const grouped = groupEntriesByStore(entries);

  for (const [storePath, storeEntries] of grouped) {
    try {
      const result = await applySessionEntryLifecycleMutation({
        storePath,
        removals: storeEntries.map((entry) => ({
          sessionKey: entry.sessionKey,
          expectedEntry: entry.entry,
        })),
        activeSessionKey: storeEntries[0]?.sessionKey,
        skipMaintenance: true,
      });
      for (const entry of storeEntries) {
        changes.push(formatChange(entry));
      }
      if (result.archivedTranscriptDirectories.length > 0) {
        warnings.push(
          `Archived ${result.archivedTranscriptDirectories.length} transcript artifact(s) while removing legacy boot entries from ${shortenHomePath(storePath)}`,
        );
      }
    } catch (err) {
      warnings.push(
        `Failed to remove legacy boot entries from ${shortenHomePath(storePath)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return {
    status: warnings.length > 0 && changes.length === 0 ? "failed" : "repaired",
    reason: warnings.length > 0 ? warnings.join("; ") : undefined,
    changes,
    warnings,
    effects,
  };
}

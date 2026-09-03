import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type {
  PluginDoctorStateMigration,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CODEX_APP_SERVER_BINDING_NAMESPACE } from "../app-server/session-binding-meta.js";

const PAGE_SIZE = 512;
const KEY_PREFIXES = ["session-key:", "session:"] as const;

type MigrationParams = Parameters<PluginDoctorStateMigration["migrateLegacyState"]>[0];
type BindingRow = ReturnType<
  NonNullable<PluginDoctorStateMigrationContext["readPluginStateEntriesInKeyRange"]>
>[number];

// Destructive repair recognizes only ordinary session ownership. Runtime parsing tolerates
// optional-field damage; that must not erase supervision or lease uncertainty during repair.
function readBindingCandidate(row: BindingRow, prefix: (typeof KEY_PREFIXES)[number]) {
  const identity = /^([a-z0-9][a-z0-9_-]{0,63}):(.+)$/u.exec(row.key.slice(prefix.length));
  if (!identity) {
    return undefined;
  }
  const agentId = identity[1]!;
  const keyIdentity = identity[2]!;
  const stored = asOptionalRecord(row.value);
  const sessionId = typeof stored?.sessionId === "string" ? stored.sessionId.trim() : "";
  const stable = prefix === "session-key:";
  if (
    !stored ||
    stored.version !== 1 ||
    !sessionId ||
    (stable ? !/^[A-Za-z0-9_-]{43}$/u.test(keyIdentity) : sessionId !== keyIdentity)
  ) {
    return undefined;
  }
  if (stored.state === "cleared") {
    if (stored.binding !== undefined || (stored.retired !== undefined && stored.retired !== true)) {
      return undefined;
    }
  } else if (stored.state === "active") {
    const binding = asOptionalRecord(stored.binding);
    if (
      !binding ||
      typeof binding.threadId !== "string" ||
      !binding.threadId.trim() ||
      typeof binding.cwd !== "string" ||
      binding.connectionScope !== undefined ||
      binding.supervisionSourceThreadId !== undefined ||
      binding.pendingSupervisionBranch !== undefined ||
      stored.retired !== undefined
    ) {
      return undefined;
    }
  } else {
    return undefined;
  }
  if (stored.lease !== undefined) {
    const lease = asOptionalRecord(stored.lease);
    if (
      !lease ||
      typeof lease.token !== "string" ||
      !lease.token.trim() ||
      typeof lease.expiresAt !== "number" ||
      !Number.isFinite(lease.expiresAt) ||
      lease.expiresAt > Date.now()
    ) {
      return undefined;
    }
  }
  return { row, agentId, sessionId, stable };
}

async function* iterateOrphanBindingPages({
  context,
}: MigrationParams): AsyncGenerator<BindingRow[]> {
  const readPage = context.readPluginStateEntriesInKeyRange;
  const readEvidence = context.readSessionIdentityEvidenceBatch;
  if (!readPage || !readEvidence) {
    return;
  }
  for (const prefix of KEY_PREFIXES) {
    let after: string | undefined;
    while (true) {
      const rows = readPage(CODEX_APP_SERVER_BINDING_NAMESPACE, {
        prefix,
        ...(after ? { after } : {}),
        limit: PAGE_SIZE,
      });
      if (rows.length === 0) {
        break;
      }
      after = rows.at(-1)?.key;
      const candidates = rows.flatMap((row) => {
        const candidate = readBindingCandidate(row, prefix);
        return candidate ? [candidate] : [];
      });
      if (candidates.length > 0) {
        const identities = new Map(
          candidates.map(({ agentId, sessionId }) => [
            `${agentId}\0${sessionId}`,
            { agentId, sessionId },
          ]),
        );
        const evidence = new Map(
          (await readEvidence([...identities.values()])).map((owner) => [
            `${owner.agentId}\0${owner.sessionId}`,
            owner,
          ]),
        );
        const stale = candidates
          .filter(({ row, agentId, sessionId, stable }) => {
            const owner = evidence.get(`${agentId}\0${sessionId}`);
            if (!owner || owner.state === "unknown") {
              return false;
            }
            if (owner.state !== "current") {
              return true;
            }
            if (!stable) {
              return false;
            }
            const digest = createHash("sha256").update(owner.sessionKey).digest("base64url");
            return row.key !== `session-key:${agentId}:${digest}`;
          })
          .map(({ row }) => row);
        if (stale.length > 0) {
          yield stale;
        }
      }
      if (rows.length < PAGE_SIZE) {
        break;
      }
      // SQLite work is synchronous; yield so the host's maintenance leases can renew between pages.
      await setImmediate();
    }
  }
}

export const codexOrphanedSessionBindingMigration: PluginDoctorStateMigration = {
  id: "codex-app-server-orphaned-session-bindings",
  label: "Codex app-server orphaned session bindings",
  doctorOnly: true,
  phase: "after-session-repair",
  async detectLegacyState(params) {
    for await (const _ of iterateOrphanBindingPages(params)) {
      return { preview: ["- Codex app-server bindings: remove orphaned session ownership"] };
    }
    return null;
  },
  async migrateLegacyState(params) {
    const remove = params.context.deletePluginStateEntriesIfUnchanged;
    if (!remove) {
      return {
        changes: [],
        warnings: ["Codex session binding repair requires locked SQLite maintenance ownership"],
      };
    }
    let deleted = 0;
    let changed = 0;
    for await (const rows of iterateOrphanBindingPages(params)) {
      const result = remove(CODEX_APP_SERVER_BINDING_NAMESPACE, rows);
      deleted += result.deleted;
      changed += result.changed;
    }
    return {
      changes:
        deleted > 0 ? [`Removed ${deleted} orphaned Codex app-server session binding(s)`] : [],
      warnings:
        changed > 0
          ? [`Preserved ${changed} Codex app-server session binding(s) changed during repair`]
          : [],
    };
  },
};

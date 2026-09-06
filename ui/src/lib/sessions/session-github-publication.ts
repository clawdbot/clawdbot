import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../gateway-methods.ts";
import { GitHubPublicationController } from "./github-publication-controller.ts";
import {
  readSessionChangedEvent,
  reconcileSessionChanged,
  reconcileSessionHistory,
} from "./reconcile.ts";
import type {
  GitHubPublicationBinding,
  SessionCapability,
  SessionConnectionOwner,
  SessionGateway,
} from "./session-capability.ts";
import { isUiGlobalSessionKey, resolveUiConversationIdentity } from "./session-key.ts";

const MAX_RETAINED_PUBLICATIONS = 32;

type Host = {
  connection: SessionConnectionOwner;
  snapshot: () => SessionGateway["snapshot"];
  deletionState: (row: GatewaySessionRow) => ReturnType<SessionCapability["deletionState"]>;
};

function invocationRow(row: GatewaySessionRow): GatewaySessionRow {
  return {
    key: row.key,
    agentId: row.agentId,
    kind: row.kind,
    updatedAt: row.updatedAt,
    sessionId: row.sessionId,
    sharingRole: row.sharingRole,
    visibility: row.visibility,
    archived: row.archived,
  };
}

function authority(row: GatewaySessionRow): string {
  return JSON.stringify([row.sessionId, row.sharingRole, row.visibility, row.archived === true]);
}

function identity(snapshot: SessionGateway["snapshot"]): string {
  return JSON.stringify([
    snapshot.selfUser?.identity ?? null,
    snapshot.hello?.auth?.role,
    snapshot.hello?.auth?.scopes,
    isGatewayMethodAdvertised(snapshot, "sessions.github.publish"),
  ]);
}

/** Admitted operations outlive panes; acknowledgement, rejection or authority retirement releases them. */
export function createSessionGitHubPublication(host: Host) {
  const entries = new Map<string, Entry>();
  type Entry = {
    row: GatewaySessionRow;
    retained: boolean;
    controller: GitHubPublicationController;
    current: () => boolean;
  };
  const keyFor = (row: Pick<GatewaySessionRow, "key" | "agentId">, agentId?: string | null) => {
    const owner = resolveUiConversationIdentity(
      host.snapshot(),
      row.key,
      row.agentId ?? agentId ?? undefined,
    );
    return `${owner.agentId ?? ""}\0${owner.sessionKey}`;
  };
  const retire = (key: string, entry: Entry) => {
    entries.delete(key);
    entry.controller.reset();
  };
  const releaseIdle = (key: string, entry: Entry) => {
    if (!entry.retained && !entry.controller.hasBindings && entries.get(key) === entry) {
      entries.delete(key);
    }
  };
  const reconcile = (
    apply: (row: GatewaySessionRow, key: string) => GatewaySessionRow | undefined,
  ) => {
    for (const [key, entry] of entries) {
      const next = apply(entry.row, key);
      if (!entry.current() || !next || authority(next) !== authority(entry.row)) {
        retire(key, entry);
      } else {
        entry.row = invocationRow(next);
      }
    }
  };
  const snapshotFor = (row: GatewaySessionRow): SessionsListResult => ({
    ts: 0,
    path: "",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [row],
  });
  return {
    attach(row: GatewaySessionRow, changed: () => void): GitHubPublicationBinding | null {
      const connection = host.connection.capture();
      if (!connection) {
        return null;
      }
      const route = resolveUiConversationIdentity(host.snapshot(), row.key, row.agentId);
      const key = `${route.agentId ?? ""}\0${route.sessionKey}`;
      const owner = identity(host.snapshot());
      let entry = entries.get(key);
      if (entry && (!entry.current() || authority(entry.row) !== authority(row))) {
        retire(key, entry);
        entry = undefined;
      }
      if (!entry) {
        const candidate: Entry = {
          // Keep only invocation/authority facts, never a transcript or pane state.
          row: invocationRow({ ...row, key: route.sessionKey, agentId: route.agentId }),
          retained: false,
          // Pending deletion can roll back; matches() fences actions without
          // discarding custody before the deletion owner confirms retirement.
          current: () =>
            entries.get(key) === candidate &&
            host.connection.isCurrent(connection) &&
            identity(host.snapshot()) === owner &&
            host.deletionState(candidate.row) !== "confirmed",
          controller: new GitHubPublicationController({
            client: connection.client,
            target: route,
            isCurrent: () => candidate.current(),
            reserve: () => {
              if (candidate.retained) {
                return;
              }
              if (
                [...entries.values()].filter((operation) => operation.retained).length >=
                MAX_RETAINED_PUBLICATIONS
              ) {
                throw new Error(
                  t("githubPublication.capacity", { newAction: t("githubPublication.newAction") }),
                );
              }
              candidate.retained = true;
            },
            release: () => {
              candidate.retained = false;
              releaseIdle(key, candidate);
            },
            unbound: () => releaseIdle(key, candidate),
          }),
        };
        entry = candidate;
        // Split panes share idle state too; only admitted operations survive the last detach.
        entries.set(key, entry);
      }
      const operation = entry;
      return Object.assign(operation.controller.bind(changed), {
        matches: (next: GatewaySessionRow) =>
          operation.current() &&
          !host.deletionState(next) &&
          keyFor(next) === key &&
          authority(next) === authority(operation.row),
      });
    },
    observeRows(rows: readonly GatewaySessionRow[], agentId?: string | null) {
      if (entries.size === 0) {
        return;
      }
      const incoming = new Map(rows.map((row) => [keyFor(row, agentId), row]));
      reconcile((row, key) => {
        const next = incoming.get(key);
        return next
          ? reconcileSessionHistory(
              snapshotFor(row),
              { ...next, key: row.key, agentId: row.agentId },
              undefined,
              { archivedFilter: "all", selectedGlobalAgentId: row.agentId },
            )?.sessions[0]
          : row;
      });
    },
    observeEvent(payload: unknown) {
      if (entries.size === 0) {
        return;
      }
      const event = readSessionChangedEvent(payload);
      // Global events without an agent cannot identify which admitted operation they affect.
      if (!event || (isUiGlobalSessionKey(event.key) && !event.agentId)) {
        return;
      }
      const key = keyFor({ key: event.key, agentId: event.agentId ?? undefined });
      reconcile((row, retainedKey) =>
        retainedKey === key
          ? reconcileSessionChanged(snapshotFor(row), payload, {
              archivedFilter: "all",
              selectedGlobalAgentId: row.agentId,
            }).result?.sessions[0]
          : row,
      );
    },
    clear() {
      for (const [key, entry] of entries) {
        retire(key, entry);
      }
    },
  };
}

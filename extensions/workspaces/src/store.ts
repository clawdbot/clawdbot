// Workspaces store: the single writer for the workspace document.
//
// Storage split (AGENTS.md "Storage default: SQLite only"):
// - the workspace document + its undo ring live in this plugin-owned SQLite DB,
//   the same shape logbook uses ("frames on disk, everything else in one
//   plugin-owned DB");
// - agent-authored widget assets (`workspaces/widgets/<name>/`) and file-binding
//   data (`workspaces/data/`) stay on disk, because those are named product
//   artifacts: the agent authors them with ordinary file tools and the widget
//   route serves their bytes.
//
// Every mutation is a single BEGIN IMMEDIATE transaction, so a read-modify-write
// cycle cannot interleave with another writer. node:sqlite is synchronous, which
// is why the mutator must be synchronous too: the transaction is the lock.
//
// There is deliberately no migration from the `workspace.json` this plugin used
// while it was in review. The plugin has never been reachable from a release tag,
// so no installation can hold that file, and compatibility here is opt-in per
// AGENTS.md. Seeding the default workspace on an empty database is the only
// first-read path.

import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configureSqliteConnectionPragmas } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { WidgetAssetTokens } from "./asset-tokens.js";
import { DEFAULT_WORKSPACE } from "./default-workspace.js";
import {
  validateWorkspaceDoc,
  type WorkspaceActor,
  type WorkspaceWidgetRegistryEntry,
  type WorkspaceDoc,
} from "./schema.js";

type WorkspaceMutationOptions = { actor: WorkspaceActor };
type WorkspaceMutationResult = { doc: WorkspaceDoc; changed: boolean };

const MAX_WORKSPACE_BYTES = 256 * 1024;
const UNDO_RING_SIZE = 20;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const BUSY_TIMEOUT_MS = 5000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  doc TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS undo (
  version INTEGER PRIMARY KEY,
  doc TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);
`;

function serializeWorkspaceDoc(doc: WorkspaceDoc): string {
  return JSON.stringify(doc);
}

function assertWorkspaceSize(serialized: string): void {
  if (Buffer.byteLength(serialized, "utf8") > MAX_WORKSPACE_BYTES) {
    throw new Error("workspace document exceeds 256 KB");
  }
}

/**
 * Reconciles a whole-document replacement against what is already stored, inside
 * the write transaction. Two fields are never taken from the caller:
 *
 * - **the registry itself.** Entries are minted by `workspace_widget_scaffold` and
 *   nowhere else. Replacement preserves the complete current registry and ignores
 *   the incoming field: otherwise a caller could delete approval decisions or mint a `pending`
 *   entry for a name with no widget on disk, have an operator approve it, and only
 *   then write the code the operator "approved". Status likewise changes only
 *   through `workspaces.widget.approve` — a document that arrives already marked
 *   `approved` would skip the gate entirely and the asset route would serve it.
 * - **provenance (`createdBy`).** Otherwise an agent could stamp its own tabs and
 *   widgets `user`, or an operator could stamp `agent:<id>`, and the AI-provenance
 *   chip would be a lie. Existing entities keep their stamp; new ones get `actor`.
 */
function reconcileReplace(
  incoming: WorkspaceDoc,
  current: WorkspaceDoc,
  actor: WorkspaceActor,
): WorkspaceDoc {
  const widgetsRegistry: Record<string, WorkspaceWidgetRegistryEntry> = structuredClone(
    current.widgetsRegistry,
  );
  const existingTabs = new Map(current.tabs.map((tab) => [tab.slug, tab]));
  const existingWidgets = new Map(
    current.tabs.flatMap((tab) => tab.widgets.map((widget) => [widget.id, widget] as const)),
  );
  return {
    ...incoming,
    widgetsRegistry,
    tabs: incoming.tabs.map((tab) => ({
      ...tab,
      createdBy: existingTabs.get(tab.slug)?.createdBy ?? actor,
      widgets: tab.widgets.map((widget) => ({
        ...widget,
        createdBy: existingWidgets.get(widget.id)?.createdBy ?? actor,
      })),
    })),
  };
}

export class WorkspaceStore {
  readonly stateDir: string;
  readonly workspaceDir: string;
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  readonly assetTokens = new WidgetAssetTokens();
  /**
   * Single-slot cache of the parsed document. This process is the only writer
   * and every write goes through `commit()`, so the cache is exact rather than
   * merely fresh — the capability-gated asset route can check approval status on
   * every request without re-parsing a 256 KB document.
   */
  private cached: WorkspaceDoc | null = null;

  constructor(options: { stateDir?: string } = {}) {
    this.stateDir = options.stateDir ?? resolveStateDir();
    this.workspaceDir = path.join(this.stateDir, "workspaces");
    this.dbPath = path.join(this.workspaceDir, "workspaces.sqlite");
    mkdirSync(this.workspaceDir, { recursive: true, mode: DIR_MODE });
    this.db = new DatabaseSync(this.dbPath);
    try {
      configureSqliteConnectionPragmas(this.db, { busyTimeoutMs: BUSY_TIMEOUT_MS });
      // WAL/SHM sidecars inherit the main DB file's permissions.
      chmodSync(this.dbPath, FILE_MODE);
      this.db.exec(SCHEMA);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  read(): WorkspaceDoc {
    if (this.cached) {
      return structuredClone(this.cached);
    }
    const row = this.db.prepare("SELECT doc FROM workspace WHERE id = 1").get() as
      | { doc: string }
      | undefined;
    if (!row) {
      const seeded = validateWorkspaceDoc(structuredClone(DEFAULT_WORKSPACE));
      this.commit(seeded, { snapshot: null });
      return structuredClone(seeded);
    }
    const doc = validateWorkspaceDoc(JSON.parse(row.doc));
    this.cached = doc;
    return structuredClone(doc);
  }

  /** Registry entry for one custom widget, or null when it was never scaffolded. */
  widgetEntry(name: string): WorkspaceWidgetRegistryEntry | null {
    return this.read().widgetsRegistry[name] ?? null;
  }

  /** Approval status for one custom widget. */
  widgetStatus(name: string): WorkspaceWidgetRegistryEntry["status"] | null {
    return this.widgetEntry(name)?.status ?? null;
  }

  /**
   * Applies `fn` to a draft of the current document and persists the result.
   * `fn` must be synchronous: it runs inside the write transaction, which is what
   * serializes concurrent RPC / CLI / agent-tool callers.
   */
  mutate(
    fn: (draft: WorkspaceDoc) => WorkspaceDoc | void,
    _options: WorkspaceMutationOptions,
  ): WorkspaceMutationResult {
    return this.transact((current) => {
      const draft = structuredClone(current);
      const returned = fn(draft);
      return returned ?? draft;
    });
  }

  /**
   * Replaces the whole document (bulk authoring). Approval state and provenance
   * are always reconciled against the stored document, so replace can neither
   * self-approve a custom widget nor forge a `createdBy` stamp.
   */
  replace(doc: WorkspaceDoc, options: WorkspaceMutationOptions): WorkspaceMutationResult {
    return this.transact((current) =>
      reconcileReplace(structuredClone(doc), current, options.actor),
    );
  }

  /**
   * Restores the newest undo snapshot as a NEW version. The restored document is
   * a fresh write, not a rewind: `workspaceVersion` stays monotonic so connected
   * UIs — which refetch only on a strictly newer version — see the undo.
   */
  undo(): WorkspaceDoc {
    return this.transact(
      (current) => {
        const row = this.db
          .prepare("SELECT version, doc FROM undo ORDER BY version DESC LIMIT 1")
          .get() as { version: number; doc: string } | undefined;
        if (!row) {
          throw new Error("no workspace undo snapshot available");
        }
        this.db.prepare("DELETE FROM undo WHERE version = ?").run(row.version);
        // transact() stamps the next version, so the restored document lands as a
        // forward write rather than a rewind.
        const snapshot = validateWorkspaceDoc(JSON.parse(row.doc));
        // Approval state is a separate operator decision, not layout history.
        // Undo may restore tabs/widgets, but it must never revive a revoked
        // approval or discard a registry decision made after the snapshot.
        return { ...snapshot, widgetsRegistry: current.widgetsRegistry };
      },
      // An undo consumes a snapshot; it must not push one, or repeated undo would
      // oscillate between the last two documents instead of walking history back.
      { snapshot: false },
    ).doc;
  }

  /**
   * One BEGIN IMMEDIATE transaction: read current, derive next, snapshot the old
   * document into the undo ring, write, trim. Any throw rolls the whole thing
   * back, so a rejected write never leaves a partially applied document.
   */
  private transact(
    derive: (current: WorkspaceDoc) => WorkspaceDoc,
    options: { snapshot?: boolean } = {},
  ): WorkspaceMutationResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Derive from what the transaction sees, never from the cache: the cache
      // is a read-path accelerator, not the transaction's snapshot.
      this.cached = null;
      const current = this.read();
      const next = validateWorkspaceDoc({
        ...derive(current),
        workspaceVersion: current.workspaceVersion + 1,
      });
      this.commit(next, { snapshot: options.snapshot === false ? null : current });
      this.db.exec("COMMIT");
      return { doc: next, changed: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.cached = null;
      throw error;
    }
  }

  /** Persists `doc` as the current workspace, pushing `snapshot` onto the undo ring. */
  private commit(doc: WorkspaceDoc, params: { snapshot: WorkspaceDoc | null }): void {
    const serialized = serializeWorkspaceDoc(doc);
    assertWorkspaceSize(serialized);
    const now = Date.now();
    if (params.snapshot) {
      this.db
        .prepare("INSERT OR REPLACE INTO undo (version, doc, created_ms) VALUES (?, ?, ?)")
        .run(doc.workspaceVersion, serializeWorkspaceDoc(params.snapshot), now);
      this.db
        .prepare(
          "DELETE FROM undo WHERE version NOT IN (SELECT version FROM undo ORDER BY version DESC LIMIT ?)",
        )
        .run(UNDO_RING_SIZE);
    }
    this.db
      .prepare(
        "INSERT INTO workspace (id, version, doc, updated_ms) VALUES (1, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET version = excluded.version, doc = excluded.doc, updated_ms = excluded.updated_ms",
      )
      .run(doc.workspaceVersion, serialized, now);
    this.cached = doc;
  }
}

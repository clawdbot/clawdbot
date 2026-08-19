import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { insideGitCheckout, runGit } from "../agents/worktrees/git.js";
import { slugifyWorktreeTitle } from "../agents/worktrees/name.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  type OpenClawStateLeaseContext,
  withOpenClawStateLease,
} from "../state/openclaw-state-lease.js";

export type ProjectRegistryRecord = {
  id: string;
  displayName: string;
  repoRoot: string;
  originUrl?: string;
  source: "workspace" | "registered" | "cloned";
  agentId?: string;
};

type ProjectsDatabase = Pick<OpenClawStateKyselyDatabase, "projects">;
type ProjectRow = Selectable<OpenClawStateKyselyDatabase["projects"]>;

const ensuredDatabases = new WeakSet<DatabaseSync>();
const PROJECT_ID_MAX_LENGTH = 64;
const PROJECT_CHECKOUT_LEASE_MS = 30_000;
const PROJECT_CHECKOUT_WAIT_MS = 30_000;
const PROJECTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT NOT NULL PRIMARY KEY,
  display_name TEXT NOT NULL,
  repo_root TEXT NOT NULL,
  origin_url TEXT,
  source TEXT NOT NULL CHECK (source IN ('registered', 'cloned')),
  created_at_ms INT NOT NULL,
  updated_at_ms INT NOT NULL
) STRICT;
`;

export class ProjectCheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectCheckoutError";
  }
}

function ensureProjectRegistrySchema(options: OpenClawStateDatabaseOptions = {}): void {
  const database = openOpenClawStateDatabase(options);
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // sqlite-allow-raw -- feature-local additive schema DDL; project rows use Kysely below.
      db.exec(PROJECTS_SCHEMA_SQL);
    },
    options,
    { operationLabel: "projects.registry.schema.ensure" },
  );
  ensuredDatabases.add(database.db);
}

function openProjectsDatabase(options: OpenClawStateDatabaseOptions = {}) {
  ensureProjectRegistrySchema(options);
  const state = openOpenClawStateDatabase(options);
  return { sqlite: state.db, kysely: getNodeSqliteKysely<ProjectsDatabase>(state.db) };
}

function rowToProject(row: ProjectRow): ProjectRegistryRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    repoRoot: row.repo_root,
    ...(row.origin_url ? { originUrl: row.origin_url } : {}),
    source: row.source as "registered" | "cloned",
  };
}

function insertProjectRegistry(
  input: {
    displayName: string;
    repoRoot: string;
    originUrl?: string;
    source: "registered" | "cloned";
  },
  options: OpenClawStateDatabaseOptions,
  lease: OpenClawStateLeaseContext,
): ProjectRegistryRecord {
  ensureProjectRegistrySchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db: sqlite }) => {
      lease.assertOwnedInTransaction(sqlite);
      const db = getNodeSqliteKysely<ProjectsDatabase>(sqlite);
      const sameRoot = executeSqliteQueryTakeFirstSync(
        sqlite,
        db.selectFrom("projects").selectAll().where("repo_root", "=", input.repoRoot),
      );
      if (sameRoot) {
        return rowToProject(sameRoot);
      }
      if (input.source === "cloned" && input.originUrl) {
        const duplicate = executeSqliteQueryTakeFirstSync(
          sqlite,
          db.selectFrom("projects").selectAll().where("origin_url", "=", input.originUrl),
        );
        if (duplicate) {
          return rowToProject(duplicate);
        }
      }
      const existing = new Set(
        executeSqliteQuerySync(sqlite, db.selectFrom("projects").select("id")).rows.map(
          (row) => row.id,
        ),
      );
      const baseId = slugifyWorktreeTitle(input.displayName) ?? "project";
      const id = allocateProjectId(baseId, existing);
      const now = Date.now();
      const row = {
        id,
        display_name: input.displayName,
        repo_root: input.repoRoot,
        origin_url: input.originUrl ?? null,
        source: input.source,
        created_at_ms: now,
        updated_at_ms: now,
      };
      executeSqliteQuerySync(sqlite, db.insertInto("projects").values(row));
      return rowToProject(row);
    },
    options,
    { operationLabel: "projects.registry.insert" },
  );
}

export async function withProjectCheckoutLifecycle<T>(
  repoRoot: string,
  options: OpenClawStateDatabaseOptions,
  run: (lease: OpenClawStateLeaseContext) => Promise<T>,
): Promise<T> {
  return await withOpenClawStateLease(
    {
      scope: "projects.checkout",
      key: repoRoot,
      database: { scope: "shared", options },
      leaseMs: PROJECT_CHECKOUT_LEASE_MS,
      waitMs: PROJECT_CHECKOUT_WAIT_MS,
      leaseLabel: "project checkout lease",
      operationLabel: "projects.checkout.lease",
    },
    run,
  );
}

function workspaceProject(cfg: OpenClawConfig, agentId: string): ProjectRegistryRecord {
  const repoRoot = resolveAgentWorkspaceDir(cfg, agentId);
  return {
    id: `workspace:${agentId}`,
    displayName: path.basename(repoRoot) || agentId,
    repoRoot,
    source: "workspace",
    agentId,
  };
}

function compareProjects(left: ProjectRegistryRecord, right: ProjectRegistryRecord): number {
  const leftName = left.displayName.toLowerCase();
  const rightName = right.displayName.toLowerCase();
  if (leftName !== rightName) {
    return leftName < rightName ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function allocateProjectId(base: string, existing: ReadonlySet<string>): string {
  if (!existing.has(base)) {
    return base;
  }
  for (let suffixNumber = 2; ; suffixNumber += 1) {
    const suffix = `-${suffixNumber}`;
    const candidate = `${base.slice(0, PROJECT_ID_MAX_LENGTH - suffix.length).replace(/-+$/u, "")}${suffix}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
}

export async function resolveProjectDirectory(projectPath: string): Promise<string> {
  const requested = await fs.realpath(projectPath).catch(() => {
    throw new ProjectCheckoutError(`project path does not exist: ${projectPath}`);
  });
  const stat = await fs.stat(requested).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new ProjectCheckoutError(`project path is not a directory: ${projectPath}`);
  }
  return requested;
}

export async function resolveProjectCheckout(projectPath: string): Promise<{
  path: string;
  repoRoot: string;
  originUrl?: string;
}> {
  const requested = await resolveProjectDirectory(projectPath);
  if (!insideGitCheckout(requested)) {
    throw new ProjectCheckoutError(`project path is not a git checkout: ${projectPath}`);
  }
  const rootResult = await runGit(requested, ["rev-parse", "--show-toplevel"]);
  if (rootResult.code !== 0) {
    throw new ProjectCheckoutError(`project path is not a git checkout: ${projectPath}`);
  }
  const repoRoot = await fs.realpath(rootResult.stdout.trim()).catch(() => {
    throw new ProjectCheckoutError(`project checkout root is unavailable: ${projectPath}`);
  });
  const headResult = await runGit(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (headResult.code !== 0) {
    throw new ProjectCheckoutError(`project checkout has no commits: ${projectPath}`);
  }
  const originResult = await runGit(repoRoot, ["config", "--get", "remote.origin.url"]);
  const originUrl = originResult.code === 0 ? originResult.stdout.trim() : "";
  return { path: requested, repoRoot, ...(originUrl ? { originUrl } : {}) };
}

async function registerResolvedProject(
  input: {
    path: string;
    name?: string;
    originUrl?: string;
    source: "registered" | "cloned";
  },
  options: OpenClawStateDatabaseOptions = {},
): Promise<ProjectRegistryRecord> {
  const checkout = await resolveProjectCheckout(input.path);
  const displayName = input.name?.trim() || path.basename(checkout.repoRoot) || "Project";
  return await withProjectCheckoutLifecycle(checkout.repoRoot, options, async (lease) => {
    // A deletion may have won the lease after the first canonicalization. Revalidate under the
    // lifecycle owner so a stale registration cannot recreate a row for the removed checkout.
    const current = await resolveProjectCheckout(checkout.repoRoot);
    if (current.repoRoot !== checkout.repoRoot) {
      throw new ProjectCheckoutError(`project checkout changed while registering: ${input.path}`);
    }
    return insertProjectRegistry(
      {
        displayName,
        repoRoot: checkout.repoRoot,
        originUrl: input.originUrl ?? checkout.originUrl,
        source: input.source,
      },
      options,
      lease,
    );
  });
}

export async function registerProjectRegistry(
  input: { path: string; name?: string },
  options: OpenClawStateDatabaseOptions = {},
): Promise<ProjectRegistryRecord> {
  return await registerResolvedProject({ ...input, source: "registered" }, options);
}

export async function registerClonedProjectRegistry(
  input: { path: string; name: string; originUrl: string },
  options: OpenClawStateDatabaseOptions = {},
): Promise<ProjectRegistryRecord> {
  return await registerResolvedProject({ ...input, source: "cloned" }, options);
}

export function listProjectRegistry(
  cfg: OpenClawConfig,
  options: OpenClawStateDatabaseOptions = {},
): ProjectRegistryRecord[] {
  const { sqlite, kysely } = openProjectsDatabase(options);
  const stored = executeSqliteQuerySync(sqlite, kysely.selectFrom("projects").selectAll()).rows.map(
    rowToProject,
  );
  const workspaces = listAgentIds(cfg).map((agentId) => workspaceProject(cfg, agentId));
  return [...workspaces, ...stored].toSorted(compareProjects);
}

export function resolveProjectRegistry(
  cfg: OpenClawConfig,
  id: string,
  options: OpenClawStateDatabaseOptions = {},
): ProjectRegistryRecord | undefined {
  if (id.startsWith("workspace:")) {
    const agentId = id.slice("workspace:".length);
    return listAgentIds(cfg).includes(agentId) ? workspaceProject(cfg, agentId) : undefined;
  }
  const { sqlite, kysely } = openProjectsDatabase(options);
  const row = executeSqliteQueryTakeFirstSync(
    sqlite,
    kysely.selectFrom("projects").selectAll().where("id", "=", id),
  );
  return row ? rowToProject(row) : undefined;
}

export function removeProjectCheckoutReference(
  project: ProjectRegistryRecord,
  lease: OpenClawStateLeaseContext,
  options: OpenClawStateDatabaseOptions = {},
): "missing" | "changed" | "remaining" | "final" {
  ensureProjectRegistrySchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db: sqlite }) => {
      lease.assertOwnedInTransaction(sqlite);
      const db = getNodeSqliteKysely<ProjectsDatabase>(sqlite);
      const current = executeSqliteQueryTakeFirstSync(
        sqlite,
        db.selectFrom("projects").selectAll().where("id", "=", project.id),
      );
      if (!current) {
        return "missing";
      }
      if (current.source !== "cloned" || current.repo_root !== project.repoRoot) {
        return "changed";
      }
      executeSqliteQuerySync(sqlite, db.deleteFrom("projects").where("id", "=", project.id));
      const sibling = executeSqliteQueryTakeFirstSync(
        sqlite,
        db
          .selectFrom("projects")
          .selectAll()
          .where("repo_root", "=", project.repoRoot)
          .orderBy("id", "asc"),
      );
      if (!sibling) {
        return "final";
      }
      if (sibling.source === "registered") {
        executeSqliteQuerySync(
          sqlite,
          db
            .updateTable("projects")
            .set({
              source: "cloned",
              origin_url: sibling.origin_url ?? current.origin_url,
              updated_at_ms: Date.now(),
            })
            .where("id", "=", sibling.id),
        );
      }
      return "remaining";
    },
    options,
    { operationLabel: "projects.registry.checkout-reference.remove" },
  );
}

export async function resolveRecordedProjectRoot(
  projectPath: string,
  options: OpenClawStateDatabaseOptions = {},
): Promise<string | undefined> {
  const repoRoot = await fs.realpath(projectPath).catch(() => undefined);
  if (!repoRoot) {
    return undefined;
  }
  const { sqlite, kysely } = openProjectsDatabase(options);
  const row = executeSqliteQueryTakeFirstSync(
    sqlite,
    kysely.selectFrom("projects").select("repo_root").where("repo_root", "=", repoRoot),
  );
  return row?.repo_root;
}

export function removeProjectRegistry(
  id: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  ensureProjectRegistrySchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db: sqlite }) => {
      const db = getNodeSqliteKysely<ProjectsDatabase>(sqlite);
      return (
        executeSqliteQuerySync(sqlite, db.deleteFrom("projects").where("id", "=", id))
          .numAffectedRows === 1n
      );
    },
    options,
    { operationLabel: "projects.registry.remove" },
  );
}

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

type ProjectRegistryRecord = {
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

export async function resolveProjectCheckout(projectPath: string): Promise<{
  path: string;
  repoRoot: string;
  originUrl?: string;
}> {
  const requested = await fs.realpath(projectPath).catch(() => {
    throw new ProjectCheckoutError(`project path does not exist: ${projectPath}`);
  });
  const stat = await fs.stat(requested).catch(() => null);
  if (!stat?.isDirectory() || !insideGitCheckout(requested)) {
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

export async function registerProjectRegistry(
  input: { path: string; name?: string },
  options: OpenClawStateDatabaseOptions = {},
): Promise<ProjectRegistryRecord> {
  const checkout = await resolveProjectCheckout(input.path);
  const displayName = input.name?.trim() || path.basename(checkout.repoRoot) || "Project";
  const baseId = slugifyWorktreeTitle(displayName) ?? "project";
  ensureProjectRegistrySchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db: sqlite }) => {
      const db = getNodeSqliteKysely<ProjectsDatabase>(sqlite);
      const existing = new Set(
        executeSqliteQuerySync(sqlite, db.selectFrom("projects").select("id")).rows.map(
          (row) => row.id,
        ),
      );
      const id = allocateProjectId(baseId, existing);
      const now = Date.now();
      const row = {
        id,
        display_name: displayName,
        repo_root: checkout.repoRoot,
        origin_url: checkout.originUrl ?? null,
        source: "registered" as const,
        created_at_ms: now,
        updated_at_ms: now,
      };
      executeSqliteQuerySync(sqlite, db.insertInto("projects").values(row));
      return rowToProject(row);
    },
    options,
    { operationLabel: "projects.registry.register" },
  );
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

import fs from "node:fs/promises";
import path from "node:path";
import type { Skill } from "@mariozechner/pi-coding-agent";
import mysql from "mysql2/promise";
import { resolveBundledSkillsDir } from "../agents/skills/bundled-dir.js";
import { createSyntheticSourceInfo } from "../agents/skills/skill-contract.js";
import type { SourceScope } from "../agents/skills/skill-contract.js";
import type {
  SkillEntry,
  ParsedSkillFrontmatter,
  OpenClawSkillMetadata,
  SkillInvocationPolicy,
  SkillExposure,
} from "../agents/skills/types.js";
import { loadConfig } from "../config/config.js";
import { parseFrontmatterBlock } from "../markdown/frontmatter.js";
import { resolveStorageSkillSlug, withStorageSkillIdentity } from "./skill-storage-identity.js";
import { getSkillsDbCachedUserId, setSkillsDbCache } from "./skills-db-cache.js";

export interface SkillRow {
  id: number;
  user_id: number | null;
  name: string;
  /** Absent only in legacy in-memory adapters; database reads always project slug. */
  slug?: string;
  description: string | null;
  content: string | null;
  source: string;
  category: string | null;
  is_enable: number;
  references: string | null;
  scripts: string | null;
  created_at: Date;
  updated_at: Date;
}

export const PUBLIC_SKILL_OWNER_ID = 126;
export const PUBLIC_SKILL_NAMES = [
  "institution-violation-judgment",
  "gov-public-opinion-analysis-agent",
  "ai-public-opinion-brief",
  "ai-collaboration-diagnostic",
  "infringement-judgment",
] as const;

const rowSlug = (row: SkillRow): string => row.slug ?? row.name;
const publicSkillNames = new Set<string>(PUBLIC_SKILL_NAMES);
const isPublicSkillRow = (row: SkillRow): boolean =>
  row.user_id === PUBLIC_SKILL_OWNER_ID &&
  (publicSkillNames.has(rowSlug(row)) || row.category === "builtin");
const SKILL_SELECT_COLUMNS =
  "id, user_id, COALESCE(slug, name) AS slug, name, description, content, source, category, is_enable, `references`, scripts, created_at, updated_at";

/**
 * Merge rows defensively even if a caller supplies a broader result set.
 * A user's private Skills remain visible alongside the administrator's public
 * skills. The public row always wins a same-name collision.
 */
export function mergeVisibleSkillRows(rows: SkillRow[], userId: number): SkillRow[] {
  const merged = new Map<string, SkillRow>();
  for (const row of rows) {
    if (row.is_enable === 1 && row.user_id === userId) {
      merged.set(rowSlug(row), row);
    }
  }
  for (const row of rows) {
    if (row.is_enable === 1 && isPublicSkillRow(row)) {
      merged.set(rowSlug(row), row);
    }
  }
  return [...merged.values()].toSorted((a, b) =>
    rowSlug(a) < rowSlug(b) ? -1 : rowSlug(a) > rowSlug(b) ? 1 : 0,
  );
}

interface MySqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

let pool: mysql.Pool | null = null;
let cachedEntries: SkillEntry[] | null = null;
let cacheLoadTime = 0;
const CACHE_TTL_MS = 5000;
const DEFAULT_SKILL_LIST_LIMIT = 50;
const MAX_SKILL_LIST_LIMIT = 100;
const MAX_SKILL_LIST_OFFSET = 2_147_483_647;
let publicSkillsSeeded = false;

function resolveConfig(): MySqlConfig {
  const cfg = loadConfig();
  const pluginEntries = cfg.plugins?.entries as Record<string, Record<string, unknown>> | undefined;
  const mysqlCfg = pluginEntries?.["feed-search"]?.config as Record<string, unknown> | undefined;
  const env = process.env;

  // The `skills` table is read+write: `skill_save` inserts/updates rows, so this
  // connection MUST use a writable account. Prefer WRITER_MYSQL_* (e.g.
  // btclaw_writer); the HISTORY_MYSQL_* creds are the read-only account, under
  // which SELECT succeeds (listing works) while INSERT/UPDATE fail with "command
  // denied to user" — i.e. skill_save silently fails. Fall back to HISTORY_* then
  // the legacy FEED_MYSQL_* names, then the local default. Host/port/db share one
  // `superworker` server across the reader and writer accounts.
  return {
    host:
      env.WRITER_MYSQL_HOST ??
      (mysqlCfg?.host as string) ??
      env.HISTORY_MYSQL_HOST ??
      env.FEED_MYSQL_HOST ??
      "127.0.0.1",
    port: Number(
      env.WRITER_MYSQL_PORT ??
        mysqlCfg?.port ??
        env.HISTORY_MYSQL_PORT ??
        env.FEED_MYSQL_PORT ??
        3306,
    ),
    user:
      env.WRITER_MYSQL_USER ??
      (mysqlCfg?.user as string) ??
      env.HISTORY_MYSQL_USER ??
      env.FEED_MYSQL_USER ??
      "",
    password:
      env.WRITER_MYSQL_PASSWORD ??
      (mysqlCfg?.password as string) ??
      env.HISTORY_MYSQL_PASSWORD ??
      env.FEED_MYSQL_PASSWORD ??
      "",
    database:
      env.WRITER_MYSQL_DATABASE ??
      (mysqlCfg?.database as string) ??
      env.HISTORY_MYSQL_DATABASE ??
      env.FEED_MYSQL_DATABASE ??
      "superworker",
  };
}

function getPool(): mysql.Pool {
  if (pool) {
    return pool;
  }

  const config = resolveConfig();
  pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: 3,
    waitForConnections: true,
    charset: "utf8mb4",
    timezone: "+08:00",
    // Fail fast instead of hanging the turn when the DB is unreachable.
    connectTimeout: 5000,
  });

  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
  cachedEntries = null;
  publicSkillsSeeded = false;
}

function extractBundledSkillDescription(content: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content)?.[1];
  const line = frontmatter?.split(/\r?\n/u).find((value) => /^description\s*:/u.test(value));
  return line?.replace(/^description\s*:\s*/u, "").trim() ?? "";
}

async function ensurePublicSkillRows(p: mysql.Pool): Promise<void> {
  if (publicSkillsSeeded) {
    return;
  }
  const bundledSkillsDir = resolveBundledSkillsDir();
  if (!bundledSkillsDir) {
    return;
  }

  for (const skillName of PUBLIC_SKILL_NAMES) {
    const content = await fs.readFile(path.join(bundledSkillsDir, skillName, "SKILL.md"), "utf8");
    await p.execute(
      `INSERT INTO skills
         (user_id, slug, name, description, content, source, category, is_enable, \`references\`, scripts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'workspace', 'public', 1, '', NULL, NOW(), NOW())
       ON DUPLICATE KEY UPDATE id = id`,
      [
        PUBLIC_SKILL_OWNER_ID,
        skillName,
        parseFrontmatterBlock(content).title ?? skillName,
        extractBundledSkillDescription(content),
        content,
      ],
    );
  }
  publicSkillsSeeded = true;
}

async function fetchVisibleSkillRows(p: mysql.Pool, userId: number): Promise<SkillRow[]> {
  await ensurePublicSkillRows(p);
  const placeholders = PUBLIC_SKILL_NAMES.map(() => "?").join(", ");
  const [rows] = await p.execute<mysql.RowDataPacket[]>(
    `SELECT ${SKILL_SELECT_COLUMNS}
       FROM skills
      WHERE is_enable = 1
        AND (user_id = ? OR (user_id = ? AND (category = 'builtin' OR COALESCE(slug, name) IN (${placeholders}))))
      ORDER BY name ASC`,
    [userId, PUBLIC_SKILL_OWNER_ID, ...PUBLIC_SKILL_NAMES],
  );
  return mergeVisibleSkillRows(rows as SkillRow[], userId);
}

export async function refreshSkillsCache(userId?: number): Promise<void> {
  const p = getPool();
  const skillRows =
    userId !== undefined
      ? await fetchVisibleSkillRows(p, userId)
      : await p
          .execute<mysql.RowDataPacket[]>(
            `SELECT ${SKILL_SELECT_COLUMNS} FROM skills WHERE is_enable = 1 ORDER BY name ASC`,
          )
          .then(([rows]) => rows as SkillRow[]);
  cachedEntries = skillRows.map((row) => rowToSkillEntry(row));
  cacheLoadTime = Date.now();
}

function rowToSkillEntry(
  row: SkillRow,
  realPaths?: { filePath: string; baseDir: string },
): SkillEntry {
  const name = rowSlug(row);
  const description = row.description ?? "";
  // Materialized skills point at real workspace files so `read`/`exec` work;
  // non-materialized callers (listings/CRUD) get the virtual `memory://` path.
  const filePath = realPaths?.filePath ?? `memory://skills/${name}/SKILL.md`;
  const baseDir = realPaths?.baseDir ?? `memory://skills/${name}`;

  const skill: Skill = {
    name,
    description,
    filePath,
    baseDir,
    source: row.source ?? "db",
    sourceInfo: createSyntheticSourceInfo(filePath, {
      source: row.source ?? "db",
      scope: "project" as SourceScope,
      origin: "top-level",
      baseDir,
    }),
    disableModelInvocation: false,
  };

  const frontmatter: ParsedSkillFrontmatter = {
    name,
    description,
  };

  const metadata: OpenClawSkillMetadata | undefined = row.category ? { emoji: "📋" } : undefined;

  const invocation: SkillInvocationPolicy = {
    userInvocable: true,
    disableModelInvocation: false,
  };

  const exposure: SkillExposure = {
    includeInRuntimeRegistry: true,
    includeInAvailableSkillsPrompt: true,
    userInvocable: true,
  };

  return { skill, frontmatter, metadata, invocation, exposure };
}

export async function preloadSkillsCache(userId?: string): Promise<void> {
  const numericUserId = userId ? Number(userId) : undefined;
  await refreshSkillsCache(numericUserId);
  setSkillsDbCache(cachedEntries, numericUserId);
}

export async function loadSkillEntriesFromDbAsync(userId?: string): Promise<SkillEntry[]> {
  const numericUserId = userId ? Number(userId) : undefined;
  if (
    !cachedEntries ||
    Date.now() - cacheLoadTime > CACHE_TTL_MS ||
    getSkillsDbCachedUserId() !== numericUserId
  ) {
    await refreshSkillsCache(numericUserId);
    setSkillsDbCache(cachedEntries, numericUserId);
  }
  return cachedEntries ?? [];
}

export async function listSkills(
  userId: number,
  opts?: { limit?: number; offset?: number },
): Promise<{ skills: SkillRow[]; total: number }> {
  const p = getPool();
  const limit = Number.isFinite(opts?.limit)
    ? Math.max(1, Math.min(MAX_SKILL_LIST_LIMIT, Math.floor(opts?.limit ?? 0)))
    : DEFAULT_SKILL_LIST_LIMIT;
  const offset = Number.isFinite(opts?.offset)
    ? Math.max(0, Math.min(MAX_SKILL_LIST_OFFSET, Math.floor(opts?.offset ?? 0)))
    : 0;

  const [countRows] = await p.execute<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) as total FROM skills WHERE user_id = ?",
    [userId],
  );
  const total = (countRows[0] as { total: number }).total ?? 0;

  // MySQL 8.0.22+ can reject prepared LIMIT/OFFSET values that mysql2 sends as
  // DOUBLE. These values are bounded integers, so inlining them is safe while
  // keeping the user id parameterized.
  const [rows] = await p.execute<mysql.RowDataPacket[]>(
    `SELECT id, user_id, COALESCE(slug, name) AS slug, name, description, content, source, category, is_enable, \`references\`, scripts, created_at, updated_at FROM skills WHERE user_id = ? ORDER BY name ASC LIMIT ${limit} OFFSET ${offset}`,
    [userId],
  );

  return { skills: rows as SkillRow[], total };
}

export async function getSkillById(id: number, userId: number): Promise<SkillRow | null> {
  const p = getPool();
  const [rows] = await p.execute<mysql.RowDataPacket[]>(
    "SELECT id, user_id, COALESCE(slug, name) AS slug, name, description, content, source, category, is_enable, `references`, scripts, created_at, updated_at FROM skills WHERE id = ? AND user_id = ?",
    [id, userId],
  );
  return (rows[0] as SkillRow) ?? null;
}

/**
 * Look up a single skill by its (user_id, name) pair. Used by the agent-facing
 * save tool to upsert: update an existing same-named skill instead of inserting
 * a duplicate. Returns the first match (most recently updated) or null.
 */
export async function getSkillByName(name: string, userId: number): Promise<SkillRow | null> {
  const p = getPool();
  const [rows] = await p.execute<mysql.RowDataPacket[]>(
    "SELECT id, user_id, COALESCE(slug, name) AS slug, name, description, content, source, category, is_enable, `references`, scripts, created_at, updated_at FROM skills WHERE COALESCE(slug, name) = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 1",
    [name, userId],
  );
  return (rows[0] as SkillRow) ?? null;
}

export async function createSkill(
  data: {
    name: string;
    slug?: string;
    description?: string;
    content?: string;
    source?: string;
    category?: string;
  },
  userId: number,
): Promise<SkillRow> {
  const p = getPool();
  const now = new Date();
  const slug = resolveStorageSkillSlug(data.name, data.content ?? "", data.slug);
  const content = withStorageSkillIdentity(data.content ?? "", slug, data.name);
  // `references` is NOT NULL with no default, so it must be supplied or the
  // INSERT fails under strict mode with "Field 'references' doesn't have a
  // default value". `source` must be a valid enum member (see skill-tool's
  // SKILL_SOURCE); default to 'workspace' rather than the invalid 'manual'.
  const [result] = await p.execute<mysql.ResultSetHeader>(
    "INSERT INTO skills (user_id, slug, name, description, content, source, category, is_enable, `references`, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, '', ?, ?)",
    [
      userId,
      slug,
      data.name,
      data.description ?? null,
      content,
      data.source ?? "workspace",
      data.category ?? null,
      now,
      now,
    ],
  );
  const inserted = await getSkillById(result.insertId, userId);
  if (!inserted) {
    throw new Error("Failed to retrieve inserted skill");
  }
  return inserted;
}

export async function updateSkill(
  id: number,
  data: Partial<{
    name: string;
    slug: string;
    description: string;
    content: string;
    source: string;
    category: string;
    is_enable: number;
  }>,
  userId: number,
): Promise<SkillRow | null> {
  const p = getPool();
  const existing = await getSkillById(id, userId);
  if (!existing) {
    return null;
  }
  const slug = rowSlug(existing);
  if (data.slug !== undefined && data.slug !== slug) {
    throw new Error("Skill slug is fixed after creation");
  }
  if (isPublicSkillRow(existing)) {
    if (data.category !== undefined && data.category !== existing.category) {
      throw new Error("Built-in skill category cannot be changed through the generic update API");
    }
    if (data.content !== undefined && parseFrontmatterBlock(data.content).name !== slug) {
      throw new Error("Built-in skill frontmatter name must match its fixed identifier");
    }
  }
  if (data.name !== undefined || data.content !== undefined) {
    const name =
      data.name ??
      (data.content ? parseFrontmatterBlock(data.content).title : undefined) ??
      existing.name;
    data = {
      ...data,
      name,
      content: withStorageSkillIdentity(data.content ?? existing.content ?? "", slug, name),
    };
  }
  const sets: string[] = [];
  const values: (string | number | null | Date)[] = [];

  if (data.name !== undefined) {
    sets.push("name = ?");
    values.push(data.name);
  }
  if (data.description !== undefined) {
    sets.push("description = ?");
    values.push(data.description);
  }
  if (data.content !== undefined) {
    sets.push("content = ?");
    values.push(data.content);
  }
  if (data.source !== undefined) {
    sets.push("source = ?");
    values.push(data.source);
  }
  if (data.category !== undefined) {
    sets.push("category = ?");
    values.push(data.category);
  }
  if (data.is_enable !== undefined) {
    sets.push("is_enable = ?");
    values.push(data.is_enable);
  }

  if (sets.length === 0) {
    return getSkillById(id, userId);
  }

  sets.push("updated_at = ?");
  values.push(new Date());

  const queryValues: (string | number | boolean | null | Date)[] = [
    ...values,
    id,
    userId,
    slug,
    existing.category,
  ];
  // Do not overwrite identity changes made by another writer after validation.
  const [result] = await p.execute<mysql.ResultSetHeader>(
    `UPDATE skills SET ${sets.join(", ")} WHERE id = ? AND user_id = ? AND COALESCE(slug, name) = ? AND category <=> ?`,
    queryValues,
  );
  if (result.affectedRows === 0) {
    throw new Error("Skill changed during update; reload before saving");
  }

  return getSkillById(id, userId);
}

export async function deleteSkill(id: number, userId: number): Promise<boolean> {
  const p = getPool();
  const [result] = await p.execute<mysql.ResultSetHeader>(
    "DELETE FROM skills WHERE id = ? AND user_id = ?",
    [id, userId],
  );
  return result.affectedRows > 0;
}

// ---------------------------------------------------------------------------
// Skill script materialization
//
// DB skills are catalog-only until their SKILL.md body (`skills.content`) and
// their linked executable scripts (`skill_scripts.script_content`) are written
// to a real workspace directory. Once materialized to
// `<workspaceDir>/skills/<name>/`, the agent's existing `read`/`exec`/`bash`
// tools can load and run them exactly like native OpenClaw skill bundles.
// ---------------------------------------------------------------------------

export interface SkillScriptRow {
  id: number;
  skill_id: number;
  script_name: string;
  script_content: string | null;
  language: string | null;
}

/** Fetch all skill scripts for the given skill ids, grouped by skill_id. */
export async function fetchSkillScripts(
  skillIds: number[],
): Promise<Map<number, SkillScriptRow[]>> {
  const map = new Map<number, SkillScriptRow[]>();
  if (skillIds.length === 0) {
    return map;
  }
  const p = getPool();
  const placeholders = skillIds.map(() => "?").join(",");
  const [rows] = await p.execute<mysql.RowDataPacket[]>(
    `SELECT id, skill_id, script_name, script_content, language FROM skill_scripts WHERE skill_id IN (${placeholders}) ORDER BY id ASC`,
    skillIds,
  );
  for (const row of rows as SkillScriptRow[]) {
    const arr = map.get(row.skill_id) ?? [];
    arr.push(row);
    map.set(row.skill_id, arr);
  }
  return map;
}

/**
 * Reduce a DB-provided name to a single safe path segment: strip directories,
 * reject traversal/empty, and keep only filename-safe characters. Prevents a
 * malicious/typo'd `skills.name` or `skill_scripts.script_name` from escaping
 * the skills directory via `../` or absolute paths.
 */
export function sanitizeSkillSegment(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  const base = path.basename(value.replaceAll("\\", "/").trim());
  if (!base || base === "." || base === "..") {
    return "";
  }
  return base.replaceAll(/[^\w.-]/g, "_");
}

// Skip re-fetching/re-writing within a short window for the same (user, workspace).
let materializedKey: string | null = null;
let materializedAt = 0;
// After a failure (DB down/misconfigured), back off so we do not retry — and
// re-block — the turn path on every message.
let lastFailureAt = 0;
const FAILURE_COOLDOWN_MS = 60_000;
// Hard ceiling on how long skill materialization may add to a turn.
const MATERIALIZE_TIMEOUT_MS = 8_000;

/**
 * Force the next `materializeSkillsForUser` call to re-fetch from the DB instead
 * of short-circuiting on the in-process TTL/key cache. Call this right after a
 * skill write (create/update) so the freshly saved skill is materialized to disk
 * and primed into the cache on the next materialize, making it visible to the
 * very next turn's skills snapshot (no gateway restart required).
 */
export function invalidateSkillsMaterializeCache(): void {
  materializedKey = null;
  materializedAt = 0;
  cacheLoadTime = 0;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Resolve the integer skills `user_id` for a run from its sessionKey/agentId.
 * Guardian sessionKeys look like `agent:<agentId>:<channel>:<userId>:<sessionId>`
 * (e.g. `agent:rabbitmq-1749:rabbitmq:1749:session_...`); falls back to the
 * trailing number of an agentId such as `rabbitmq-1749`.
 */
export function resolveSkillUserId(sessionKey?: string, agentId?: string): string | undefined {
  if (sessionKey) {
    const parts = sessionKey.split(":");
    if (parts[0] === "agent" && parts.length >= 4 && /^\d+$/.test(parts[3] ?? "")) {
      return parts[3];
    }
  }
  const trailing = agentId?.match(/-(\d+)$/)?.[1];
  return trailing ?? undefined;
}

/**
 * Fetch the user's enabled skills, write each skill's SKILL.md and linked
 * scripts into `<workspaceDir>/skills/<name>/`, prime the in-process cache with
 * real-path entries, and return them. Safe to call every turn: it short-circuits
 * within `CACHE_TTL_MS` for the same (user, workspace).
 */
export async function materializeSkillsForUser(
  workspaceDir: string,
  userId?: string,
): Promise<SkillEntry[]> {
  const numericUserId = userId ? Number(userId) : undefined;
  if (numericUserId === undefined || Number.isNaN(numericUserId)) {
    return [];
  }

  const key = `${numericUserId}::${workspaceDir}`;
  if (key === materializedKey && Date.now() - materializedAt < CACHE_TTL_MS && cachedEntries) {
    return cachedEntries;
  }

  // Recently failed (DB unreachable/misconfigured): skip without re-blocking the
  // turn. Degrade to whatever was last materialized, or to filesystem skills.
  if (Date.now() - lastFailureAt < FAILURE_COOLDOWN_MS) {
    return cachedEntries ?? [];
  }

  try {
    return await withTimeout(
      doMaterializeSkills(workspaceDir, numericUserId, key),
      MATERIALIZE_TIMEOUT_MS,
      "skills materialize",
    );
  } catch (err) {
    lastFailureAt = Date.now();
    throw err;
  }
}

async function doMaterializeSkills(
  workspaceDir: string,
  numericUserId: number,
  key: string,
): Promise<SkillEntry[]> {
  const p = getPool();
  const skillRows = await fetchVisibleSkillRows(p, numericUserId);
  const scriptsBySkill = await fetchSkillScripts(skillRows.map((r) => r.id));

  const skillsRoot = path.join(workspaceDir, "skills");
  const publicSkillsRoot = path.join(workspaceDir, ".openclaw-public-skills");
  const bundledSkillsDir = resolveBundledSkillsDir();
  const entries: SkillEntry[] = [];
  for (const row of skillRows) {
    const safeName = sanitizeSkillSegment(rowSlug(row));
    if (!safeName) {
      continue;
    }
    const isPublicSkill = isPublicSkillRow(row);
    const baseDir = path.join(isPublicSkill ? publicSkillsRoot : skillsRoot, safeName);
    if (bundledSkillsDir && isPublicSkill && publicSkillNames.has(rowSlug(row))) {
      await fs.cp(path.join(bundledSkillsDir, rowSlug(row)), baseDir, {
        recursive: true,
        force: true,
      });
    }
    await fs.mkdir(baseDir, { recursive: true });
    const skillMdPath = path.join(baseDir, "SKILL.md");
    await fs.writeFile(
      skillMdPath,
      withStorageSkillIdentity(row.content ?? "", rowSlug(row), row.name),
      "utf8",
    );

    for (const script of scriptsBySkill.get(row.id) ?? []) {
      const safeScript = sanitizeSkillSegment(script.script_name);
      if (!safeScript) {
        continue;
      }
      const scriptPath = path.join(baseDir, safeScript);
      await fs.writeFile(scriptPath, script.script_content ?? "", "utf8");
      if (process.platform !== "win32") {
        try {
          await fs.chmod(scriptPath, 0o755);
        } catch {
          // best-effort executable bit; non-fatal on filesystems that reject chmod
        }
      }
    }

    entries.push(rowToSkillEntry(row, { filePath: skillMdPath, baseDir }));
  }

  cachedEntries = entries;
  setSkillsDbCache(entries, numericUserId);
  cacheLoadTime = Date.now();
  materializedKey = key;
  materializedAt = Date.now();
  lastFailureAt = 0;
  return entries;
}

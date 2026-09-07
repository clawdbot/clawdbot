import mysql from "mysql2/promise";
import type { PluginLogger } from "../api.js";
import type { HistoryDbConfig } from "./types.js";

/** Minimal skills projection needed to inject a custom skill into the chat agent. */
export interface ResolvedSkill {
  id: number;
  name: string;
  /** The skill's instruction body; injected into the agent context. */
  content: string;
  /** Optional human description, shown to the agent alongside the body. */
  description: string | null;
}

/** Safe projection exposed to the loopback debug picker; instruction content stays server-side. */
export type SkillSummary = Pick<ResolvedSkill, "id" | "name" | "description">;

/** Hard cap on how many skills we resolve for one turn (mirrors the producer cap). */
const MAX_SKILLS = 20;

/**
 * Resolve custom `skills` rows by id for a skill-driven chat turn. Mirrors
 * ReportTemplateLookup: the skills table lives in the same history DB
 * (superworker), so this reuses the HistoryDbConfig pool pattern.
 *
 * Ownership is enforced: a user may only activate their OWN enabled skills
 * (user_id = uid AND is_enable = 1). Ids that don't exist, are disabled, or
 * belong to another user are simply omitted from the result — the caller then
 * injects only what resolved (or nothing, degrading to an ordinary turn).
 */
export class SkillLookup {
  private readonly config: HistoryDbConfig;
  private pool: mysql.Pool | null = null;

  constructor(historyDbConfig: HistoryDbConfig) {
    this.config = historyDbConfig;
  }

  private async getPool(): Promise<mysql.Pool> {
    if (!this.pool) {
      this.pool = mysql.createPool({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        connectionLimit: 2,
        waitForConnections: true,
        charset: "utf8mb4",
        timezone: "+08:00",
      });
    }
    return this.pool;
  }

  /** Validate an administrator-published name before a queue message can select it. */
  async isPublishedPublicSkill(name: string): Promise<boolean> {
    const pool = await this.getPool();
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT id FROM skills WHERE user_id = ? AND name = ? AND category = 'builtin' AND is_enable = 1 LIMIT 1",
      [126, name],
    );
    return rows.length > 0;
  }

  /** List enabled skills owned by one user without exposing their instruction bodies. */
  async listForUser(userId: string, logger: PluginLogger): Promise<SkillSummary[]> {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return [];
    }

    try {
      const pool = await this.getPool();
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT id, name, description
           FROM skills
          WHERE is_enable = 1
            AND user_id = ?
          ORDER BY id DESC
          LIMIT 100`,
        [normalizedUserId],
      );
      return rows.map((row) => ({
        id: Number(row.id),
        name: typeof row.name === "string" ? row.name : "",
        description: typeof row.description === "string" ? row.description : null,
      }));
    } catch (error) {
      logger.error(`[SKILL_LOOKUP] List failed for user ${normalizedUserId}`);
      throw error;
    }
  }

  /**
   * Resolve the enabled skills owned by the user for the given ids, preserving
   * the caller's id order (so the agent sees skills in the order the user
   * selected them). Returns [] on empty input, all-unresolvable ids, or error —
   * the caller treats an empty result as "no skills this turn".
   */
  async resolveMany(
    skillIds: number[],
    userId: string,
    logger: PluginLogger,
  ): Promise<ResolvedSkill[]> {
    // De-dupe + cap defensively; the producer already bounds this, but the
    // lookup must never build an unbounded IN(...) list from a rogue message.
    const ids = [...new Set(skillIds.filter((n) => Number.isInteger(n) && n > 0))].slice(
      0,
      MAX_SKILLS,
    );
    if (ids.length === 0) {
      return [];
    }

    try {
      const pool = await this.getPool();
      const placeholders = ids.map(() => "?").join(", ");
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT id, name, content, description
           FROM skills
          WHERE id IN (${placeholders})
            AND is_enable = 1
            AND user_id = ?`,
        [...ids, userId],
      );

      // Index resolved rows by id, then emit in the caller's requested order.
      const byId = new Map<number, ResolvedSkill>();
      for (const row of rows) {
        byId.set(Number(row.id), {
          id: Number(row.id),
          name: typeof row.name === "string" ? row.name : "",
          content: typeof row.content === "string" ? row.content : "",
          description: typeof row.description === "string" ? row.description : null,
        });
      }

      const resolved: ResolvedSkill[] = [];
      for (const id of ids) {
        const row = byId.get(id);
        if (row) {
          resolved.push(row);
        }
      }

      if (resolved.length < ids.length) {
        logger.warn(
          `[SKILL_LOOKUP] ${ids.length - resolved.length}/${ids.length} skill id(s) ` +
            `not found / not visible for user ${userId}`,
        );
      }
      return resolved;
    } catch {
      logger.error(`[SKILL_LOOKUP] Lookup failed for user ${userId}`);
      return [];
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

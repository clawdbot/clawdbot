import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  createSkill,
  getSkillByName,
  invalidateSkillsMaterializeCache,
  listSkills,
  materializeSkillsForUser,
  resolveSkillUserId,
  type SkillRow,
  updateSkill,
} from "../../infra/skills-mysql.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseFrontmatterBlock } from "../../markdown/frontmatter.js";
import { bumpSkillsSnapshotVersion } from "../skills/refresh-state.js";
import {
  type AnyAgentTool,
  jsonResult,
  readNumberParam,
  readStringParam,
  ToolInputError,
} from "./common.js";

const log = createSubsystemLogger("skill-tool");

// Names map 1:1 onto a `<workspaceDir>/skills/<name>/` directory at materialize
// time, so keep them to a single safe path segment. The model can pick a slug.
const SKILL_NAME_PATTERN = /^[\w.-]+$/;
const MAX_NAME_LEN = 64;
const MAX_DESCRIPTION_LEN = 1024;
const MAX_CATEGORY_LEN = 128;
// Stay under skills.limits.maxSkillFileBytes (default 256_000) with headroom.
const MAX_CONTENT_BYTES = 200_000;
// `skills.source` is an enum('bundled','managed','workspace','extra'); 'agent'
// is NOT a member, so writing it fails under STRICT_TRANS_TABLES with "Data
// truncated for column 'source'". Agent-saved skills are materialized into the
// user's workspace/skills dir, so 'workspace' is the honest, valid tag.
const SKILL_SOURCE = "workspace";

type SkillToolOptions = {
  /** Trusted session key — the only source of the user id (never model args). */
  agentSessionKey?: string;
  /** Real workspace dir used to materialize the saved skill to disk. */
  workspaceDir?: string;
  agentId?: string;
  config?: OpenClawConfig;
};

/**
 * Resolve the numeric skills `user_id` from the trusted session key/agent id.
 * The model never supplies the user id, so a saved skill can only ever land in
 * the requesting user's own catalog.
 */
function resolveTrustedUserId(opts?: SkillToolOptions): number {
  const raw = resolveSkillUserId(opts?.agentSessionKey, opts?.agentId);
  const numeric = raw ? Number(raw) : Number.NaN;
  if (!raw || !Number.isInteger(numeric) || numeric <= 0) {
    throw new ToolInputError(
      "skill tools require a per-user agent session: could not resolve a numeric user id from the current session.",
    );
  }
  return numeric;
}

function validateSkillName(name: string): string {
  if (name.length > MAX_NAME_LEN) {
    throw new ToolInputError(`name too long (max ${MAX_NAME_LEN} characters)`);
  }
  if (name === "." || name === ".." || !SKILL_NAME_PATTERN.test(name)) {
    throw new ToolInputError(
      "name must be a single safe slug using only letters, digits, '.', '_' or '-' (e.g. my-research-flow)",
    );
  }
  return name;
}

const SkillSaveToolSchema = Type.Object({
  name: Type.String({
    description:
      "Skill slug (letters/digits/.-_ only). Reusing an existing name edits that skill in place.",
  }),
  description: Type.Optional(
    Type.String({
      description:
        "One-line summary used to decide when this skill applies. Keep it specific. Required when creating a new skill; omit when editing to keep the current one.",
    }),
  ),
  content: Type.Optional(
    Type.String({
      description:
        "Full SKILL.md body (markdown). Capture the reusable workflow: what it does, when to use it, and the concrete steps/commands. Required when creating a new skill; omit when editing to keep the current body.",
    }),
  ),
  category: Type.Optional(Type.String({ description: "Optional grouping label." })),
});

const SkillGetToolSchema = Type.Object({
  name: Type.String({ description: "Skill slug to fetch (as shown by skill_list)." }),
});

const SkillListToolSchema = Type.Object({
  limit: Type.Optional(Type.Number({ description: "Max skills to return (default 50)." })),
});

/**
 * Editing a skill means rewriting its row in the user's skill library. The
 * `<workspace>/skills/<name>/SKILL.md` file is only a projection of that row —
 * it is rewritten from the DB on every materialize pass — so a `write`/`edit`
 * against it is discarded. Say so on every skill tool that the model might
 * otherwise route around with the generic file tools.
 */
const DB_IS_SOURCE_OF_TRUTH_NOTE =
  "The skill library (database) is the source of truth: `workspace/skills/<name>/SKILL.md` is a read-only projection that gets overwritten from it, so editing that file with `write`/`edit` changes nothing.";

async function loadExistingSkill(name: string, userId: number): Promise<SkillRow | null> {
  try {
    return await getSkillByName(name, userId);
  } catch (err) {
    // Never surface raw DB/SQL errors (host, query fragments) to the model
    // output — keep the failure generic and log details internally.
    log.warn(`skill lookup for "${name}" failed: ${formatErrorMessage(err)}`);
    throw new ToolInputError("Could not reach the skill library right now. Please try again.");
  }
}

/**
 * skill_save — create or edit a reusable skill in the user's DB-backed catalog.
 * Upserts by name, then materializes it to disk and bumps the skills snapshot
 * version so it becomes available from the user's next message — no gateway
 * restart required.
 *
 * When the skill already exists, `description`/`content` are optional: whatever
 * is omitted keeps its current value, so a targeted edit (e.g. "tighten the
 * description") does not force the model to restate the whole SKILL.md body.
 */
export function createSkillSaveTool(opts?: SkillToolOptions): AnyAgentTool {
  return {
    label: "Save skill",
    name: "skill_save",
    description: `Create or edit a skill in this user's skill library (DB-backed). This is the ONLY way to change a skill. ${DB_IS_SOURCE_OF_TRUTH_NOTE} When the user asks to modify an existing skill, call skill_get for its current body, then call skill_save with the same \`name\` — fields you omit keep their current value. \`description\` and \`content\` are required only when creating a new skill. The change takes effect from the user's next message (no restart).`,
    parameters: SkillSaveToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const userId = resolveTrustedUserId(opts);

      const name = validateSkillName(readStringParam(params, "name", { required: true }));
      const existing = await loadExistingSkill(name, userId);

      const description = readStringParam(params, "description");
      if (description && description.length > MAX_DESCRIPTION_LEN) {
        throw new ToolInputError(`description too long (max ${MAX_DESCRIPTION_LEN} characters)`);
      }
      const content = readStringParam(params, "content");
      if (content && Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
        throw new ToolInputError(`content too large (max ${MAX_CONTENT_BYTES} bytes)`);
      }
      if (!existing && (!description || !content)) {
        throw new ToolInputError(
          `no skill named "${name}" exists yet, so this creates a new one: both description and content are required.`,
        );
      }
      const category = readStringParam(params, "category");
      if (category && category.length > MAX_CATEGORY_LEN) {
        throw new ToolInputError(`category too long (max ${MAX_CATEGORY_LEN} characters)`);
      }

      let action: "created" | "updated";
      let id: number;
      try {
        if (existing) {
          await updateSkill(
            existing.id,
            {
              slug: name,
              // Omitted fields keep their stored value: only pass through what
              // the caller actually supplied.
              ...(description ? { description } : {}),
              ...(content ? { content } : {}),
              source: SKILL_SOURCE,
              ...(category ? { category } : {}),
              is_enable: 1,
            },
            userId,
          );
          action = "updated";
          id = existing.id;
        } else {
          const created = await createSkill(
            {
              name: parseFrontmatterBlock(content ?? "").title ?? name,
              slug: name,
              description,
              content,
              source: SKILL_SOURCE,
              category,
            },
            userId,
          );
          action = "created";
          id = created.id;
        }
      } catch (err) {
        // Never surface raw DB/SQL errors (host, query fragments) to the model
        // output — keep the failure generic and log details internally.
        log.warn(`skill_save: persisting "${name}" failed: ${formatErrorMessage(err)}`);
        throw new ToolInputError("Could not save the skill right now. Please try again.");
      }

      // Make the saved skill visible to the next turn: drop the materialize
      // short-circuit, re-write SKILL.md to disk + reprime the cache, then bump
      // the snapshot version so the run loop rebuilds <available_skills>.
      invalidateSkillsMaterializeCache();
      if (opts?.workspaceDir) {
        try {
          await materializeSkillsForUser(opts.workspaceDir, String(userId));
        } catch (err) {
          // Non-fatal: the DB write already committed; the next turn's own
          // materialize pass will pick it up even if this best-effort one fails.
          log.warn(`skill_save: materialize after save failed: ${formatErrorMessage(err)}`);
        }
      }
      bumpSkillsSnapshotVersion({
        workspaceDir: opts?.workspaceDir,
        reason: "manual",
        changedPath: `skills/${name}/SKILL.md`,
      });

      return jsonResult({
        ok: true,
        action,
        id,
        name,
        note: `Skill ${action} in the user's skill library. It takes effect from your next message in this conversation (no restart needed).`,
      });
    },
  };
}

/**
 * skill_get — read one skill's stored body straight from the user's catalog, so
 * an edit round-trips through the DB (read row -> revise -> skill_save) instead
 * of through the disposable `<workspace>/skills/<name>/SKILL.md` projection.
 */
export function createSkillGetTool(opts?: SkillToolOptions): AnyAgentTool {
  return {
    label: "Read skill",
    name: "skill_get",
    description: `Read one of this user's saved skills — its description and full SKILL.md body — from the skill library. Use this before editing a skill, then pass the revised body to skill_save under the same name. ${DB_IS_SOURCE_OF_TRUTH_NOTE}`,
    parameters: SkillGetToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const userId = resolveTrustedUserId(opts);
      const name = validateSkillName(readStringParam(params, "name", { required: true }));

      const row = await loadExistingSkill(name, userId);
      if (!row) {
        return jsonResult({
          ok: true,
          found: false,
          name,
          note: "No skill with that name in this user's library. Use skill_list to see the exact names.",
        });
      }
      return jsonResult({
        ok: true,
        found: true,
        id: row.id,
        name: row.slug ?? row.name,
        title: row.name,
        description: row.description ?? "",
        category: row.category ?? undefined,
        enabled: row.is_enable === 1,
        content: row.content ?? "",
      });
    },
  };
}

/**
 * skill_list — list the user's own saved skills so the agent can check existing
 * names/descriptions before saving (e.g. to deliberately overwrite one).
 */
export function createSkillListTool(opts?: SkillToolOptions): AnyAgentTool {
  return {
    label: "List skills",
    name: "skill_list",
    description: `List this user's saved skills with their names and descriptions. Use it to resolve the exact name the user means before skill_get / skill_save. ${DB_IS_SOURCE_OF_TRUTH_NOTE}`,
    parameters: SkillListToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const userId = resolveTrustedUserId(opts);
      const limit = readNumberParam(params, "limit", { integer: true });

      let skills: Awaited<ReturnType<typeof listSkills>>["skills"];
      let total: number;
      try {
        ({ skills, total } = await listSkills(userId, {
          limit: limit !== undefined && limit > 0 ? limit : undefined,
        }));
      } catch (err) {
        log.warn(`skill_list failed: ${formatErrorMessage(err)}`);
        throw new ToolInputError("Could not list skills right now. Please try again.");
      }
      return jsonResult({
        ok: true,
        total,
        skills: skills.map((row) => ({
          id: row.id,
          name: row.slug ?? row.name,
          title: row.name,
          description: row.description ?? "",
          enabled: row.is_enable === 1,
          source: row.source,
          category: row.category ?? undefined,
        })),
      });
    },
  };
}

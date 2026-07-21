// Doctor migration for sessions mis-keyed as agent:main:* inside a non-main default's store.
import fs from "node:fs";
import { resolveStorePath } from "../../../config/sessions/paths.js";
import { migrateSqliteSessionEntryKeys } from "../../../config/sessions/session-accessor.sqlite.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeAgentId, normalizeMainKey } from "../../../routing/session-key.js";

const LEGACY_IMPLICIT_AGENT_ID = "main";

export async function maybeMigrateLegacyDefaultMainSessionKeys(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ changes: string[]; warnings: string[] }> {
  const agents = cfg.agents?.list ?? [];
  if (agents.length === 0) {
    return { changes: [], warnings: [] };
  }
  const defaults = agents.filter((agent) => agent.default === true);
  if (defaults.length !== 1 || typeof defaults[0]?.id !== "string") {
    return {
      changes: [],
      warnings: [
        "Skipped legacy main-session key migration because the roster has no unique explicit default.",
      ],
    };
  }
  const defaultAgentId = normalizeAgentId(defaults[0].id);
  if (defaultAgentId === LEGACY_IMPLICIT_AGENT_ID) {
    return { changes: [], warnings: [] };
  }
  if (agents.some((agent) => normalizeAgentId(agent.id) === LEGACY_IMPLICIT_AGENT_ID)) {
    return { changes: [], warnings: [] };
  }

  const configuredStore = cfg.session?.store?.trim();
  const storePath = resolveStorePath(configuredStore, { agentId: defaultAgentId, env });
  const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, {
    agentId: defaultAgentId,
  }).path;
  if (!fs.existsSync(sqlitePath)) {
    return { changes: [], warnings: [] };
  }

  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const canonicalKey = `agent:${defaultAgentId}:${mainKey}`;
  const legacyKeys = [...new Set([`agent:main:${mainKey}`, "agent:main:main"])];
  const outcome = await migrateSqliteSessionEntryKeys({
    agentId: defaultAgentId,
    storePath,
    canonicalKey,
    legacyKeys,
  });
  if (outcome.status === "missing") {
    return { changes: [], warnings: [] };
  }
  if (outcome.status === "canonical-exists") {
    return {
      changes: [],
      warnings: [
        `Skipped legacy main-session key migration because ${canonicalKey} already exists.`,
      ],
    };
  }
  if (outcome.status === "aliases-disagree") {
    return {
      changes: [],
      warnings: ["Skipped legacy main-session key migration because its aliases disagree."],
    };
  }
  if (outcome.status === "legacy-present") {
    throw new Error("Unexpected dry-run session migration outcome.");
  }
  return {
    changes: [`Migrated legacy main-session key to ${canonicalKey}.`],
    warnings: [],
  };
}

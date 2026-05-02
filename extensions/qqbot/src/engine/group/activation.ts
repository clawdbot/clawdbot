/**
 * Group activation mode — how the bot decides whether to respond in a group.
 *
 * Resolution chain:
 *   1. session store override (`/activation` command writes per-session
 *      `groupActivation` value) — highest priority
 *   2. per-group `requireMention` config
 *   3. `"mention"` default (require @-bot to respond)
 *
 * File I/O is isolated in the default node-based reader so the gating
 * logic itself stays a pure function, testable without touching disk.
 *
 * Note: the implicit-mention predicate (quoting a bot message counts as
 * @-ing the bot) lives in `./mention.ts` alongside the other mention
 * helpers — see `resolveImplicitMention` there.
 */

import fs from "node:fs";
import path from "node:path";

// ────────────────────────── Types ──────────────────────────

/** High-level activation outcome. */
export type GroupActivationMode = "mention" | "always";

/**
 * Pluggable reader that returns parsed session-store contents.
 *
 * A return value of `null` means "no override available" (file missing,
 * parse error, or reader disabled). Implementations must **not** throw —
 * the gating pipeline treats any failure as "fall back to the config
 * default".
 */
export interface SessionStoreReader {
  read(params: {
    cfg: Record<string, unknown>;
    agentId: string;
  }): Record<string, { groupActivation?: string }> | null;
}

// ────────────────────────── groupActivation ──────────────────────────

/**
 * Resolve the effective activation mode for one inbound message.
 *
 * Order of precedence:
 *   1. `store[sessionKey].groupActivation` (read via the injected reader)
 *   2. config-level `requireMention` (maps to `"mention"` / `"always"`)
 *   3. `"mention"` (safe default)
 */
export function resolveGroupActivation(params: {
  cfg: Record<string, unknown>;
  agentId: string;
  sessionKey: string;
  configRequireMention: boolean;
  /** Pluggable reader; omit to disable the session-store override. */
  sessionStoreReader?: SessionStoreReader;
}): GroupActivationMode {
  const fallback: GroupActivationMode = params.configRequireMention ? "mention" : "always";

  const store = params.sessionStoreReader?.read({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (!store) {
    return fallback;
  }

  const entry = store[params.sessionKey];
  if (!entry?.groupActivation) {
    return fallback;
  }

  const normalized = entry.groupActivation.trim().toLowerCase();
  if (normalized === "mention" || normalized === "always") {
    return normalized;
  }
  return fallback;
}

// ────────────────────────── Default node reader ──────────────────────────

/**
 * Resolve the on-disk path to the agent-sessions file.
 *
 * Priority:
 *   1. `cfg.session.store` (supports `{agentId}` placeholder and `~` expansion)
 *   2. `$OPENCLAW_STATE_DIR` / `$CLAWDBOT_STATE_DIR`
 *   3. `~/.openclaw/agents/{agentId}/sessions/sessions.json`
 */
function resolveSessionStorePath(
  cfg: Record<string, unknown>,
  agentId: string | undefined,
): string {
  const resolvedAgentId = agentId || "default";

  const session =
    typeof cfg.session === "object" && cfg.session !== null
      ? (cfg.session as { store?: unknown })
      : undefined;
  const rawStore = typeof session?.store === "string" ? session.store : undefined;

  if (rawStore) {
    let expanded = rawStore;
    if (expanded.includes("{agentId}")) {
      expanded = expanded.replaceAll("{agentId}", resolvedAgentId);
    }
    if (expanded.startsWith("~")) {
      const home = process.env.HOME || process.env.USERPROFILE || "";
      expanded = expanded.replace(/^~/, home);
    }
    return path.resolve(expanded);
  }

  const stateDir =
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim() ||
    path.join(process.env.HOME || process.env.USERPROFILE || "", ".openclaw");
  return path.join(stateDir, "agents", resolvedAgentId, "sessions", "sessions.json");
}

/**
 * Create the default, production-ready session-store reader.
 *
 * Reads the file synchronously on every call. The overhead is acceptable
 * because activation mode is only resolved once per group message and
 * the sessions file is typically a handful of kilobytes.
 *
 * Any I/O or JSON error is swallowed and returned as `null` so the
 * gating pipeline falls back to the config default.
 */
export function createNodeSessionStoreReader(): SessionStoreReader {
  return {
    read: ({ cfg, agentId }) => {
      try {
        const storePath = resolveSessionStorePath(cfg, agentId);
        if (!fs.existsSync(storePath)) {
          return null;
        }
        const raw = fs.readFileSync(storePath, "utf-8");
        return JSON.parse(raw) as Record<string, { groupActivation?: string }>;
      } catch {
        return null;
      }
    },
  };
}

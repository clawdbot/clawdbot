// Qqbot plugin module implements activation behavior.
import path from "node:path";
import { loadSessionStore } from "openclaw/plugin-sdk/session-store-runtime";

export type GroupActivationMode = "mention" | "always";

export interface SessionStoreReader {
  read(params: {
    cfg: Record<string, unknown>;
    agentId: string;
  }): Record<string, { groupActivation?: string }> | null;
}

export function resolveGroupActivation(params: {
  cfg: Record<string, unknown>;
  agentId: string;
  sessionKey: string;
  configRequireMention: boolean;
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

export function createNodeSessionStoreReader(): SessionStoreReader {
  return {
    read: ({ cfg, agentId }) => {
      try {
        const storePath = resolveSessionStorePath(cfg, agentId);
        return loadSessionStore(storePath, { skipCache: true }) as Record<
          string,
          { groupActivation?: string }
        >;
      } catch {
        return null;
      }
    },
  };
}

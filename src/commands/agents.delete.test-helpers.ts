import fs from "node:fs/promises";
import path from "node:path";
import {
  listAgentEntries,
  toAgentEntriesRecord,
  tryResolveSoleAgentId,
} from "../agents/agent-scope-config.js";
import { tryGetLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore, type SessionEntry } from "../config/sessions.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GatewayTransportError } from "../gateway/transport-error.js";
import { parseAgentSessionKey } from "../routing/session-key.js";

export function gatewayTransportError(
  kind: "closed" | "timeout",
  code?: number,
): GatewayTransportError {
  return new GatewayTransportError({
    kind,
    code,
    message: `gateway ${kind}`,
    connectionDetails: { url: "ws://127.0.0.1:1", urlSource: "test", message: "test gateway" },
  });
}

function resolveFixtureStoreAgentId(cfg: OpenClawConfig, deletedAgentId: string): string {
  const storeConfig = cfg.session?.store;
  if (typeof storeConfig === "string" && !storeConfig.includes("{agentId}")) {
    return (
      tryGetLegacyDefaultAgentId(cfg) ??
      listAgentEntries(cfg).find((entry) => entry.default === true)?.id ??
      tryResolveSoleAgentId(cfg) ??
      deletedAgentId
    );
  }
  return deletedAgentId;
}

export function createAgentsDeleteFixture(setConfig: (cfg: OpenClawConfig) => void) {
  return async (params: {
    stateDir: string;
    cfg: OpenClawConfig;
    deletedAgentId?: string;
    sessions: Record<string, { sessionId: string; updatedAt: number }>;
  }) => {
    const deletedAgentId = params.deletedAgentId ?? "ops";
    const authored = structuredClone(params.cfg);
    const roster = listAgentEntries(authored);
    if (!roster.some((entry) => entry.default === true)) {
      const existingDefault = roster.find((entry) => entry.id !== deletedAgentId);
      if (existingDefault) {
        existingDefault.default = true;
      } else {
        roster.unshift({ id: "main", default: true });
      }
    }
    const { list: _legacyList, ...agents } = authored.agents ?? {};
    const cfg: OpenClawConfig = {
      ...authored,
      agents: { ...agents, entries: toAgentEntriesRecord(roster) },
    };
    const storeAgentId = resolveFixtureStoreAgentId(cfg, deletedAgentId);
    for (const [sessionKey, entry] of Object.entries(params.sessions)) {
      const entryAgentId = parseAgentSessionKey(sessionKey)?.agentId ?? storeAgentId;
      const entryStorePath = resolveSessionStorePathCore(cfg.session?.store, {
        agentId: entryAgentId,
      });
      await replaceSessionEntry({ agentId: entryAgentId, sessionKey, storePath: entryStorePath }, {
        ...entry,
        delivery: { kind: "none" },
      } satisfies SessionEntry);
    }
    await fs.mkdir(path.join(params.stateDir, `workspace-${deletedAgentId}`), { recursive: true });
    await fs.mkdir(path.join(params.stateDir, "agents", deletedAgentId, "agent"), {
      recursive: true,
    });

    setConfig(cfg);
  };
}

export function readAgentDeleteJsonLogs(
  calls: ReadonlyArray<readonly unknown[]>,
): Array<Record<string, unknown>> {
  return calls
    .filter((call): call is [string, ...unknown[]] => {
      const arg = call[0];
      return typeof arg === "string" && arg.startsWith("{");
    })
    .map((call) => JSON.parse(call[0]) as Record<string, unknown>);
}

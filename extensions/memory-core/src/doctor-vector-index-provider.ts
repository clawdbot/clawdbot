import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

const MEMORY_INDEX_META_KEY = "memory_index_meta_v1";

export type ProviderFailure = {
  provider: string;
  reason: string;
  requirement?: string;
  fixHint?: string;
};
type VectorProviderFinding = ProviderFailure & {
  agentId: string;
  model: string;
  configPrefix: string;
};

type InspectConfiguredProvider = (params: {
  config: OpenClawConfig;
  agentId: string;
  env: NodeJS.ProcessEnv;
}) => Promise<ProviderFailure | null>;

function listConfiguredAgentIds(config: OpenClawConfig): string[] {
  const ids = new Set(Object.keys(config.agents?.entries ?? {}));
  for (const entry of config.agents?.list ?? []) {
    if (entry.id.trim()) {
      ids.add(entry.id.trim());
    }
  }
  return ids.size > 0 ? [...ids] : ["main"];
}

async function readExistingVectorModel(databasePath: string): Promise<string | null> {
  if (!fs.existsSync(databasePath)) {
    return null;
  }
  const { openNodeSqliteDatabase, prepareSqliteReadOnlyLocationSync } =
    await import("openclaw/plugin-sdk/sqlite-runtime");
  let prepared: ReturnType<typeof prepareSqliteReadOnlyLocationSync> | undefined;
  let db: ReturnType<typeof openNodeSqliteDatabase> | undefined;
  let failure: unknown;
  let model: string | null = null;
  try {
    prepared = prepareSqliteReadOnlyLocationSync(databasePath);
    db = openNodeSqliteDatabase(prepared.location, { readOnly: true });
    const table = db
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'memory_index_meta'",
      )
      .get();
    if (table) {
      const row = db
        .prepare("SELECT value FROM memory_index_meta WHERE key = ?")
        .get(MEMORY_INDEX_META_KEY);
      const parsed = typeof row?.value === "string" ? JSON.parse(row.value) : null;
      const configuredModel =
        parsed && typeof parsed === "object" && typeof parsed.model === "string"
          ? parsed.model.trim()
          : "";
      model = configuredModel && configuredModel !== "fts-only" ? configuredModel : null;
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      db?.close();
    } catch (error) {
      failure ??= error;
    }
    if (prepared && !prepared.cleanup()) {
      failure ??= new Error("Temporary SQLite inspection snapshot cleanup did not complete.");
    }
  }
  if (failure) {
    throw failure instanceof Error
      ? failure
      : new Error("Memory index inspection failed.", { cause: failure });
  }
  return model;
}

function resolveConfigPrefix(config: OpenClawConfig, agentId: string): string {
  if (config.agents?.entries?.[agentId]?.memory?.search) {
    return `agents.entries.${agentId}.memory.search`;
  }
  if (config.agents?.list?.find((entry) => entry.id === agentId)?.memory?.search) {
    return `agents.list[].memory.search (agent id ${agentId})`;
  }
  return "memory.search";
}

export async function collectVectorProviderFindings(
  params: {
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    stateDir: string;
  },
  inspectProvider: InspectConfiguredProvider,
): Promise<VectorProviderFinding[]> {
  const findings: VectorProviderFinding[] = [];
  for (const agentId of listConfiguredAgentIds(params.config)) {
    // A custom agentDir does not move the canonical per-agent memory index.
    const agentDatabasePath = path.join(
      params.stateDir,
      "agents",
      agentId,
      "agent",
      "openclaw-agent.sqlite",
    );
    const model = await readExistingVectorModel(agentDatabasePath);
    if (!model) {
      continue;
    }
    const failure = await inspectProvider({
      config: params.config,
      agentId,
      env: params.env,
    });
    if (failure) {
      findings.push({
        ...failure,
        agentId,
        model,
        configPrefix: resolveConfigPrefix(params.config, agentId),
      });
    }
  }
  return findings;
}

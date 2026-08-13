import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
// sqlite-runtime re-exports the agent-db/kysely graph; keep it lazy so doctor
// enumeration does not cold-load it with this closure.

const MEMORY_INDEX_META_KEY = "memory_index_meta_v1";

type ProviderFailure = { provider: string; reason: string };
type VectorProviderFinding = ProviderFailure & {
  agentId: string;
  model: string;
  configPrefix: string;
};

async function inspectConfiguredProvider(params: {
  config: OpenClawConfig;
  agentId: string;
  env: NodeJS.ProcessEnv;
  agentDatabasePath: string;
}): Promise<ProviderFailure | null> {
  const [{ resolveAgentConfig }, foundation, embeddings, providerState] = await Promise.all([
    import("openclaw/plugin-sdk/agent-runtime"),
    import("openclaw/plugin-sdk/memory-core-host-engine-foundation"),
    import("../memory/embeddings.js"),
    import("../memory/manager-provider-state.js"),
  ]);
  let settings: ReturnType<typeof foundation.resolveMemorySearchConfig>;
  try {
    settings = foundation.resolveMemorySearchConfig(params.config, params.agentId);
  } catch (error) {
    return {
      provider: params.config.memory?.search?.provider ?? "openai",
      reason: formatErrorMessage(error),
    };
  }
  if (!settings || settings.provider === "none") {
    return null;
  }
  try {
    const configuredAgentDir = resolveAgentConfig(params.config, params.agentId)?.agentDir?.trim();
    const result = await embeddings.createEmbeddingProvider({
      config: params.config,
      agentDir: configuredAgentDir
        ? foundation.resolveUserPath(configuredAgentDir, params.env)
        : path.dirname(params.agentDatabasePath),
      ...providerState.resolveMemoryPrimaryProviderRequest({ settings }),
    });
    await result.provider?.close?.();
    return result.provider
      ? null
      : {
          provider: settings.provider,
          reason: result.providerUnavailableReason ?? "provider did not initialize",
        };
  } catch (error) {
    return { provider: settings.provider, reason: formatErrorMessage(error) };
  }
}

const deps = { inspectConfiguredProvider };
const testing = {
  setInspectConfiguredProviderForTest(inspect: typeof inspectConfiguredProvider): void {
    deps.inspectConfiguredProvider = inspect;
  },
  reset(): void {
    deps.inspectConfiguredProvider = inspectConfiguredProvider;
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.memoryCoreVectorIndexProviderDiagnosticTestApi")
  ] = testing;
}

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
  const { openNodeSqliteDatabase } = await import("openclaw/plugin-sdk/sqlite-runtime");
  let db: ReturnType<typeof openNodeSqliteDatabase> | undefined;
  try {
    db = openNodeSqliteDatabase(databasePath, { readOnly: true });
    const row = db
      .prepare("SELECT value FROM memory_index_meta WHERE key = ?")
      .get(MEMORY_INDEX_META_KEY) as { value?: unknown } | undefined;
    const parsed = typeof row?.value === "string" ? JSON.parse(row.value) : null;
    const model =
      parsed && typeof parsed === "object" && typeof parsed.model === "string"
        ? parsed.model.trim()
        : "";
    return model && model !== "fts-only" ? model : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
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

function hasConfiguredMemorySecretRef(config: OpenClawConfig, agentId: string): boolean {
  const agent =
    config.agents?.entries?.[agentId] ?? config.agents?.list?.find((entry) => entry.id === agentId);
  const apiKey = agent?.memory?.search?.remote?.apiKey ?? config.memory?.search?.remote?.apiKey;
  return apiKey !== null && typeof apiKey === "object";
}

async function collectVectorProviderFindings(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
}): Promise<VectorProviderFinding[]> {
  const findings: VectorProviderFinding[] = [];
  for (const agentId of listConfiguredAgentIds(params.config)) {
    // Memory indexes always live in the canonical per-agent state DB; a custom
    // agentDir affects provider credential lookup, not index storage.
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
    // Status owns SecretRef resolution diagnostics. Doctor must not treat an
    // unresolved ref object as an API key and report a false provider failure.
    if (hasConfiguredMemorySecretRef(params.config, agentId)) {
      continue;
    }
    const failure = await deps.inspectConfiguredProvider({
      config: params.config,
      agentId,
      env: params.env,
      agentDatabasePath,
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

function formatFinding(finding: VectorProviderFinding): string {
  return (
    `Memory index for agent ${finding.agentId} uses vector model ${finding.model}, but embedding provider ` +
    `"${finding.provider}" cannot initialize (${finding.reason}). Set ${finding.configPrefix}.remote.apiKey ` +
    `(for example, to a SecretRef) or choose a working ${finding.configPrefix}.provider. ` +
    "Memory sync will abort rather than overwrite this semantic index with FTS-only data."
  );
}

export const vectorIndexProviderDiagnostic: PluginDoctorStateMigration = {
  id: "memory-core-vector-index-provider-diagnostic",
  label: "Memory Core vector index provider readiness",
  async detectLegacyState(params) {
    const findings = await collectVectorProviderFindings(params);
    return findings.length > 0
      ? { preview: findings.map((finding) => `- ${formatFinding(finding)}`) }
      : null;
  },
  async migrateLegacyState(params) {
    const findings = await collectVectorProviderFindings(params);
    return { changes: [], warnings: findings.map(formatFinding) };
  },
};

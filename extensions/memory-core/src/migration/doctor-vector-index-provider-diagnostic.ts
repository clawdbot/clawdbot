import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";

const MEMORY_INDEX_META_KEY = "memory_index_meta_v1";

type ProviderFailure = { provider: string; reason: string };
type VectorProviderFinding = ProviderFailure & {
  agentId: string;
  model: string;
  configPrefix: string;
};

export type InspectConfiguredProvider = (params: {
  config: OpenClawConfig;
  agentId: string;
  env: NodeJS.ProcessEnv;
  agentDatabasePath: string;
}) => Promise<ProviderFailure | null>;

type ProviderStartupInspection =
  | { status: "ready" }
  | {
      status: "blocked";
      issues: Array<{
        provider: string;
        code: string;
        message: string;
        remediation?: readonly string[];
      }>;
    }
  | { status: "indeterminate"; reason: string };

export type InspectConfiguredProviderStartup = (
  params: Parameters<InspectConfiguredProvider>[0],
) => Promise<ProviderStartupInspection>;

function listConfiguredAgentIds(config: OpenClawConfig): string[] {
  const ids = new Set(Object.keys(config.agents?.entries ?? {}));
  for (const entry of config.agents?.list ?? []) {
    if (entry.id.trim()) {
      ids.add(entry.id.trim());
    }
  }
  return ids.size > 0 ? [...ids] : ["main"];
}

async function inspectExistingVectorModel(
  databasePath: string,
  resolveSqliteReadOnlyLocation: (pathname: string) => string = (pathname) => pathname,
): Promise<string | null> {
  if (!fs.existsSync(databasePath)) {
    return null;
  }
  const { openNodeSqliteDatabase } = await import("openclaw/plugin-sdk/sqlite-runtime");
  let db: ReturnType<typeof openNodeSqliteDatabase> | undefined;
  try {
    db = openNodeSqliteDatabase(resolveSqliteReadOnlyLocation(databasePath), { readOnly: true });
    const row = db
      .prepare("SELECT value FROM memory_index_meta WHERE key = ?")
      .get(MEMORY_INDEX_META_KEY) as { value?: unknown } | undefined;
    const parsed = typeof row?.value === "string" ? JSON.parse(row.value) : null;
    const model =
      parsed && typeof parsed === "object" && typeof parsed.model === "string"
        ? parsed.model.trim()
        : "";
    return model && model !== "fts-only" ? model : null;
  } finally {
    db?.close();
  }
}

async function readExistingVectorModel(databasePath: string): Promise<string | null> {
  try {
    return await inspectExistingVectorModel(databasePath);
  } catch {
    return null;
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

async function collectVectorProviderFindings(
  params: {
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    stateDir: string;
  },
  inspectProvider: InspectConfiguredProvider,
): Promise<VectorProviderFinding[]> {
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
    const failure = await inspectProvider({
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

export function createVectorIndexProviderDiagnostic(
  inspectProvider: InspectConfiguredProvider,
  inspectProviderStartup: InspectConfiguredProviderStartup,
): PluginDoctorStateMigration {
  return {
    id: "memory-core-vector-index-provider-diagnostic",
    label: "Memory Core vector index provider readiness",
    async preflightStartup(params) {
      const findings: Array<{
        id: string;
        code: string;
        message: string;
        remediation?: readonly string[];
        agentId: string;
        provider: string;
        model: string;
        configPath: string;
      }> = [];
      const indeterminate: string[] = [];
      for (const agentId of listConfiguredAgentIds(params.config)) {
        const agentDatabasePath = path.join(
          params.stateDir,
          "agents",
          agentId,
          "agent",
          "openclaw-agent.sqlite",
        );
        let model: string | null;
        try {
          model = await inspectExistingVectorModel(
            agentDatabasePath,
            params.resolveSqliteReadOnlyLocation,
          );
        } catch (error) {
          indeterminate.push(
            `Could not inspect the memory index for agent ${agentId}: ${formatErrorMessage(error)}`,
          );
          continue;
        }
        if (!model || hasConfiguredMemorySecretRef(params.config, agentId)) {
          continue;
        }
        const result = await inspectProviderStartup({
          config: params.config,
          agentId,
          env: params.env,
          agentDatabasePath,
        });
        if (result.status === "ready") {
          continue;
        }
        if (result.status === "indeterminate") {
          indeterminate.push(`Agent ${agentId}: ${result.reason}`);
          continue;
        }
        const configPath = resolveConfigPrefix(params.config, agentId);
        for (const issue of result.issues) {
          findings.push({
            id: `${agentId}/${issue.provider}/${issue.code}`,
            code: issue.code,
            message:
              `Memory index for agent ${agentId} uses vector model ${model}, but embedding provider ` +
              `"${issue.provider}" has a startup prerequisite blocker: ${issue.message}`,
            ...(issue.remediation ? { remediation: issue.remediation } : {}),
            agentId,
            provider: issue.provider,
            model,
            configPath,
          });
        }
      }
      if (indeterminate.length > 0) {
        return {
          status: "indeterminate",
          reason: indeterminate.toSorted().join(" "),
          ...(findings.length > 0 ? { findings } : {}),
        };
      }
      return findings.length > 0 ? { status: "blocked", findings } : { status: "ready" };
    },
    async detectLegacyState(params) {
      const findings = await collectVectorProviderFindings(params, inspectProvider);
      return findings.length > 0
        ? { preview: findings.map((finding) => `- ${formatFinding(finding)}`) }
        : null;
    },
    async migrateLegacyState(params) {
      const findings = await collectVectorProviderFindings(params, inspectProvider);
      return { changes: [], warnings: findings.map(formatFinding) };
    },
  };
}

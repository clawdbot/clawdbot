import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listPluginDoctorStateMigrationEntries } from "../plugins/doctor-contract-registry.js";
import { resolveMemoryEmbeddingProviderStartupInspector } from "../plugins/embedding-provider-preflight-public-artifacts.js";
import { formatErrorMessage } from "./errors.js";

export type GatewayStartupPreflightBlocker = {
  id: string;
  pluginId: string;
  migrationId: string;
  code: string;
  message: string;
  remediation?: readonly string[];
  agentId?: string;
  provider?: string;
  model?: string;
  configPath?: string;
};

export type GatewayStartupPreflightError = {
  id: string;
  pluginId?: string;
  migrationId?: string;
  code: string;
  message: string;
};

type GatewayStartupPreflightEvaluation = {
  checksRun: number;
  blockers: GatewayStartupPreflightBlocker[];
  errors: GatewayStartupPreflightError[];
};

function compareById(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}

function appendBlockers(params: {
  blockers: GatewayStartupPreflightBlocker[];
  pluginId: string;
  migrationId: string;
  findings: readonly import("../plugins/doctor-contract-module.js").PluginStartupPreflightFinding[];
}): void {
  const inspectionId = `${params.pluginId}/${params.migrationId}`;
  for (const finding of params.findings) {
    params.blockers.push({
      id: `${inspectionId}/${finding.id}`,
      pluginId: params.pluginId,
      migrationId: params.migrationId,
      code: finding.code,
      message: finding.message,
      ...(finding.remediation ? { remediation: finding.remediation } : {}),
      ...(finding.agentId ? { agentId: finding.agentId } : {}),
      ...(finding.provider ? { provider: finding.provider } : {}),
      ...(finding.model ? { model: finding.model } : {}),
      ...(finding.configPath ? { configPath: finding.configPath } : {}),
    });
  }
}

export async function collectGatewayStartupPreflight(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  resolveSqliteReadOnlyLocation: (pathname: string) => string;
}): Promise<GatewayStartupPreflightEvaluation> {
  const env = params.env ?? process.env;
  const stateDir = resolveStateDir(env);
  const oauthDir = resolveOAuthDir(env, stateDir);
  const blockers: GatewayStartupPreflightBlocker[] = [];
  const errors: GatewayStartupPreflightError[] = [];
  let checksRun = 0;

  for (const entry of listPluginDoctorStateMigrationEntries({
    config: params.config,
    env,
  })) {
    const inspect = entry.migration.preflightStartup;
    if (!inspect || entry.migration.doctorOnly === true) {
      continue;
    }
    checksRun += 1;
    const inspectionId = `${entry.pluginId}/${entry.migration.id}`;
    try {
      const result = await inspect({
        config: params.config,
        env,
        stateDir,
        oauthDir,
        resolveSqliteReadOnlyLocation: params.resolveSqliteReadOnlyLocation,
        resolveEmbeddingProviderStartupInspector: (providerId, config) =>
          resolveMemoryEmbeddingProviderStartupInspector({
            providerId,
            config,
            env,
          }),
      });
      if (result.status === "ready") {
        continue;
      }
      if (result.status === "indeterminate") {
        if (result.findings?.length) {
          appendBlockers({
            blockers,
            pluginId: entry.pluginId,
            migrationId: entry.migration.id,
            findings: result.findings,
          });
        }
        errors.push({
          id: inspectionId,
          pluginId: entry.pluginId,
          migrationId: entry.migration.id,
          code: "inspection-indeterminate",
          message: result.reason,
        });
        continue;
      }
      if (result.findings.length === 0) {
        errors.push({
          id: inspectionId,
          pluginId: entry.pluginId,
          migrationId: entry.migration.id,
          code: "invalid-inspection-result",
          message: `${entry.migration.label} reported blocked without findings.`,
        });
        continue;
      }
      appendBlockers({
        blockers,
        pluginId: entry.pluginId,
        migrationId: entry.migration.id,
        findings: result.findings,
      });
    } catch (error) {
      errors.push({
        id: inspectionId,
        pluginId: entry.pluginId,
        migrationId: entry.migration.id,
        code: "inspection-failed",
        message: formatErrorMessage(error),
      });
    }
  }

  return {
    checksRun,
    blockers: blockers.toSorted(compareById),
    errors: errors.toSorted(compareById),
  };
}

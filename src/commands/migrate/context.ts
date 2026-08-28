/** Migration provider context and report-directory helpers. */
import path from "node:path";
import { isValidAgentId, normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { timestampMsToIsoFileStamp } from "@openclaw/normalization-core/number-coercion";
import { resolveConfiguredAgentId } from "../../agents/agent-scope-config.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MigrationProviderContext } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";

/** Builds a migration logger that keeps JSON stdout machine-readable. */
export function createMigrationLogger(runtime: RuntimeEnv, opts: { json?: boolean } = {}) {
  const info = opts.json ? runtime.error : runtime.log;
  return {
    debug: (message: string) => {
      if (process.env.OPENCLAW_VERBOSE === "1") {
        info(message);
      }
    },
    info: (message: string) => info(message),
    warn: (message: string) => runtime.error(message),
    error: (message: string) => runtime.error(message),
  };
}

/** Builds the timestamped directory where a provider writes migration reports. */
export function buildMigrationReportDir(
  providerId: string,
  stateDir: string,
  nowMs = Date.now(),
): string {
  const stamp = timestampMsToIsoFileStamp(nowMs);
  return path.join(stateDir, "migration", providerId, stamp);
}

/** Resolves an explicit migration owner without allowing typo-created agent stores. */
export function resolveMigrationTargetAgentId(
  config: OpenClawConfig,
  rawAgentId: string | undefined,
): string | undefined {
  const raw = rawAgentId?.trim();
  if (rawAgentId !== undefined && !raw) {
    throw new Error("--agent must not be blank");
  }
  if (!raw) {
    return undefined;
  }
  if (!isValidAgentId(raw)) {
    throw new Error(`Invalid agent id "${raw}".`);
  }
  const agentId = normalizeAgentId(raw);
  return resolveConfiguredAgentId(config, agentId);
}

/** Builds the provider-facing migration context from CLI options and runtime state. */
export function buildMigrationContext(params: {
  source?: string;
  targetAgentId?: string;
  itemKinds?: readonly string[];
  includeSecrets?: boolean;
  overwrite?: boolean;
  providerOptions?: Record<string, unknown>;
  backupPath?: string;
  configOverride?: OpenClawConfig;
  runtime: RuntimeEnv;
  reportDir?: string;
  json?: boolean;
}): MigrationProviderContext {
  const config = params.configOverride ?? getRuntimeConfig();
  const stateDir = resolveStateDir();
  return {
    config,
    stateDir,
    targetAgentId: resolveMigrationTargetAgentId(config, params.targetAgentId),
    itemKinds: params.itemKinds,
    source: params.source,
    includeSecrets: Boolean(params.includeSecrets),
    overwrite: Boolean(params.overwrite),
    providerOptions: params.providerOptions,
    backupPath: params.backupPath,
    reportDir: params.reportDir,
    logger: createMigrationLogger(params.runtime, { json: params.json }),
  };
}

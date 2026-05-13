import path from "node:path";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import type { MigrationProviderContext } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";

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

export function buildMigrationReportDir(
  providerId: string,
  stateDir: string,
  nowMs = Date.now(),
): string {
  const stamp = new Date(nowMs).toISOString().replaceAll(":", "-");
  return path.join(stateDir, "migration", providerId, stamp);
}

export function buildMigrationContext(params: {
  source?: string;
  includeSecrets?: boolean;
  overwrite?: boolean;
  providerOptions?: Record<string, unknown>;
  backupPath?: string;
  runtime: RuntimeEnv;
  reportDir?: string;
  json?: boolean;
}): MigrationProviderContext {
  const config = getRuntimeConfig();
  const stateDir = resolveStateDir();
  return {
    config,
    stateDir,
    source: params.source,
    includeSecrets: Boolean(params.includeSecrets),
    overwrite: Boolean(params.overwrite),
    providerOptions: params.providerOptions,
    backupPath: params.backupPath,
    reportDir: params.reportDir,
    logger: createMigrationLogger(params.runtime, { json: params.json }),
  };
}

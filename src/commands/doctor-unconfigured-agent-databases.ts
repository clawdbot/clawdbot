import fs from "node:fs";
import path from "node:path";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { discoverAgentDatabaseMigrationTargets } from "../infra/state-migrations.media-persistence-targets.js";
import { listOpenClawRegisteredAgentDatabases } from "../state/openclaw-agent-db-registry.js";

function isDefaultAgentDatabasePath(pathname: string, stateDir: string): boolean {
  const relativePath = path.relative(stateDir, pathname);
  const segments = relativePath.split(path.sep);
  return (
    segments.length === 4 &&
    segments[0] === "agents" &&
    segments[2] === "agent" &&
    segments[3] === "openclaw-agent.sqlite"
  );
}

/** Report retained stores without turning roster absence into deletion authority. */
export function collectRetainedUnconfiguredAgentDatabaseWarnings(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const env = params.env ?? process.env;
  try {
    const stateDir = fs.realpathSync.native(resolveStateDir(env));
    const registeredAgentDatabases = listOpenClawRegisteredAgentDatabases({
      env,
      includeIncompatibleSchemaVersions: true,
    });
    const configuredAgentDatabaseTargets = resolveConfiguredAgentDatabaseTargets(params.cfg, {
      env,
      registeredDatabases: registeredAgentDatabases,
    });
    const discovery = discoverAgentDatabaseMigrationTargets({
      configuredAgentDatabaseTargets,
      registeredAgentDatabases,
      env,
    });
    const retainedDatabaseWarnings = discovery.targets.flatMap((target) => {
      if (target.source === "configured" || isDefaultAgentDatabasePath(target.realPath, stateDir)) {
        return [];
      }
      return [
        `- Retained unconfigured agent database "${sanitizeForLog(target.agentId)}" at ${sanitizeForLog(target.path)}. Doctor will not remove it automatically because it may contain retired or manually managed agent state.`,
      ];
    });
    return [...retainedDatabaseWarnings, ...discovery.externalWarnings];
  } catch (error) {
    return [
      `- Could not inspect retained unconfigured agent databases: ${sanitizeForLog(formatErrorMessage(error))}`,
    ];
  }
}

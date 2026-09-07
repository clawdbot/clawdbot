import { isAgentDeletionBlocked } from "../agents/agent-lifecycle-registry.js";
import { listAgentIds, tryResolveAmbientOwnerAgentId } from "../agents/agent-scope.js";
import { tryGetLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getChildLogger } from "../logging/logger.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { CronService } from "./service.js";
import { resolveCronJobsStorePath } from "./store.js";

export async function withLocalAgentCronJobsRemoved<T>(
  agentId: string,
  getRuntimeConfig: () => OpenClawConfig,
  commit: () => Promise<T>,
): Promise<T> {
  const cfg = getRuntimeConfig();
  const storePath = resolveCronJobsStorePath();
  const service = new CronService({
    storePath,
    cronEnabled: cfg.cron?.enabled !== false,
    cronConfig: cfg.cron,
    log: getChildLogger({ module: "cron", storeKey: storePath }),
    defaultAgentId: tryResolveAmbientOwnerAgentId(cfg),
    legacyDefaultAgentId: tryGetLegacyDefaultAgentId(cfg),
    resolveDefaultAgentId: () => tryResolveAmbientOwnerAgentId(getRuntimeConfig()),
    isAgentAvailable: (id) =>
      !isAgentDeletionBlocked(id) &&
      listAgentIds(getRuntimeConfig()).some(
        (configuredId) => normalizeAgentId(configuredId) === id,
      ),
    enqueueSystemEvent: () => false,
    requestHeartbeat: () => {},
    runIsolatedAgentJob: async () => {
      throw new Error("Cron execution is unavailable in local service context.");
    },
  });
  try {
    return await service.removeAgentJobsTransactional(agentId, commit);
  } finally {
    service.stop();
  }
}

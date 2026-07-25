// Audits code paths for deep safety risks that require manual review.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { SecurityAuditFinding } from "./audit.types.js";

/** Lazily load deep audit code paths so normal audits avoid plugin/skill scans. */
const loadAuditDeepModule = createLazyRuntimeModule(() => import("./audit.deep.runtime.js"));

/** Collect plugin and installed-skill code safety findings when deep audit is enabled. */
export async function collectDeepCodeSafetyFindings(params: {
  cfg: OpenClawConfig;
  stateDir: string;
  deep: boolean;
  summaryCache?: Map<string, Promise<unknown>>;
}): Promise<SecurityAuditFinding[]> {
  if (!params.deep) {
    return [];
  }

  const auditDeep = await loadAuditDeepModule();
  return [
    ...(await auditDeep.collectPluginsCodeSafetyFindings({
      stateDir: params.stateDir,
      summaryCache: params.summaryCache,
    })),
    ...(await auditDeep.collectInstalledSkillsCodeSafetyFindings({
      cfg: params.cfg,
      stateDir: params.stateDir,
      summaryCache: params.summaryCache,
    })),
  ];
}

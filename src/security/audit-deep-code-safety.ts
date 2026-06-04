// Audits code paths for deep safety risks that require manual review.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecurityAuditFinding } from "./audit.types.js";

let auditDeepModulePromise: Promise<typeof import("./audit.deep.runtime.js")> | undefined;

/** Lazily load deep audit code paths so normal audits avoid plugin/skill scans. */
async function loadAuditDeepModule() {
  auditDeepModulePromise ??= import("./audit.deep.runtime.js");
  return await auditDeepModulePromise;
}

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

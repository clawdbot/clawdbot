import type { OpenClawConfig } from "../config/config.js";
import type { SecurityAuditFinding } from "./audit.types.js";

let auditDeepModulePromise: Promise<typeof import("./audit.deep.runtime.js")> | undefined;

async function loadAuditDeepModule() {
  auditDeepModulePromise ??= import("./audit.deep.runtime.js");
  return await auditDeepModulePromise;
}

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

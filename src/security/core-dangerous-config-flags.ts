// Detects dangerous core config flags during security audits.
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** List enabled core config flags that intentionally weaken security posture. */
export function collectCoreInsecureOrDangerousFlags(cfg: OpenClawConfig): string[] {
  const enabledFlags: string[] = [];
  if (cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true) {
    enabledFlags.push("gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true");
  }
  if (cfg.hooks?.gmail?.allowUnsafeExternalContent === true) {
    enabledFlags.push("hooks.gmail.allowUnsafeExternalContent=true");
  }
  if (Array.isArray(cfg.hooks?.mappings)) {
    for (const [index, mapping] of cfg.hooks.mappings.entries()) {
      if (mapping?.allowUnsafeExternalContent === true) {
        enabledFlags.push(`hooks.mappings[${index}].allowUnsafeExternalContent=true`);
      }
    }
  }
  if (cfg.tools?.exec?.applyPatch?.workspaceOnly === false) {
    enabledFlags.push("tools.exec.applyPatch.workspaceOnly=false");
  }
  // Suppressions are not insecure by themselves, but they hide audit findings
  // and should be visible in dangerous-flag snapshots.
  const auditSuppressionCount = cfg.security?.audit?.suppressions?.length ?? 0;
  if (auditSuppressionCount > 0) {
    enabledFlags.push(`security.audit.suppressions configured (${auditSuppressionCount})`);
  }
  return enabledFlags;
}

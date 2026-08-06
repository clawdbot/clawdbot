import type { OpenClawConfig } from "../config/config.js";
import { runSecurityAudit } from "./audit.js";
import type { SecurityAuditFinding } from "./audit.types.js";

type AuditOverrides = Omit<Parameters<typeof runSecurityAudit>[0], "config">;

export async function collectSecurityAuditFindings(
  config: OpenClawConfig,
  overrides: AuditOverrides = {},
): Promise<SecurityAuditFinding[]> {
  const report = await runSecurityAudit({
    config,
    sourceConfig: config,
    includeFilesystem: false,
    includeChannelSecurity: false,
    loadPluginSecurityCollectors: false,
    ...overrides,
  });
  return report.findings;
}

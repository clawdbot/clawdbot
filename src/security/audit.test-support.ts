import type { OpenClawConfig } from "../config/config.js";
import { runSecurityAudit } from "./audit.js";
import type { SecurityAuditFinding } from "./audit.types.js";

type AuditOverrides = Omit<Parameters<typeof runSecurityAudit>[0], "config">;

export async function collectSecurityAuditFindings(
  config: OpenClawConfig,
  overrides: AuditOverrides = {},
): Promise<SecurityAuditFinding[]> {
  const runtimeConfig = structuredClone(config);
  runtimeConfig.agents ??= {};
  runtimeConfig.agents.list ??= [];
  if (runtimeConfig.agents.list.length === 0) {
    runtimeConfig.agents.list.push({ id: "main", default: true });
  } else if (!runtimeConfig.agents.list.some((agent) => agent.default === true)) {
    runtimeConfig.agents.list[0]!.default = true;
  }
  const report = await runSecurityAudit({
    config: runtimeConfig,
    sourceConfig: runtimeConfig,
    includeFilesystem: false,
    includeChannelSecurity: false,
    loadPluginSecurityCollectors: false,
    ...overrides,
  });
  return report.findings;
}

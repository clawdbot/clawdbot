import { listAgentEntries, toAgentEntriesRecord } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/config.js";
import { runSecurityAudit } from "./audit.js";
import type { SecurityAuditFinding } from "./audit.types.js";

type AuditOverrides = Omit<Parameters<typeof runSecurityAudit>[0], "config">;

export async function collectSecurityAuditFindings(
  config: OpenClawConfig,
  overrides: AuditOverrides = {},
): Promise<SecurityAuditFinding[]> {
  const roster = listAgentEntries(config);
  const effectiveDefaultId = roster.find((entry) => entry.default === true)?.id ?? roster[0]?.id;
  const normalizedRoster = roster.map((entry) => {
    const normalized = { ...entry };
    if (entry.id === effectiveDefaultId) {
      normalized.default = true;
    } else {
      delete normalized.default;
    }
    return normalized;
  });
  const { list: _legacyList, ...agents } = config.agents ?? {};
  const loadedConfig: OpenClawConfig = {
    ...config,
    agents: {
      ...agents,
      entries:
        roster.length > 0 ? toAgentEntriesRecord(normalizedRoster) : { main: { default: true } },
    },
  };
  const report = await runSecurityAudit({
    config: loadedConfig,
    sourceConfig: config,
    includeFilesystem: false,
    includeChannelSecurity: false,
    loadPluginSecurityCollectors: false,
    ...overrides,
  });
  return report.findings;
}

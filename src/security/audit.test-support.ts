import { listAgentEntries } from "../agents/agent-scope-config.js";
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
  const loadedConfig: OpenClawConfig = {
    ...config,
    agents: {
      ...config.agents,
      entries:
        roster.length > 0
          ? Object.fromEntries(
              roster.map(({ id, ...entry }) => [
                id,
                id === effectiveDefaultId
                  ? { ...entry, default: true }
                  : Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "default")),
              ]),
            )
          : { main: { default: true } },
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

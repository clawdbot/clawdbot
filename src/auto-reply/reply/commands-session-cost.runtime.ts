import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadCostUsageSummary, loadSessionCostSummary } from "../../infra/session-cost-usage.js";
import { DEFAULT_AGENT_ID, isUnscopedSessionKeySentinel } from "../../routing/session-key.js";
import {
  formatCostUsageCachePrefix,
  formatTokenCount,
  formatUsd,
} from "../../utils/usage-format.js";

export async function formatSessionUsageCostSummary(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  sessionEntry?: SessionEntry;
  storePath?: string;
}): Promise<string> {
  const sessionAgentId =
    params.sessionKey && !isUnscopedSessionKeySentinel(params.sessionKey)
      ? resolveSessionAgentId({
          sessionKey: params.sessionKey,
          config: params.cfg,
          agentId: params.agentId,
        })
      : params.agentId;
  const agentId = sessionAgentId ?? DEFAULT_AGENT_ID;
  const sessionSummary = await loadSessionCostSummary({
    sessionId: params.sessionEntry?.sessionId,
    sessionEntry: params.sessionEntry,
    ...(params.sessionEntry?.sessionId && params.sessionKey
      ? {
          sessionTarget: {
            agentId,
            sessionId: params.sessionEntry.sessionId,
            sessionKey: params.sessionKey,
            storePath: resolveSessionStorePathForScope({
              agentId,
              sessionKey: params.sessionKey,
              storePath:
                params.storePath ??
                resolveSessionStorePathCore(params.cfg.session?.store, { agentId }),
            }),
          },
        }
      : {}),
    config: params.cfg,
    agentId,
  });
  const summary = await loadCostUsageSummary({ config: params.cfg, agentId });

  const sessionCost = formatUsd(sessionSummary?.totalCost);
  const sessionTokens = sessionSummary?.totalTokens
    ? formatTokenCount(sessionSummary.totalTokens)
    : undefined;
  const sessionSuffix = (sessionSummary?.missingCostEntries ?? 0) > 0 ? " (partial)" : "";
  const sessionLine =
    sessionCost || sessionTokens
      ? `Session ${sessionCost ?? "n/a"}${sessionSuffix}${sessionTokens ? ` · ${sessionTokens} tokens` : ""}`
      : "Session n/a";

  const todayKey = new Date().toLocaleDateString("en-CA");
  const todayEntry = summary.daily.find((entry) => entry.date === todayKey);
  const todayCost = formatUsd(todayEntry?.totalCost);
  const todaySuffix = (todayEntry?.missingCostEntries ?? 0) > 0 ? " (partial)" : "";
  const todayLine = `Today ${todayCost ?? "n/a"}${todaySuffix}`;

  const last30Cost = formatUsd(summary.totals.totalCost);
  const last30Suffix = summary.totals.missingCostEntries > 0 ? " (partial)" : "";
  const last30Line = `Last 30d ${last30Cost ?? "n/a"}${last30Suffix}`;

  // Only the date-range rows use aggregate freshness; the session total is loaded separately.
  const cachePrefix = formatCostUsageCachePrefix(summary.cacheStatus);
  return `💸 Usage cost\n${sessionLine}\n${cachePrefix}${todayLine}\n${last30Line}`;
}

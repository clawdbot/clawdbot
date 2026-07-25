import type { isEmbeddedAgentRunActive } from "../agents/embedded-agent.js";
import type { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { SessionCatalogProvider, SessionUpstreamProbe } from "../plugins/session-catalog.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import "./session-upstream-monitor.js";

type SessionUpstreamMonitorOptions = OpenClawStateDatabaseOptions & {
  providers?: readonly SessionCatalogProvider[];
  now?: () => number;
  loadEntry?: typeof loadSessionEntry;
  isRunActive?: typeof isEmbeddedAgentRunActive;
  loadOwnRecentUserTexts?: (params: {
    entry: SessionEntry;
    probe: Omit<SessionUpstreamProbe, "ownRecentUserTexts">;
  }) => Promise<string[]>;
};

type SessionUpstreamMissingCounter = {
  count: number;
  linkUpdatedAt: number;
};

type SessionUpstreamMonitorTestApi = {
  runSessionUpstreamMonitorTick(
    options?: SessionUpstreamMonitorOptions,
    missingCounts?: Map<string, SessionUpstreamMissingCounter>,
  ): Promise<void>;
};

function getTestApi(): SessionUpstreamMonitorTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.sessionUpstreamMonitorTestApi")
  ] as SessionUpstreamMonitorTestApi;
}

export async function runSessionUpstreamMonitorTick(
  options: SessionUpstreamMonitorOptions = {},
  missingCounts: Map<string, SessionUpstreamMissingCounter> = new Map(),
): Promise<void> {
  await getTestApi().runSessionUpstreamMonitorTick(options, missingCounts);
}

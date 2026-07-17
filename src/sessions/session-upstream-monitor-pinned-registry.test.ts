import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  pinActivePluginSessionExtensionRegistry,
  releasePinnedPluginSessionExtensionRegistry,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import type { SessionCatalogProvider, SessionUpstreamProbe } from "../plugins/session-catalog.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { registerSessionStateWatch } from "./session-state-events.js";
import {
  upsertSessionUpstreamLink,
  listWatchedSessionUpstreamLinks,
} from "./session-upstream-links.js";
import { runSessionUpstreamMonitorTick } from "./session-upstream-monitor.test-support.js";

const tempDirs: string[] = [];

function createDatabaseOptions() {
  const stateDir = makeTempDir(tempDirs, "openclaw-session-upstream-monitor-pinned-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function provider(
  id: string,
  checkUpstreamActivity: NonNullable<SessionCatalogProvider["checkUpstreamActivity"]>,
): SessionCatalogProvider {
  return {
    id,
    label: id,
    list: async () => [],
    read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
    checkUpstreamActivity,
  };
}

describe("session upstream monitor pinned registry", () => {
  let pinnedRegistry = createEmptyPluginRegistry();

  beforeEach(() => {
    // Simulate the mutable active registry that a standalone plugin load swaps in
    // (empty here, so a mutable-read would observe no catalogs).
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  afterEach(() => {
    releasePinnedPluginSessionExtensionRegistry(pinnedRegistry);
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    cleanupTempDirs(tempDirs);
  });

  it("reads the pinned session-extension registry after active registry churn", async () => {
    const database = createDatabaseOptions();
    upsertSessionUpstreamLink(
      {
        sessionKey: "agent:main:adopted:watched",
        agentId: "main",
        catalogId: "claude",
        hostId: "gateway:local",
        threadId: "thread-claude",
        upstreamKind: "claude-cli",
        upstreamRef: { source: "claude" },
        marker: { offset: 0 },
      },
      database,
    );
    registerSessionStateWatch(
      { watcherSessionKey: "agent:main:main", targetSessionKey: "agent:main:adopted:watched" },
      database,
    );

    const checkUpstreamActivity = vi.fn(async (probes: SessionUpstreamProbe[]) =>
      probes.map((probe) => ({
        kind: "activity" as const,
        sessionKey: probe.sessionKey,
        occurredAt: 2_000,
        humanTurns: 1,
        nextMarker: { offset: 8 },
        dedupeId: "8",
      })),
    );

    // Pin the registry that actually carries the provider. This must win over the
    // mutable active registry (which is empty), mirroring the session-catalog fix.
    pinnedRegistry = createEmptyPluginRegistry();
    pinnedRegistry.sessionCatalogs = [
      { pluginId: "claude", provider: provider("claude", checkUpstreamActivity), source: "test" },
    ];
    pinActivePluginSessionExtensionRegistry(pinnedRegistry);

    // Sanity: the watched link resolves to the claude catalog.
    expect([...listWatchedSessionUpstreamLinks(database).keys()]).toEqual(["claude"]);

    await runSessionUpstreamMonitorTick({
      ...database,
      now: () => 3_000,
      loadEntry: () => ({ sessionId: "session-watched" }) as never,
      loadOwnRecentUserTexts: async () => [],
    });

    expect(checkUpstreamActivity).toHaveBeenCalledTimes(1);
    const row = openOpenClawStateDatabase(database)
      .db.prepare("SELECT dedupe_key FROM session_state_events WHERE session_key = ?")
      .get("agent:main:adopted:watched") as { dedupe_key: string } | undefined;
    expect(row?.dedupe_key).toBeDefined();
  });
});

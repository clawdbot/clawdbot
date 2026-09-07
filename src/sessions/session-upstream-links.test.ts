import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { registerSessionStateWatch } from "./session-state-events.js";
import {
  deleteSessionUpstreamLink,
  listWatchedSessionUpstreamLinks,
  updateSessionUpstreamLinkMarker,
  upsertSessionUpstreamLink,
} from "./session-upstream-links.js";

const tempDirs: string[] = [];

function createDatabaseOptions() {
  const stateDir = makeTempDir(tempDirs, "openclaw-session-upstream-links-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function upsertLink(
  sessionKey: string,
  catalogId: string,
  database: ReturnType<typeof createDatabaseOptions>,
) {
  upsertSessionUpstreamLink(
    {
      sessionKey,
      agentId: "main",
      catalogId,
      hostId: "gateway:local",
      threadId: `thread-${sessionKey}`,
      upstreamKind: catalogId === "claude" ? "claude-cli" : "codex-app-server",
      upstreamRef: { source: sessionKey },
      marker: { offset: 1 },
    },
    { ...database, now: 100 },
  );
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("session upstream links", () => {
  it("stores links and returns only watcher-joined rows grouped by catalog", () => {
    const database = createDatabaseOptions();
    const watched = "agent:main:adopted:watched";
    const unwatched = "agent:main:adopted:unwatched";
    upsertLink(watched, "claude", database);
    upsertLink(unwatched, "codex", database);
    expect(
      registerSessionStateWatch(
        { watcherSessionKey: "agent:main:main", targetSessionKey: watched },
        database,
      ),
    ).toBe(true);

    expect([...listWatchedSessionUpstreamLinks(database)]).toEqual([
      [
        "claude",
        [
          expect.objectContaining({
            sessionKey: watched,
            marker: { offset: 1 },
            upstreamRef: { source: watched },
          }),
        ],
      ],
    ]);

    updateSessionUpstreamLinkMarker(watched, "main", { offset: 9 }, { ...database, now: 200 });
    expect(listWatchedSessionUpstreamLinks(database).get("claude")?.[0]).toEqual(
      expect.objectContaining({ marker: { offset: 9 }, lastScannedAt: 200, updatedAt: 200 }),
    );

    deleteSessionUpstreamLink(watched, "main", database);
    expect([...listWatchedSessionUpstreamLinks(database)]).toEqual([]);
  });

  it("preserves the marker on same-source refresh and rebases it on source change", () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:refresh";
    upsertLink(sessionKey, "claude", database);
    registerSessionStateWatch(
      { watcherSessionKey: "agent:main:main", targetSessionKey: sessionKey },
      database,
    );
    updateSessionUpstreamLinkMarker(sessionKey, "main", { offset: 4 }, database);

    // Same source (thread/host/kind unchanged): scan progress must survive.
    upsertSessionUpstreamLink(
      {
        sessionKey,
        agentId: "main",
        catalogId: "claude",
        hostId: "gateway:local",
        threadId: `thread-${sessionKey}`,
        upstreamKind: "claude-cli",
        upstreamRef: { source: sessionKey },
        marker: { offset: 99 },
      },
      database,
    );
    expect(listWatchedSessionUpstreamLinks(database).get("claude")?.[0]).toEqual(
      expect.objectContaining({
        upstreamRef: { source: sessionKey },
        marker: { offset: 4 },
      }),
    );

    // Source change: the old cursor is meaningless for the new thread; rebase.
    upsertSessionUpstreamLink(
      {
        sessionKey,
        agentId: "main",
        catalogId: "claude",
        hostId: "gateway:local",
        threadId: "thread-refreshed",
        upstreamKind: "claude-cli",
        upstreamRef: { source: "rebased" },
        marker: { offset: 99 },
      },
      database,
    );
    expect(listWatchedSessionUpstreamLinks(database).get("claude")?.[0]).toEqual(
      expect.objectContaining({
        threadId: "thread-refreshed",
        upstreamRef: { source: "rebased" },
        marker: { offset: 99 },
      }),
    );
  });
});

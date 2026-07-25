// SQLite transcript markers are storage targets, not filesystem paths.
import { describe, expect, it } from "vitest";
import { resolveSessionFilePath } from "./paths.js";
import { loadSessionEntry, upsertSessionEntry } from "./session-accessor.js";
import { resolveAndPersistSessionFile } from "./session-file.js";
import { sqliteSessionFileMarkerMatchesTarget } from "./sqlite-marker.js";
import { useTempSessionsFixture } from "./test-helpers.js";

describe("SQLite sessionFile markers", () => {
  const fixture = useTempSessionsFixture("sqlite-session-file-marker-");

  it("preserves SQLite markers for transcript target resolution", () => {
    const marker = "sqlite:main:sess-1:/tmp/openclaw/agents/main/agent/openclaw-agent.sqlite";
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    const resolved = resolveSessionFilePath("sess-1", { sessionFile: marker }, { sessionsDir });

    expect(resolved).toBe(marker);
  });

  it("matches SQLite markers against the full transcript target", () => {
    const marker =
      "sqlite:main:sess-1:/tmp/openclaw/agents/main/agent/../agent/openclaw-agent.sqlite";
    const target = {
      agentId: "main",
      sessionId: "sess-1",
      storePath: "/tmp/openclaw/agents/main/agent/openclaw-agent.sqlite",
    };

    expect(sqliteSessionFileMarkerMatchesTarget(marker, target)).toBe(true);
    expect(sqliteSessionFileMarkerMatchesTarget(marker, { ...target, agentId: "other" })).toBe(
      false,
    );
    expect(sqliteSessionFileMarkerMatchesTarget(marker, { ...target, sessionId: "sess-2" })).toBe(
      false,
    );
    expect(
      sqliteSessionFileMarkerMatchesTarget(marker, {
        ...target,
        storePath: "/tmp/openclaw/agents/other/agent/openclaw-agent.sqlite",
      }),
    ).toBe(false);
  });

  it("does not downgrade matching SQLite markers when resolving runtime session files", async () => {
    const sessionId = "sqlite-session-id";
    const sessionKey = "agent:main:telegram:group:123";
    const marker = `sqlite:main:${sessionId}:${fixture.storePath()}`;
    const store = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
        sessionFile: marker,
      },
    };
    await upsertSessionEntry({ storePath: fixture.storePath(), sessionKey }, store[sessionKey]);

    const result = await resolveAndPersistSessionFile({
      sessionId,
      sessionKey,
      sessionStore: store,
      storePath: fixture.storePath(),
      sessionEntry: store[sessionKey],
    });

    expect(result.sessionFile).toBe(marker);
    expect(result.sessionEntry.sessionFile).toBe(marker);

    expect(loadSessionEntry({ storePath: fixture.storePath(), sessionKey })?.sessionFile).toBe(
      marker,
    );
  });

  it("does not preserve persisted markers for a different session", async () => {
    const sessionId = "current-sqlite-session-id";
    const sessionKey = "agent:main:telegram:group:456";
    const staleMarker = `sqlite:main:old-sqlite-session-id:${fixture.storePath()}`;
    const store = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
        sessionFile: staleMarker,
      },
    };

    const result = await resolveAndPersistSessionFile({
      sessionId,
      sessionKey,
      sessionStore: store,
      storePath: fixture.storePath(),
      sessionEntry: store[sessionKey],
    });

    const expectedSessionFile = `sqlite:main:${sessionId}:${fixture.storePath()}`;
    expect(result.sessionFile).toBe(expectedSessionFile);
    expect(result.sessionEntry.sessionFile).toBe(result.sessionFile);
    expect(loadSessionEntry({ storePath: fixture.storePath(), sessionKey })?.sessionFile).toBe(
      expectedSessionFile,
    );
  });
});

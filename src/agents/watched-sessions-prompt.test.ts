import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { buildWatchedSessionsHarnessContext } from "../plugin-sdk/agent-harness-runtime.js";
import { registerMainSessionGroupWatch } from "../sessions/session-state-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { prepareWatchedSessionsPrompt } from "./watched-sessions-prompt.js";

const tempDirs: string[] = [];
const mainSessionKey = "agent:main:main";
const sessionReadTools = ["sessions_history", "sessions_search", "sessions_list"];

function stubStateDir() {
  const stateDir = makeTempDir(tempDirs, "openclaw-watched-sessions-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
}

function watchGroup(sessionKey: string) {
  expect(registerMainSessionGroupWatch({ sessionKey, agentId: "main", dmScope: "main" })).toBe(
    true,
  );
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  closeOpenClawAgentDatabasesForTest();
  vi.unstubAllEnvs();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("prepareWatchedSessionsPrompt", () => {
  it("returns key-sorted watched sessions with store-derived titles", async () => {
    stubStateDir();
    watchGroup("agent:main:telegram:group:beta");
    watchGroup("agent:main:telegram:group:alpha:topic:7");
    await upsertSessionEntryCore(
      { sessionKey: "agent:main:telegram:group:beta" },
      { sessionId: "session-beta", displayName: "Family group", updatedAt: 1 },
    );

    const prepared = prepareWatchedSessionsPrompt({
      enabled: true,
      sessionKey: mainSessionKey,
      toolNames: sessionReadTools,
    });

    expect(prepared).toEqual({
      sessions: [
        { key: "agent:main:telegram:group:alpha:topic:7" },
        { key: "agent:main:telegram:group:beta", title: "Family group" },
      ],
      hiddenCount: 0,
      readToolNames: ["sessions_history", "sessions_search"],
      listToolAvailable: true,
    });
  });

  it("caps rendered rows and reports the overflow count", () => {
    stubStateDir();
    for (let index = 0; index < 23; index += 1) {
      watchGroup(`agent:main:telegram:group:room-${String(index).padStart(2, "0")}`);
    }

    const prepared = prepareWatchedSessionsPrompt({
      enabled: true,
      sessionKey: mainSessionKey,
      toolNames: ["sessions_history"],
    });

    expect(prepared?.sessions).toHaveLength(20);
    expect(prepared?.hiddenCount).toBe(3);
    expect(prepared?.sessions[0]?.key).toBe("agent:main:telegram:group:room-00");
    expect(prepared?.readToolNames).toEqual(["sessions_history"]);
    expect(prepared?.listToolAvailable).toBe(false);
  });

  it("accepts capability-provided read tools regardless of casing", () => {
    stubStateDir();
    watchGroup("agent:main:telegram:group:beta");

    const prepared = prepareWatchedSessionsPrompt({
      enabled: true,
      sessionKey: mainSessionKey,
      toolNames: [],
      capabilityToolNames: [" Sessions_Search "],
    });

    expect(prepared?.readToolNames).toEqual(["sessions_search"]);
  });

  it("keeps the section for sandboxed sessions only when the clamp allows non-spawned reads", () => {
    stubStateDir();
    watchGroup("agent:main:telegram:group:beta");
    const base = {
      enabled: true,
      sessionKey: mainSessionKey,
      sandboxed: true,
      toolNames: sessionReadTools,
    };

    expect(prepareWatchedSessionsPrompt({ ...base, config: {} })).toBe(undefined);
    expect(
      prepareWatchedSessionsPrompt({
        ...base,
        config: { agents: { defaults: { sandbox: { sessionToolsVisibility: "all" } } } },
      })?.sessions,
    ).toHaveLength(1);
  });

  it("returns undefined when disabled, keyless, non-main, toolless, or unwatched", () => {
    stubStateDir();
    watchGroup("agent:main:telegram:group:beta");
    const base = { enabled: true, sessionKey: mainSessionKey, toolNames: sessionReadTools };

    expect(prepareWatchedSessionsPrompt({ ...base, enabled: false })).toBe(undefined);
    expect(prepareWatchedSessionsPrompt({ ...base, sessionKey: undefined })).toBe(undefined);
    expect(
      prepareWatchedSessionsPrompt({ ...base, sessionKey: "agent:main:subagent:worker" }),
    ).toBe(undefined);
    expect(
      prepareWatchedSessionsPrompt({ ...base, sessionKey: "agent:main:telegram:group:beta" }),
    ).toBe(undefined);
    expect(prepareWatchedSessionsPrompt({ ...base, toolNames: ["sessions_list"] })).toBe(undefined);
    expect(prepareWatchedSessionsPrompt({ ...base, sessionKey: "agent:other:main" })).toBe(
      undefined,
    );
  });

  it("renders the harness context block plugin-owned runtimes inject per turn", () => {
    stubStateDir();
    watchGroup("agent:main:telegram:group:beta");

    const block = buildWatchedSessionsHarnessContext({
      sessionKey: mainSessionKey,
      toolNames: ["sessions_history"],
    });

    expect(block).toBe(
      [
        "## Watched Sessions",
        "Group/topic sessions this session ambiently watches. Readable now (read-only) via sessions_history.",
        "- agent:main:telegram:group:beta",
      ].join("\n"),
    );
    expect(buildWatchedSessionsHarnessContext({ sessionKey: mainSessionKey, toolNames: [] })).toBe(
      undefined,
    );
  });
});

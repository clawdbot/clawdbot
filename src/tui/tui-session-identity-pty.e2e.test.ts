import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { sleep } from "../utils/sleep.js";
import { buildTuiLastSessionScopeKey, writeTuiLastSessionKey } from "./tui-last-session.js";
import {
  disposeActiveTuiFixtures,
  objectFieldEquals,
  readFixtureLog,
  startTuiFixture,
  waitForSynchronizedFrameRows,
  type FixtureLogEntry,
} from "./tui-pty-harness-fixture-test-support.js";

const STARTUP_TIMEOUT_MS = 60_000;
const REMEMBERED_SESSION_KEY = "agent:main:picker-target";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function seedRememberedSession(
  stateDir: string,
  sessionKey: string = REMEMBERED_SESSION_KEY,
) {
  await writeTuiLastSessionKey({
    scopeKey: buildTuiLastSessionScopeKey({
      connectionUrl: "pty-fixture://local",
      agentId: "main",
      sessionScope: "per-sender",
    }),
    sessionKey,
    stateDir,
  });
}

async function waitForLogCount(params: {
  logPath: string;
  predicate: (entry: FixtureLogEntry) => boolean;
  count: number;
}) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (; Date.now() < deadline; await sleep(25)) {
    const entries = await readFixtureLog(params.logPath);
    if (entries.filter(params.predicate).length >= params.count) {
      return entries;
    }
  }
  throw new Error(`fixture log did not reach ${params.count} matching entries`);
}

function markerSends(entries: FixtureLogEntry[], marker: string) {
  return entries.filter(
    (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", marker),
  );
}

async function waitForSubmitDecision(params: {
  fixture: Awaited<ReturnType<typeof startTuiFixture>>;
  marker: string;
  outputOffset: number;
}) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (; Date.now() < deadline; await sleep(25)) {
    const entries = await readFixtureLog(params.fixture.logPath);
    const output = params.fixture.run.visibleOutput().slice(params.outputOffset);
    if (
      markerSends(entries, params.marker).length > 0 ||
      output.includes("local runtime not ready — message not sent")
    ) {
      return { entries, output };
    }
  }
  throw new Error("TUI neither blocked nor sent the submitted marker");
}

afterEach(async () => {
  await disposeActiveTuiFixtures();
});

it("submits provider-specific thinking labels with one Enter", async () => {
  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_TUI_PTY_THINKING_LABEL: "on",
      OPENCLAW_TUI_PTY_SAFE_THINKING_LABEL: "always on",
    },
  });

  try {
    await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);

    for (const [index, { label, id }] of [
      { label: "on", id: "fixture-thinking" },
      { label: "always on", id: "fixture-thinking-safe" },
    ].entries()) {
      await fixture.run.write(`/think ${label}`, { delay: false });
      await fixture.run.waitForOutput(`→ ${label}`, STARTUP_TIMEOUT_MS);
      await fixture.run.write("\r", { delay: false });
      const entries = await waitForLogCount({
        logPath: fixture.logPath,
        predicate: (entry) => entry.method === "patchSession",
        count: index + 1,
      });
      expect(entries.findLast((entry) => entry.method === "patchSession")?.payload).toMatchObject({
        thinkingLevel: id,
      });
      await fixture.run.waitForOutput(`thinking set to ${label}`, STARTUP_TIMEOUT_MS);
    }
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("clears the previous display name when the selected session is unnamed", async () => {
  const fixture = await startTuiFixture();
  try {
    await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
    await fixture.run.write("/session agent:main:mode-source\r", { delay: false });
    await fixture.waitForLogEntry(
      (entry) =>
        entry.method === "loadHistory" &&
        objectFieldEquals(entry, "sessionKey", "agent:main:mode-source"),
      STARTUP_TIMEOUT_MS,
    );
    await fixture.run.waitForOutput("Production incident", STARTUP_TIMEOUT_MS);

    const targetOutputOffset = fixture.run.visibleOutput().length;
    await fixture.run.write("/session agent:main:mode-target\r", { delay: false });
    await fixture.waitForLogEntry(
      (entry) =>
        entry.method === "loadHistory" &&
        objectFieldEquals(entry, "sessionKey", "agent:main:mode-target"),
      STARTUP_TIMEOUT_MS,
    );
    await fixture.run.waitForOutput("session mode-target", STARTUP_TIMEOUT_MS);

    expect(fixture.run.visibleOutput().slice(targetOutputOffset)).not.toContain(
      "Production incident",
    );
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("keeps the active stream when the current session is selected again", async () => {
  const fixture = await startTuiFixture();
  try {
    await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
    await fixture.run.write("streaming prompt\r", { delay: false });
    await fixture.run.waitForOutput("PTY_STREAMING: streaming prompt", STARTUP_TIMEOUT_MS);
    const historyLoadsBefore = (await readFixtureLog(fixture.logPath)).filter(
      (entry) => entry.method === "loadHistory",
    ).length;

    await fixture.run.write("/session main\r/think\r", { delay: false });
    await fixture.run.waitForOutput("usage: /think", STARTUP_TIMEOUT_MS);
    const rows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) => frame.some((row) => row.includes("PTY_STREAMING: streaming prompt")),
      STARTUP_TIMEOUT_MS,
    );

    expect(rows.join("\n")).not.toContain("local ready | idle");
    expect(
      (await readFixtureLog(fixture.logPath)).filter((entry) => entry.method === "loadHistory"),
    ).toHaveLength(historyLoadsBefore);
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("hides a stale approval when startup restores the remembered session", async () => {
  const stateDir = tempDirs.make("openclaw-tui-identity-");
  await seedRememberedSession(stateDir);
  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_INITIAL_APPROVAL_SESSION_KEY: "agent:main:main",
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
    },
  });

  try {
    await fixture.waitForLogEntry(
      (entry) =>
        entry.method === "loadHistory" &&
        objectFieldEquals(entry, "sessionKey", REMEMBERED_SESSION_KEY),
      STARTUP_TIMEOUT_MS,
    );
    await fixture.waitForLogEntry(
      (entry) =>
        entry.method === "listPluginApprovals" && objectFieldEquals(entry, "pending", true),
      STARTUP_TIMEOUT_MS,
    );
    const rows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) => frame.some((row) => row.includes("session picker-target")),
      STARTUP_TIMEOUT_MS,
    );

    expect(rows.join("\n")).not.toContain("workspace skill approval");
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("restores a remembered global session while keeping pre-ready input editable", async () => {
  const stateDir = tempDirs.make("openclaw-tui-startup-session-");
  const marker = "startup remembered session proof";
  await seedRememberedSession(stateDir, "global");
  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
      OPENCLAW_TUI_PTY_PICKER_SESSION_KEY: "global",
      OPENCLAW_TUI_PTY_RESTORE_DELAY_MS: "400",
    },
  });

  try {
    const lookup = await fixture.waitForLogEntry(
      (entry) => entry.method === "listSessions" && objectFieldEquals(entry, "search", "global"),
      STARTUP_TIMEOUT_MS,
    );
    expect(lookup.payload).toMatchObject({
      search: "global",
      includeGlobal: true,
      includeUnknown: false,
      agentId: "main",
    });
    const outputOffset = fixture.run.visibleOutput().length;
    await fixture.run.write(`${marker}\r`, { delay: false });
    const decision = await waitForSubmitDecision({ fixture, marker, outputOffset });
    expect(markerSends(decision.entries, marker).map((entry) => entry.payload)).toEqual([]);
    expect(decision.output).toContain("local runtime not ready — message not sent");
    const rows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) =>
        frame.some((row) => row.includes("session global")) &&
        frame.some((row) => row.includes("local ready")) &&
        frame.some((row) => row.includes(marker)),
      STARTUP_TIMEOUT_MS,
    );
    expect(rows.join("\n")).toContain(marker);
    expect(markerSends(await readFixtureLog(fixture.logPath), marker)).toHaveLength(0);

    await fixture.run.write("\r", { delay: false });
    const sent = await fixture.waitForLogEntry(
      (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", marker),
      STARTUP_TIMEOUT_MS,
    );
    expect(sent.payload).toMatchObject({ sessionKey: "global", agentId: "main" });
    expect(markerSends(await readFixtureLog(fixture.logPath), marker)).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("keeps input editable while remembered startup history is loading", async () => {
  const stateDir = tempDirs.make("openclaw-tui-startup-history-");
  const marker = "startup remembered history proof";
  await seedRememberedSession(stateDir);
  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
      OPENCLAW_TUI_PTY_STARTUP_DELAY_MS: "400",
    },
  });

  try {
    await fixture.waitForLogEntry(
      (entry) =>
        entry.method === "loadHistory" &&
        objectFieldEquals(entry, "sessionKey", REMEMBERED_SESSION_KEY),
      STARTUP_TIMEOUT_MS,
    );
    const outputOffset = fixture.run.visibleOutput().length;
    await fixture.run.write(`${marker}\r`, { delay: false });
    const decision = await waitForSubmitDecision({ fixture, marker, outputOffset });
    expect(markerSends(decision.entries, marker).map((entry) => entry.payload)).toEqual([]);
    expect(decision.output).toContain("local runtime not ready — message not sent");
    await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) =>
        frame.some((row) => row.includes("session picker-target")) &&
        frame.some((row) => row.includes("local ready")) &&
        frame.some((row) => row.includes(marker)),
      STARTUP_TIMEOUT_MS,
    );

    await fixture.run.write("\r", { delay: false });
    const sent = await fixture.waitForLogEntry(
      (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", marker),
      STARTUP_TIMEOUT_MS,
    );
    expect(sent.payload).toMatchObject({ sessionKey: REMEMBERED_SESSION_KEY });
    expect(markerSends(await readFixtureLog(fixture.logPath), marker)).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("keeps reconnect input editable until restored history is stable", async () => {
  const stateDir = tempDirs.make("openclaw-tui-reconnect-session-");
  const marker = "reconnect remembered session proof";
  await seedRememberedSession(stateDir);
  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
      OPENCLAW_TUI_PTY_DISCONNECT_REASON: "fixture transport loss",
      OPENCLAW_TUI_PTY_RECONNECT_HISTORY_DELAY_MS: "400",
    },
  });

  try {
    await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
    await fixture.run.write("/gateway-status\r", { delay: false });
    await fixture.waitForLogEntry(
      (entry) => entry.method === "reconnectHistoryPending",
      STARTUP_TIMEOUT_MS,
    );
    const outputOffset = fixture.run.visibleOutput().length;
    await fixture.run.write(`${marker}\r`, { delay: false });
    const decision = await waitForSubmitDecision({ fixture, marker, outputOffset });
    expect(markerSends(decision.entries, marker).map((entry) => entry.payload)).toEqual([]);
    expect(decision.output).toContain("local runtime not ready — message not sent");
    const rows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) =>
        frame.some((row) => row.includes("gateway reconnected after transport loss")) &&
        frame.some((row) => row.includes(marker)),
      STARTUP_TIMEOUT_MS,
    );
    expect(rows.join("\n")).toContain(marker);
    expect(markerSends(await readFixtureLog(fixture.logPath), marker)).toHaveLength(0);

    await fixture.run.write("\r", { delay: false });
    const sent = await fixture.waitForLogEntry(
      (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", marker),
      STARTUP_TIMEOUT_MS,
    );
    expect(sent.payload).toMatchObject({ sessionKey: REMEMBERED_SESSION_KEY });
    expect(markerSends(await readFixtureLog(fixture.logPath), marker)).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("keeps an explicit launch session authoritative over remembered state", async () => {
  const stateDir = tempDirs.make("openclaw-tui-explicit-session-");
  const explicitSession = "agent:main:explicit-target";
  const marker = "explicit startup session proof";
  await seedRememberedSession(stateDir);
  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
      OPENCLAW_TUI_PTY_SESSION: explicitSession,
    },
  });

  try {
    await fixture.run.waitForOutput("session explicit-target", STARTUP_TIMEOUT_MS);
    await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
    await fixture.run.write(`${marker}\r`, { delay: false });
    const sent = await fixture.waitForLogEntry(
      (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", marker),
      STARTUP_TIMEOUT_MS,
    );
    expect(sent.payload).toMatchObject({ sessionKey: explicitSession });
    const entries = await readFixtureLog(fixture.logPath);
    expect(
      entries.some((entry) => objectFieldEquals(entry, "search", REMEMBERED_SESSION_KEY)),
    ).toBe(false);
    expect(markerSends(entries, marker)).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("falls back to the default session when remembered lookup fails", async () => {
  const stateDir = tempDirs.make("openclaw-tui-restore-failure-");
  const marker = "restore failure fallback proof";
  await seedRememberedSession(stateDir);
  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
      OPENCLAW_TUI_PTY_RESTORE_FAILURES: "1",
    },
  });

  try {
    await fixture.run.waitForOutput("session main", STARTUP_TIMEOUT_MS);
    await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
    await fixture.run.write(`${marker}\r`, { delay: false });
    const sent = await fixture.waitForLogEntry(
      (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", marker),
      STARTUP_TIMEOUT_MS,
    );
    expect(sent.payload).toMatchObject({ sessionKey: "main" });
    expect(markerSends(await readFixtureLog(fixture.logPath), marker)).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("abandons a stale restore generation without sending or duplicating input", async () => {
  const stateDir = tempDirs.make("openclaw-tui-restore-generation-");
  const marker = "restore generation proof";
  await seedRememberedSession(stateDir);
  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
      OPENCLAW_TUI_PTY_RECONNECT_DURING_RESTORE: "1",
      OPENCLAW_TUI_PTY_RESTORE_DELAY_MS: "400",
    },
  });

  try {
    await fixture.waitForLogEntry(
      (entry) => entry.method === "restoreReconnect",
      STARTUP_TIMEOUT_MS,
    );
    await waitForLogCount({
      logPath: fixture.logPath,
      predicate: (entry) =>
        entry.method === "listSessions" &&
        objectFieldEquals(entry, "search", REMEMBERED_SESSION_KEY),
      count: 2,
    });
    const outputOffset = fixture.run.visibleOutput().length;
    await fixture.run.write(`${marker}\r`, { delay: false });
    const decision = await waitForSubmitDecision({ fixture, marker, outputOffset });
    expect(markerSends(decision.entries, marker).map((entry) => entry.payload)).toEqual([]);
    expect(decision.output).toContain("local runtime not ready — message not sent");
    await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) =>
        frame.some((row) => row.includes("session picker-target")) &&
        frame.some((row) => row.includes("local ready")) &&
        frame.some((row) => row.includes(marker)),
      STARTUP_TIMEOUT_MS,
    );
    expect(markerSends(await readFixtureLog(fixture.logPath), marker)).toHaveLength(0);

    await fixture.run.write("\r", { delay: false });
    const sent = await fixture.waitForLogEntry(
      (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", marker),
      STARTUP_TIMEOUT_MS,
    );
    expect(sent.payload).toMatchObject({ sessionKey: REMEMBERED_SESSION_KEY });
    expect(markerSends(await readFixtureLog(fixture.logPath), marker)).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

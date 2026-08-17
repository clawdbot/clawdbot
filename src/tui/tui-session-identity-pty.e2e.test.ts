import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildTuiLastSessionScopeKey, writeTuiLastSessionKey } from "./tui-last-session.js";
import {
  disposeActiveTuiFixtures,
  objectFieldEquals,
  startTuiFixture,
  waitForSynchronizedFrameRows,
} from "./tui-pty-harness-fixture-test-support.js";

const STARTUP_TIMEOUT_MS = 60_000;
const REMEMBERED_SESSION_KEY = "agent:main:picker-target";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await disposeActiveTuiFixtures();
});

it("hides a stale approval when startup restores the remembered session", async () => {
  const stateDir = tempDirs.make("openclaw-tui-identity-");
  await writeTuiLastSessionKey({
    scopeKey: buildTuiLastSessionScopeKey({
      connectionUrl: "pty-fixture://local",
      agentId: "main",
      sessionScope: "per-sender",
    }),
    sessionKey: REMEMBERED_SESSION_KEY,
    stateDir,
  });
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

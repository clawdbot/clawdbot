// Compare-and-swap session patches must reject reset replacements atomically.
import { afterEach, expect, test } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { embeddedRunMock, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

test.each([
  {
    name: "session id",
    expected: { expectedSessionId: "sess-before-reset" },
  },
  {
    name: "lifecycle revision",
    expected: { expectedLifecycleRevision: "revision-before-reset" },
  },
])("sessions.patch rejects a stale expected $name atomically", async ({ expected }) => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:archive-identity";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("sess-after-reset", {
        lifecycleRevision: "revision-after-reset",
      }),
    },
  });

  const archived = await directSessionReq("sessions.patch", {
    key: sessionKey,
    archived: true,
    ...expected,
  });

  expect(archived).toMatchObject({
    ok: false,
    error: { message: `Session ${sessionKey} changed before patch. Retry.` },
  });
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    sessionId: "sess-after-reset",
    lifecycleRevision: "revision-after-reset",
  });
  expect(loadSessionEntry({ sessionKey, storePath })).not.toHaveProperty("archivedAt");
});

test("sessions.patch rejects a replaced identity before projected active-run protection", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:active-replacement";
  const replacementSessionId = "sess-active-after-reset";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(replacementSessionId, {
        lifecycleRevision: "revision-after-reset",
      }),
    },
  });
  embeddedRunMock.activeIds.add(replacementSessionId);

  const archived = await directSessionReq("sessions.patch", {
    key: sessionKey,
    archived: true,
    expectedSessionId: "sess-before-reset",
  });

  expect(archived).toMatchObject({
    ok: false,
    error: { message: `Session ${sessionKey} changed before patch. Retry.` },
  });
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    sessionId: replacementSessionId,
  });
  expect(loadSessionEntry({ sessionKey, storePath })).not.toHaveProperty("archivedAt");
});

test.each([
  {
    name: "session id",
    expected: { expectedSessionId: "sess-before-reset" },
  },
  {
    name: "lifecycle revision",
    expected: { expectedLifecycleRevision: "revision-before-reset" },
  },
])("sessions.patch rejects stale $name for metadata mutations", async ({ expected }) => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:metadata-identity";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("sess-after-reset", {
        lifecycleRevision: "revision-after-reset",
      }),
    },
  });

  const patched = await directSessionReq("sessions.patch", {
    key: sessionKey,
    label: "Stale agent request",
    ...expected,
  });

  expect(patched).toMatchObject({
    ok: false,
    error: { message: `Session ${sessionKey} changed before patch. Retry.` },
  });
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    sessionId: "sess-after-reset",
    lifecycleRevision: "revision-after-reset",
  });
  expect(loadSessionEntry({ sessionKey, storePath })).not.toHaveProperty("label");
});

test("sessions.patch archives the expected session under its lifecycle lock", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:archive-identity";
  const sessionId = "sess-expected-archive";
  const lifecycleRevision = "revision-expected-archive";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId, { lifecycleRevision }),
    },
  });

  const archived = await directSessionReq("sessions.patch", {
    key: sessionKey,
    archived: true,
    expectedSessionId: sessionId,
    expectedLifecycleRevision: lifecycleRevision,
  });

  expect(archived.ok).toBe(true);
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    sessionId,
    lifecycleRevision,
    archivedAt: expect.any(Number),
  });
});

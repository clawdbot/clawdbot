// Session permission-root tests cover optional recorded roots across patch,
// create, and reset while preserving pinned boundaries and lifecycle behavior.
import { afterEach, expect, test } from "vitest";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { rpcReq, writeSessionStore } from "./test-helpers.js";
import {
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient, seedActiveMainSession } =
  setupGatewaySessionsTestHarness();

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

test("sessions.patch stores and clears rootless modes while preserving recorded roots", async () => {
  const { storePath } = await createSessionStoreDir();
  const pinnedSessionKey = "agent:main:dashboard:pinned-permission";
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-rootless-permission"),
      [pinnedSessionKey]: sessionStoreEntry("sess-pinned-permission", {
        sessionRoot: "/workspace/project",
      }),
    },
  });

  const { ws } = await openClient();
  try {
    const patched = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:main",
      permissionMode: "guarded",
    });

    expect(patched).toMatchObject({ ok: true });
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      permissionMode: "guarded",
    });

    const cleared = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:main",
      permissionMode: null,
    });
    expect(cleared).toMatchObject({ ok: true });
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).not.toHaveProperty(
      "permissionMode",
    );

    const pinned = await rpcReq(ws, "sessions.patch", {
      key: pinnedSessionKey,
      permissionMode: "workspace",
    });
    expect(pinned).toMatchObject({ ok: true });
    expect(loadSessionEntry({ sessionKey: pinnedSessionKey, storePath })).toMatchObject({
      permissionMode: "workspace",
      sessionRoot: "/workspace/project",
    });
  } finally {
    ws.close();
  }
});

test("createGatewaySession stores a permission mode without a prepared session root", async () => {
  await createSessionStoreDir();
  const { createGatewaySession } = await import("./session-create-service.js");

  const created = await createGatewaySession({
    cfg: getRuntimeConfig(),
    agentId: "main",
    commandSource: "test",
    permissionMode: "guarded",
  });

  expect(created).toMatchObject({
    ok: true,
    entry: { permissionMode: "guarded" },
  });
  expect(created).not.toHaveProperty("entry.sessionRoot");
});

test("sessions.reset applies a rootless permission mode and interrupts admitted work", async () => {
  const { storePath } = await seedActiveMainSession();
  let interrupted = false;
  let releaseAdmission = () => {};
  const admissionLease = await beginSessionWorkAdmission({
    scope: storePath,
    identities: ["agent:main:main", "sess-main"],
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
      releaseAdmission();
    },
  });
  releaseAdmission = admissionLease.release;

  try {
    const { performGatewaySessionReset } = await import("./session-reset-service.js");
    const reset = await performGatewaySessionReset({
      key: "main",
      reason: "reset",
      commandSource: "gateway:agent",
      workerPlacementContext: {},
      permissionMode: "guarded",
    });

    expect(reset).toMatchObject({
      ok: true,
      entry: { permissionMode: "guarded" },
    });
    expect(interrupted).toBe(true);
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      permissionMode: "guarded",
    });
  } finally {
    admissionLease.release();
  }
});

test("sessions.reset preserves a persisted rootless permission mode", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-legacy-rootless-permission", { permissionMode: "full" }),
    },
  });
  const { performGatewaySessionReset } = await import("./session-reset-service.js");

  const reset = await performGatewaySessionReset({
    key: "main",
    reason: "reset",
    commandSource: "gateway:agent",
    workerPlacementContext: {},
  });

  expect(reset).toMatchObject({
    ok: true,
    entry: { permissionMode: "full" },
  });
  if (reset.ok && "entry" in reset) {
    expect(reset.entry.sessionRoot).toBeUndefined();
  }
});

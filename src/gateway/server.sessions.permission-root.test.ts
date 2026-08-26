// Session permission-root tests protect the persisted root/mode invariant across
// patch, create, and reset owners before hooks or active-work interruption.
import { afterEach, expect, test } from "vitest";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { rpcReq, writeSessionStore } from "./test-helpers.js";
import {
  sessionHookMocks,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient, seedActiveMainSession } =
  setupGatewaySessionsTestHarness();

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

test("sessions.patch rejects a rootless permission mode before persistence or hooks", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { main: sessionStoreEntry("sess-rootless-permission") },
  });
  sessionHookMocks.triggerInternalHook.mockClear();

  const { ws } = await openClient();
  try {
    const patched = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:main",
      permissionMode: "guarded",
    });

    expect(patched).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "permission mode requires a session root; choose Default or a rooted session",
      },
    });
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).not.toHaveProperty(
      "permissionMode",
    );
    expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  } finally {
    ws.close();
  }
});

test("createGatewaySession rejects a permission mode without a prepared session root", async () => {
  await createSessionStoreDir();
  const { createGatewaySession } = await import("./session-create-service.js");

  await expect(
    createGatewaySession({
      cfg: getRuntimeConfig(),
      agentId: "main",
      commandSource: "test",
      permissionMode: "guarded",
    }),
  ).resolves.toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "permission mode requires a session root; choose Default or a rooted session",
    },
  });
});

test("sessions.reset rejects a rootless permission mode without interrupting admitted work", async () => {
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
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "permission mode requires a session root; choose Default or a rooted session",
      },
    });
    expect(interrupted).toBe(false);
  } finally {
    admissionLease.release();
  }
});

test("sessions.reset rejects a persisted rootless permission mode", async () => {
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
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "permission mode requires a session root; choose Default or a rooted session",
    },
  });
});

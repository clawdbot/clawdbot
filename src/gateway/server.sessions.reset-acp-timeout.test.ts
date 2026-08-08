// ACP reset timeout regressions verify that stuck manager cleanup cannot poison
// the next runtime session or prevent reset from completing.
import { afterEach, expect, test, vi } from "vitest";
import {
  readAcpSessionMeta,
  writeAcpSessionMetaForMigration,
} from "../acp/runtime/session-meta.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  acpManagerMocks,
  acpRuntimeMocks,
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
  writeSingleLineSession,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

function resolvedAcpMeta(): SessionAcpMeta {
  return {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime:reset",
    identity: {
      state: "resolved",
      acpxRecordId: "agent:main:main",
      acpxSessionId: "backend-session-1",
      source: "status",
      lastUpdatedAt: Date.now(),
    },
    mode: "persistent",
    runtimeOptions: { runtimeMode: "auto", timeoutSeconds: 30 },
    cwd: "/tmp/acp-session",
    state: "idle",
    lastActivityAt: Date.now(),
  };
}

function expectResetAcpState(acp: SessionAcpMeta | undefined) {
  expect(acp).toMatchObject({
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime:reset",
    identity: { state: "pending", acpxRecordId: "agent:main:main" },
    mode: "persistent",
    runtimeOptions: { runtimeMode: "auto", timeoutSeconds: 30 },
    cwd: "/tmp/acp-session",
    state: "idle",
  });
  expect(acp?.identity?.acpxSessionId).toBeUndefined();
}

function accelerateAcpCleanupTimeout() {
  const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
  return vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => nativeSetTimeout(callback, delay === 15_000 ? 0 : delay, ...args)) as typeof setTimeout);
}

async function seedAcpSession() {
  const { dir, storePath } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-main") } });
  writeAcpSessionMetaForMigration({
    sessionKey: "agent:main:main",
    meta: resolvedAcpMeta(),
  });
  const prepareFreshSession = vi.fn(async () => {});
  acpRuntimeMocks.getAcpRuntimeBackend.mockReturnValue({
    id: "acpx",
    runtime: { prepareFreshSession },
  });
  return { prepareFreshSession, storePath };
}

test("sessions.reset force-discards ACP runtime ownership after cancel timeout", async () => {
  const { prepareFreshSession, storePath } = await seedAcpSession();
  let releaseCancel: (() => void) | undefined;
  acpManagerMocks.cancelSession.mockImplementation(
    async () =>
      await new Promise<void>((resolve) => {
        releaseCancel = resolve;
      }),
  );
  const timeoutSpy = accelerateAcpCleanupTimeout();

  try {
    const reset = await directSessionReq<{ ok: true }>("sessions.reset", { key: "main" });
    expect(reset.ok).toBe(true);
    expect(acpManagerMocks.forceDiscardSessionRuntime).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      sessionKey: "agent:main:main",
      reason: "session-reset",
    });
    expect(acpManagerMocks.closeSession).not.toHaveBeenCalled();
    expect(prepareFreshSession).toHaveBeenCalledWith({ sessionKey: "agent:main:main" });
    expect(loadSessionEntry({ storePath, sessionKey: "agent:main:main" })).not.toHaveProperty(
      "acp",
    );
    expectResetAcpState(readAcpSessionMeta({ sessionKey: "agent:main:main" }));
  } finally {
    releaseCancel?.();
    timeoutSpy.mockRestore();
    acpManagerMocks.cancelSession.mockImplementation(async () => {});
  }
});

test("sessions.reset force-discards ACP actor ownership after close timeout", async () => {
  const { prepareFreshSession } = await seedAcpSession();
  let releaseClose: (() => void) | undefined;
  acpManagerMocks.closeSession.mockImplementation(
    async () =>
      await new Promise<void>((resolve) => {
        releaseClose = resolve;
      }),
  );
  const timeoutSpy = accelerateAcpCleanupTimeout();

  try {
    const reset = await directSessionReq<{ ok: true }>("sessions.reset", { key: "main" });
    expect(reset.ok).toBe(true);
    expect(acpManagerMocks.cancelSession).toHaveBeenCalledTimes(1);
    expect(acpManagerMocks.closeSession).toHaveBeenCalledTimes(1);
    expect(acpManagerMocks.forceDiscardSessionRuntime).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      sessionKey: "agent:main:main",
      reason: "session-reset",
    });
    expect(prepareFreshSession).toHaveBeenCalledWith({ sessionKey: "agent:main:main" });
    expectResetAcpState(readAcpSessionMeta({ sessionKey: "agent:main:main" }));
  } finally {
    releaseClose?.();
    timeoutSpy.mockRestore();
    acpManagerMocks.closeSession.mockImplementation(async () => {});
  }
});

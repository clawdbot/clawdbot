// Protects the reset invariant: fresh-session preparation that cannot run
// (missing backend or missing hook) records a visible outcome instead of
// silently succeeding while the backend resumes the old conversation.
import { describe, expect, it, vi } from "vitest";

const logVerboseMock = vi.hoisted(() => vi.fn());

vi.mock("../../globals.js", () => ({
  logVerbose: logVerboseMock,
}));

import { AcpRuntimeError } from "../runtime/errors.js";
import type { AcpRuntimeBackend } from "../runtime/registry.js";
import { tryPrepareFreshManagerRuntimeSession } from "./manager.runtime-resume-state.js";
import type { SessionAcpMeta } from "./manager.types.js";

const meta: SessionAcpMeta = {
  backend: "acpx",
  agent: "codex",
  runtimeSessionName: "acp:test",
  mode: "persistent",
  state: "idle",
  lastActivityAt: Date.now(),
};

function callParams(backend: AcpRuntimeBackend | null) {
  return {
    deps: { getRuntimeBackend: vi.fn(() => backend) },
    cfg: {},
    meta,
    sessionKey: "agent:main:acp:test",
    agentId: "main",
    logPrefix: "sessions.session-reset",
  };
}

describe("tryPrepareFreshManagerRuntimeSession", () => {
  it("records a skip outcome when the backend is not registered", async () => {
    logVerboseMock.mockClear();
    await tryPrepareFreshManagerRuntimeSession(callParams(null));
    expect(logVerboseMock).toHaveBeenCalledWith(
      expect.stringContaining(
        'fresh-session preparation skipped for agent:main:acp:test: ACP backend "acpx" is not registered',
      ),
    );
  });

  it("records a skip outcome when the backend lacks prepareFreshSession", async () => {
    logVerboseMock.mockClear();
    const backend = {
      id: "acpx",
      runtime: {
        ensureSession: vi.fn(),
        async *runTurn() {},
        cancel: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      },
    } as AcpRuntimeBackend;
    await tryPrepareFreshManagerRuntimeSession(callParams(backend));
    expect(logVerboseMock).toHaveBeenCalledWith(
      expect.stringContaining(
        'fresh-session preparation skipped for agent:main:acp:test: ACP backend "acpx" does not support prepareFreshSession',
      ),
    );
  });

  it("invokes the hook and stays silent when preparation applies", async () => {
    logVerboseMock.mockClear();
    const prepareFreshSession = vi.fn(async () => {});
    const backend = {
      id: "acpx",
      runtime: {
        ensureSession: vi.fn(),
        async *runTurn() {},
        prepareFreshSession,
        cancel: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      },
    } as AcpRuntimeBackend;
    await tryPrepareFreshManagerRuntimeSession(callParams(backend));
    expect(prepareFreshSession).toHaveBeenCalledWith({
      sessionKey: "agent:main:acp:test",
      agentId: "main",
      persistedHandle: {
        sessionKey: "agent:main:acp:test",
        agentId: "main",
        backend: "acpx",
        runtimeSessionName: "acp:test",
        cwd: undefined,
        acpxRecordId: undefined,
      },
    });
    expect(logVerboseMock).not.toHaveBeenCalled();
  });

  it("records preparation failures without throwing", async () => {
    logVerboseMock.mockClear();
    const backend = {
      id: "acpx",
      runtime: {
        ensureSession: vi.fn(),
        async *runTurn() {},
        prepareFreshSession: vi.fn(async () => {
          throw new Error("backend exploded");
        }),
        cancel: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      },
    } as AcpRuntimeBackend;
    await expect(
      tryPrepareFreshManagerRuntimeSession(callParams(backend)),
    ).resolves.toBeUndefined();
    expect(logVerboseMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "unable to prepare fresh session for agent:main:acp:test: backend exploded",
      ),
    );
  });
});

it("does not turn an owner migration rejection into successful fresh preparation", async () => {
  const error = new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "run doctor --fix", {
    detailCode: "SESSION_OWNER_MIGRATION_REQUIRED",
  });
  const backend: AcpRuntimeBackend = {
    id: "acpx",
    runtime: {
      ownerAwareSessions: 1,
      ensureSession: vi.fn(),
      async *runTurn() {},
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      prepareFreshSession: vi.fn(async () => {
        throw error;
      }),
    },
  };
  await expect(
    tryPrepareFreshManagerRuntimeSession({ ...callParams(backend), sessionKey: "global" }),
  ).rejects.toBe(error);
});

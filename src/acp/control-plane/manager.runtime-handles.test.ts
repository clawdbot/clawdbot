import { describe, expect, it } from "vitest";
import {
  AcpRuntimeError,
  AcpSessionManager,
  baseCfg,
  createRuntime,
  expectRecordFields,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockCallArg,
  readySessionMeta,
  type OpenClawConfig,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager runtime handles", () => {
  installAcpSessionManagerTestLifecycle();

  it("reuses runtime session handles for repeat turns in the same manager process", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "first",
      mode: "prompt",
      requestId: "r1",
    });
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "second",
      mode: "prompt",
      requestId: "r2",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
  });

  it("re-ensures cached runtime handles when the runtime config changes", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });
    const allowlistCfg = {
      ...baseCfg,
      tools: {
        exec: {
          security: "allowlist",
          safeBins: ["git"],
        },
      },
    } satisfies OpenClawConfig;
    const denyCfg = {
      ...baseCfg,
      tools: {
        exec: {
          security: "deny",
          safeBins: ["node"],
        },
      },
    } satisfies OpenClawConfig;

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: allowlistCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "first",
      mode: "prompt",
      requestId: "r1",
    });
    await manager.runTurn({
      cfg: denyCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "second",
      mode: "prompt",
      requestId: "r2",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(runtimeState.close), {
      reason: "runtime-handle-replaced",
    });
  });

  it("re-ensures cached runtime handles when the backend reports the session is dead", async () => {
    const runtimeState = createRuntime();
    runtimeState.getStatus
      .mockResolvedValueOnce({
        summary: "status=alive",
        details: { status: "alive" },
      })
      .mockResolvedValueOnce({
        summary: "status=dead",
        details: { status: "dead" },
      })
      .mockResolvedValueOnce({
        summary: "status=alive",
        details: { status: "alive" },
      });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "first",
      mode: "prompt",
      requestId: "r1",
    });
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "second",
      mode: "prompt",
      requestId: "r2",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expect(runtimeState.getStatus).toHaveBeenCalledTimes(3);
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
  });

  it("re-ensures cached runtime handles when persisted ACP session identity changes", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession
      .mockResolvedValueOnce({
        sessionKey: "agent:codex:acp:session-1",
        backend: "acpx",
        runtimeSessionName: "runtime-1",
        acpxRecordId: "record-1",
        backendSessionId: "acpx-session-1",
        agentSessionId: "agent-session-1",
      })
      .mockResolvedValueOnce({
        sessionKey: "agent:codex:acp:session-1",
        backend: "acpx",
        runtimeSessionName: "runtime-2",
        acpxRecordId: "record-1",
        backendSessionId: "acpx-session-2",
        agentSessionId: "agent-session-2",
      });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    let currentMeta = readySessionMeta({
      runtimeSessionName: "runtime-1",
      identity: {
        state: "resolved",
        acpxRecordId: "record-1",
        acpxSessionId: "acpx-session-1",
        agentSessionId: "agent-session-1",
        source: "status",
        lastUpdatedAt: Date.now(),
      },
    });
    hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: currentMeta,
    }));

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "first",
      mode: "prompt",
      requestId: "r1",
    });

    currentMeta = readySessionMeta({
      runtimeSessionName: "runtime-2",
      identity: {
        state: "resolved",
        acpxRecordId: "record-1",
        acpxSessionId: "acpx-session-2",
        agentSessionId: "agent-session-2",
        source: "status",
        lastUpdatedAt: Date.now(),
      },
    });

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "second",
      mode: "prompt",
      requestId: "r2",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
  });

  it("rehydrates runtime handles after a manager restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });

    const managerA = new AcpSessionManager();
    await managerA.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "before restart",
      mode: "prompt",
      requestId: "r1",
    });
    const managerB = new AcpSessionManager();
    await managerB.runTurn({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "after restart",
      mode: "prompt",
      requestId: "r2",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
  });

  it("passes persisted ACP backend session identity back into ensureSession for configured bindings after restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:demo-binding:default:deadbeef";
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: key,
          identity: {
            state: "resolved",
            source: "status",
            acpxSessionId: "acpx-sid-1",
            lastUpdatedAt: Date.now(),
          },
        },
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "after restart",
      mode: "prompt",
      requestId: "r-binding-restart",
    });

    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey,
      agent: "codex",
      resumeSessionId: "acpx-sid-1",
    });
  });

  it("prefers the persisted agent session id when reopening an ACP runtime after restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:gemini:acp:binding:discord:default:restart";
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: {
          ...readySessionMeta(),
          agent: "gemini",
          runtimeSessionName: key,
          identity: {
            state: "resolved",
            source: "status",
            acpxSessionId: "acpx-sid-1",
            agentSessionId: "gemini-sid-1",
            lastUpdatedAt: Date.now(),
          },
        },
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "after restart",
      mode: "prompt",
      requestId: "r-binding-restart-gemini",
    });

    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey,
      agent: "gemini",
      resumeSessionId: "gemini-sid-1",
    });
  });

  it("passes persisted cwd runtime options into ensureSession after restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:demo-binding:default:cwd-restart";
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: {
          ...readySessionMeta(),
          cwd: "/workspace/stale",
          runtimeOptions: {
            cwd: "/workspace/project",
          },
        },
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "after restart",
      mode: "prompt",
      requestId: "r-binding-restart-cwd",
    });

    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey,
      cwd: "/workspace/project",
    });
  });

  it("passes persisted model runtime options into ensureSession after restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:demo-binding:default:model-restart";
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: {
          ...readySessionMeta(),
          runtimeOptions: {
            model: "openai/gpt-5.4",
          },
        },
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "after restart",
      mode: "prompt",
      requestId: "r-binding-restart-model",
    });

    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey,
      model: "openai/gpt-5.4",
    });
  });

  it("passes persisted thinking runtime options into ensureSession after restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:demo-binding:default:thinking-restart";
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: {
          ...readySessionMeta(),
          runtimeOptions: {
            thinking: "high",
          },
        },
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "after restart",
      mode: "prompt",
      requestId: "r-binding-restart-thinking",
    });

    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey,
      thinking: "high",
    });
  });

  it("does not resume persisted ACP identity for oneshot sessions after restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:demo-binding:default:oneshot";
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: key,
          mode: "oneshot",
          identity: {
            state: "resolved",
            source: "status",
            acpxSessionId: "acpx-sid-oneshot",
            lastUpdatedAt: Date.now(),
          },
        },
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "after restart",
      mode: "prompt",
      requestId: "r-binding-oneshot",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    const ensureInput = mockCallArg(runtimeState.ensureSession);
    expectRecordFields(ensureInput, {
      sessionKey,
      agent: "codex",
      mode: "oneshot",
    });
    expect(ensureInput?.resumeSessionId).toBeUndefined();
  });

  it("falls back to a fresh ensure without reusing stale agent session ids", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockImplementation(async (inputUnknown: unknown) => {
      const input = inputUnknown as {
        sessionKey: string;
        agent: string;
        mode: "persistent" | "oneshot";
        resumeSessionId?: string;
      };
      if (input.resumeSessionId) {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          "failed to resume persisted ACP session",
        );
      }
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
        backendSessionId: "acpx-sid-fresh",
      };
    });
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      backendSessionId: "acpx-sid-fresh",
      details: { status: "alive" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:demo-binding:default:retry-fresh";
    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      runtimeSessionName: sessionKey,
      identity: {
        state: "resolved",
        source: "status",
        acpxSessionId: "acpx-sid-stale",
        agentSessionId: "agent-sid-stale",
        lastUpdatedAt: Date.now(),
      },
    };
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: currentMeta,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(currentMeta, { acp: currentMeta });
      if (next) {
        currentMeta = next;
      }
      return {
        sessionId: "session-1",
        updatedAt: Date.now(),
        acp: currentMeta,
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "after restart",
      mode: "prompt",
      requestId: "r-binding-retry-fresh",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey,
      agent: "codex",
      resumeSessionId: "agent-sid-stale",
    });
    const retryInput = mockCallArg(runtimeState.ensureSession, 1);
    expect(retryInput.resumeSessionId).toBeUndefined();
    const runTurnInput = mockCallArg(runtimeState.runTurn);
    const handle = expectRecordFields(runTurnInput.handle, {
      backendSessionId: "acpx-sid-fresh",
    });
    expect(handle.agentSessionId).toBeUndefined();
    expect(currentMeta.identity?.acpxSessionId).toBe("acpx-sid-fresh");
    expect(currentMeta.identity?.agentSessionId).toBeUndefined();
  });
});

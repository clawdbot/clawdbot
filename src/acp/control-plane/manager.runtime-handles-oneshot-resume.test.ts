/** Tests completed ACP one-shot resume, capability, and fail-closed behavior. */
import type { AcpRuntimeHandle } from "@openclaw/acp-core/runtime/types";
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
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager one-shot resume handles", () => {
  installAcpSessionManagerTestLifecycle();

  it("does not resume one-shot identity without confirmed agent support", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockResolvedValue({
      sessionKey: "agent:codex:acp:binding:demo-binding:default:oneshot-unconfirmed",
      backend: "acpx",
      runtimeSessionName: "fresh-oneshot-runtime",
      acpxRecordId: "fresh-record",
      backendSessionId: "fresh-acpx-session",
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:demo-binding:default:oneshot-unconfirmed";
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
            acpxSessionId: "acpx-sid-unconfirmed",
            agentSessionId: "agent-sid-unconfirmed",
            lastUpdatedAt: Date.now(),
          },
        },
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey,
      text: "safe fresh retry",
      mode: "prompt",
      requestId: "r-binding-oneshot-unconfirmed",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    expect(mockCallArg(runtimeState.ensureSession).resumeSessionId).toBeUndefined();
    const turnHandle = mockCallArg(runtimeState.runTurn).handle as AcpRuntimeHandle;
    expectRecordFields(turnHandle, {
      backendSessionId: "fresh-acpx-session",
    });
    expect(turnHandle.agentSessionId).toBeUndefined();
  });

  it("fails closed when a persisted one-shot session cannot be resumed", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockRejectedValue(
      new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "failed to resume one-shot ACP session", {
        detailCode: "SESSION_RESUME_REQUIRED",
      }),
    );
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:claude:acp:binding:demo-binding:default:oneshot-stale";
    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      runtimeSessionName: sessionKey,
      mode: "oneshot",
      identity: {
        state: "resolved",
        source: "status",
        agentSessionId: "agent-session-stale",
        sessionResumeSupported: true,
        sessionResumeReady: true,
        lastUpdatedAt: Date.now(),
      },
    };
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        entry: { sessionId: "session-oneshot-stale", updatedAt: Date.now(), acp: currentMeta },
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
      if (!next) {
        return null;
      }
      currentMeta = next;
      return { sessionId: "session-oneshot-stale", updatedAt: Date.now(), acp: currentMeta };
    });

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey,
        text: "follow-up after restart",
        mode: "prompt",
        requestId: "r-binding-oneshot-stale",
      }),
    ).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      message: "failed to resume one-shot ACP session",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey,
      mode: "oneshot",
      resumeSessionId: "agent-session-stale",
    });
    expect(runtimeState.runTurn).not.toHaveBeenCalled();
    expect(currentMeta.identity?.agentSessionId).toBeUndefined();
    expect(currentMeta.identity?.sessionResumeSupported).toBeUndefined();
    expect(currentMeta.identity?.sessionResumeReady).toBeUndefined();
  });

  it("resumes completed one-shot sessions after the runtime handle cache is gone", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession
      .mockResolvedValueOnce({
        sessionKey: "agent:claude:acp:session-1",
        backend: "acpx",
        runtimeSessionName: "agent:claude:acp:session-1:oneshot:runtime",
        acpxRecordId: "record-1",
        backendSessionId: "acpx-session-1",
        agentSessionId: "agent-session-1",
        sessionResumeSupported: true,
      })
      .mockResolvedValueOnce({
        sessionKey: "agent:claude:acp:session-1",
        backend: "acpx",
        runtimeSessionName: "agent:claude:acp:session-1:oneshot:runtime",
        acpxRecordId: "record-1",
        backendSessionId: "acpx-session-1",
        agentSessionId: "agent-session-1",
      });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:claude:acp:session-1";
    let currentMeta: SessionAcpMeta | undefined;
    const sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
      sessionKey,
      storeSessionKey: sessionKey,
      ...sessionEntry,
      ...(currentMeta ? { acp: currentMeta } : {}),
    }));
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta; sessionId: string; updatedAt: number } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const entry = currentMeta ? { ...sessionEntry, acp: currentMeta } : sessionEntry;
      const next = params.mutate(currentMeta, entry);
      if (next === null) {
        currentMeta = undefined;
        return { ...sessionEntry };
      }
      if (next !== undefined) {
        currentMeta = next;
      }
      return {
        ...sessionEntry,
        ...(currentMeta ? { acp: currentMeta } : {}),
      };
    });

    const managerA = new AcpSessionManager();
    await managerA.initializeSession({
      cfg: baseCfg,
      sessionKey,
      agent: "claude",
      mode: "oneshot",
    });
    expect(currentMeta?.identity?.sessionResumeSupported).toBe(true);
    await managerA.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "initial one-shot",
      mode: "prompt",
      requestId: "r-oneshot-initial",
      provenance: "system",
    });
    expect(currentMeta?.identity?.sessionResumeSupported).toBe(true);
    expect(currentMeta?.identity?.sessionResumeReady).toBe(true);
    const managerB = new AcpSessionManager();
    await managerB.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "follow-up",
      mode: "prompt",
      requestId: "r-oneshot-follow-up",
      provenance: "system",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(runtimeState.ensureSession, 1), {
      sessionKey,
      agent: "claude",
      mode: "oneshot",
      resumeSessionId: "acpx-session-1",
    });
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
  });

  it("does not mark a pre-prompt cancelled one-shot ready to resume", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockResolvedValue({
      sessionKey: "agent:codex:acp:cancelled-before-prompt",
      backend: "acpx",
      runtimeSessionName: "agent:codex:acp:cancelled-before-prompt:oneshot:runtime",
      acpxRecordId: "record-cancelled-before-prompt",
      backendSessionId: "codex-unmaterialized-thread",
      sessionResumeSupported: true,
    });
    runtimeState.runTurn.mockImplementation(async function* () {
      yield { type: "done", stopReason: "cancelled" };
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:cancelled-before-prompt";
    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      runtimeSessionName: sessionKey,
      mode: "oneshot",
    };
    hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
      sessionKey,
      storeSessionKey: sessionKey,
      sessionId: "session-cancelled-before-prompt",
      updatedAt: Date.now(),
      acp: currentMeta,
    }));
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
        sessionId: "session-cancelled-before-prompt",
        updatedAt: Date.now(),
        acp: currentMeta,
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "never submitted",
      mode: "prompt",
      requestId: "r-cancelled-before-prompt",
      provenance: "system",
    });

    expect(currentMeta.identity).toMatchObject({
      acpxSessionId: "codex-unmaterialized-thread",
      sessionResumeSupported: true,
    });
    expect(currentMeta.identity?.sessionResumeReady).toBeUndefined();
  });

  it("preserves one-shot resume support until status resolves the session id", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession
      .mockResolvedValueOnce({
        sessionKey: "agent:claude:acp:session-capability-first",
        backend: "acpx",
        runtimeSessionName: "agent:claude:acp:session-capability-first:oneshot:runtime",
        sessionResumeSupported: true,
      })
      .mockResolvedValueOnce({
        sessionKey: "agent:claude:acp:session-capability-first",
        backend: "acpx",
        runtimeSessionName: "agent:claude:acp:session-capability-first:oneshot:runtime",
        backendSessionId: "acpx-session-capability-first",
      });
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      backendSessionId: "acpx-session-capability-first",
      details: { status: "alive" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:claude:acp:session-capability-first";
    let currentMeta: SessionAcpMeta | undefined;
    const sessionEntry = {
      sessionId: "session-capability-first",
      updatedAt: Date.now(),
    };
    hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
      sessionKey,
      storeSessionKey: sessionKey,
      ...sessionEntry,
      ...(currentMeta ? { acp: currentMeta } : {}),
    }));
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta; sessionId: string; updatedAt: number } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const entry = currentMeta ? { ...sessionEntry, acp: currentMeta } : sessionEntry;
      const next = params.mutate(currentMeta, entry);
      if (next === null) {
        currentMeta = undefined;
        return { ...sessionEntry };
      }
      if (next !== undefined) {
        currentMeta = next;
      }
      return {
        ...sessionEntry,
        ...(currentMeta ? { acp: currentMeta } : {}),
      };
    });

    const managerA = new AcpSessionManager();
    await managerA.initializeSession({
      cfg: baseCfg,
      sessionKey,
      agent: "claude",
      mode: "oneshot",
    });
    await managerA.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "initial one-shot",
      mode: "prompt",
      requestId: "r-capability-first-initial",
      provenance: "system",
    });

    expect(currentMeta?.identity).toMatchObject({
      acpxSessionId: "acpx-session-capability-first",
      sessionResumeSupported: true,
    });

    const managerB = new AcpSessionManager();
    await managerB.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "follow-up",
      mode: "prompt",
      requestId: "r-capability-first-follow-up",
      provenance: "system",
    });

    expectRecordFields(mockCallArg(runtimeState.ensureSession, 1), {
      mode: "oneshot",
      resumeSessionId: "acpx-session-capability-first",
    });
  });
});

/** Tests ACP runtime config validation and backend-applied model persistence. */
import { describe, expect, it } from "vitest";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  expectMockCallFields,
  expectNoMockCallFields,
  expectRejectedRecord,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  readySessionMeta,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager runtime config validation", () => {
  installAcpSessionManagerTestLifecycle();

  it("rejects invalid runtime option values before backend controls run", async () => {
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
    await expectRejectedRecord(
      manager.setSessionConfigOption({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        key: "timeout",
        value: "not-a-number",
      }),
      { code: "ACP_INVALID_RUNTIME_OPTION" },
    );
    expect(runtimeState.setConfigOption).not.toHaveBeenCalled();

    await expectRejectedRecord(
      manager.updateSessionRuntimeOptions({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        patch: { cwd: "relative/path" },
      }),
      { code: "ACP_INVALID_RUNTIME_OPTION" },
    );
  });

  it("never replays an inherited non-openai default that the backend dropped at session init", async () => {
    const sessionKey = "agent:codex:acp:session-dropped-default";
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockImplementation(async (input) => ({
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName: `${input.sessionKey}:runtime`,
      appliedModel: { kind: "dropped" as const },
    }));
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    let persistedMeta: SessionAcpMeta | undefined;
    hoisted.upsertAcpSessionMetaMock.mockImplementation(
      async (payload: {
        mutate: (current: SessionAcpMeta | undefined) => SessionAcpMeta | null | undefined;
      }) => {
        persistedMeta = payload.mutate(undefined) ?? undefined;
        return persistedMeta
          ? { sessionKey, storeSessionKey: sessionKey, acp: persistedMeta }
          : null;
      },
    );

    const manager = new AcpSessionManager();
    await manager.initializeSession({
      cfg: baseCfg,
      sessionKey,
      agent: "codex",
      mode: "persistent",
      runtimeOptions: {
        model: "google/gemini-3.1-flash-lite",
        thinking: "low",
      },
    });

    expect(persistedMeta?.runtimeOptions).toEqual({ thinking: "low" });

    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey,
      storeSessionKey: sessionKey,
      acp: persistedMeta as SessionAcpMeta,
    });

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "do work",
      mode: "prompt",
      requestId: "run-dropped-default",
      provenance: "system",
    });

    expectNoMockCallFields(runtimeState.setConfigOption, { key: "model" });
    expectMockCallFields(runtimeState.setConfigOption, { key: "thinking", value: "low" });
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(1);
  });

  it("persists and replays a supported codex model the backend applied at session init", async () => {
    const sessionKey = "agent:codex:acp:session-applied-model";
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockImplementation(async (input) => ({
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName: `${input.sessionKey}:runtime`,
      appliedModel: { kind: "applied" as const, model: input.model ?? "" },
    }));
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    let persistedMeta: SessionAcpMeta | undefined;
    hoisted.upsertAcpSessionMetaMock.mockImplementation(
      async (payload: {
        mutate: (current: SessionAcpMeta | undefined) => SessionAcpMeta | null | undefined;
      }) => {
        persistedMeta = payload.mutate(undefined) ?? undefined;
        return persistedMeta
          ? { sessionKey, storeSessionKey: sessionKey, acp: persistedMeta }
          : null;
      },
    );

    const manager = new AcpSessionManager();
    await manager.initializeSession({
      cfg: baseCfg,
      sessionKey,
      agent: "codex",
      mode: "persistent",
      runtimeOptions: {
        model: "openai/gpt-5.5",
      },
    });

    expect(persistedMeta?.runtimeOptions).toEqual({ model: "openai/gpt-5.5" });

    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey,
      storeSessionKey: sessionKey,
      acp: persistedMeta as SessionAcpMeta,
    });

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "do work",
      mode: "prompt",
      requestId: "run-applied-model",
      provenance: "system",
    });

    expectMockCallFields(runtimeState.setConfigOption, {
      key: "model",
      value: "openai/gpt-5.5",
    });
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(1);
  });
});

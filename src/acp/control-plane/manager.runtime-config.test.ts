/** Tests ACP runtime mode/config option persistence and backend control calls. */
import { describe, expect, it, vi } from "vitest";
import {
  type AcpRuntime,
  AcpRuntimeError,
  AcpSessionManager,
  baseCfg,
  createRuntime,
  expectMockCallFields,
  expectNoMockCallFields,
  expectRecordFields,
  expectRejectedRecord,
  extractRuntimeOptionsFromUpserts,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockCallArg,
  readySessionMeta,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager runtime config", () => {
  installAcpSessionManagerTestLifecycle();

  it("persists runtime mode changes through setSessionRuntimeMode", async () => {
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
    const options = await manager.setSessionRuntimeMode({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      runtimeMode: "plan",
    });

    expectMockCallFields(runtimeState.setMode, {
      mode: "plan",
    });
    expect(options.runtimeMode).toBe("plan");
    const persistedRuntimeModes = extractRuntimeOptionsFromUpserts().map(
      (entry) => entry?.runtimeMode,
    );
    expect(persistedRuntimeModes).toContain("plan");
  });

  it("reapplies persisted controls on next turn after runtime option updates", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      runtimeOptions: {
        runtimeMode: "plan",
      },
    };
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey =
        (paramsUnknown as { sessionKey?: string }).sessionKey ?? "agent:codex:acp:session-1";
      return {
        sessionKey,
        storeSessionKey: sessionKey,
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
    await manager.setSessionConfigOption({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      key: "model",
      value: "openai/gpt-5.4",
    });
    expect(runtimeState.setMode).not.toHaveBeenCalled();

    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "do work",
      mode: "prompt",
      requestId: "run-1",
    });

    expectMockCallFields(runtimeState.setMode, {
      mode: "plan",
    });
  });

  it("reconciles persisted ACP session identifiers from runtime status after a turn", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockResolvedValue({
      sessionKey: "agent:codex:acp:session-1",
      backend: "acpx",
      runtimeSessionName: "runtime-1",
      backendSessionId: "acpx-stale",
      agentSessionId: "agent-stale",
    });
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      backendSessionId: "acpx-fresh",
      agentSessionId: "agent-fresh",
      details: { status: "alive" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      identity: {
        state: "resolved",
        source: "status",
        acpxSessionId: "acpx-stale",
        agentSessionId: "agent-stale",
        lastUpdatedAt: Date.now(),
      },
    };
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey =
        (paramsUnknown as { sessionKey?: string }).sessionKey ?? "agent:codex:acp:session-1";
      return {
        sessionKey,
        storeSessionKey: sessionKey,
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
      provenance: "system",
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "do work",
      mode: "prompt",
      requestId: "run-1",
    });

    expect(runtimeState.getStatus).toHaveBeenCalledTimes(1);
    expect(currentMeta.identity?.acpxSessionId).toBe("acpx-fresh");
    expect(currentMeta.identity?.agentSessionId).toBe("agent-fresh");
  });

  it("reconciles oneshot ACP identity from runtime status before closing after a turn", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockResolvedValue({
      sessionKey: "agent:codex:acp:session-1",
      backend: "acpx",
      runtimeSessionName: "runtime-1",
      backendSessionId: "acpx-oneshot",
    });
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=done",
      backendSessionId: "acpx-oneshot",
      agentSessionId: "agent-oneshot",
      details: { status: "done" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    let currentMeta: SessionAcpMeta | undefined;
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey =
        (paramsUnknown as { sessionKey?: string }).sessionKey ?? "agent:codex:acp:session-1";
      return {
        sessionKey,
        storeSessionKey: sessionKey,
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
    await manager.initializeSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      agent: "codex",
      mode: "oneshot",
    });

    expectRecordFields(currentMeta?.identity, {
      state: "pending",
      acpxSessionId: "acpx-oneshot",
      source: "ensure",
    });

    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "do work",
      mode: "prompt",
      requestId: "run-1",
    });

    expect(runtimeState.getStatus).toHaveBeenCalledTimes(2);
    const closeInput = mockCallArg(runtimeState.close);
    expectRecordFields(closeInput, {
      reason: "oneshot-complete",
    });
    expectRecordFields(closeInput.handle, {
      backendSessionId: "acpx-oneshot",
      agentSessionId: "agent-oneshot",
    });
    expectRecordFields(currentMeta?.identity, {
      state: "resolved",
      acpxSessionId: "acpx-oneshot",
      agentSessionId: "agent-oneshot",
      source: "status",
    });
  });

  it("reconciles prompt-learned agent session IDs even when runtime status omits them", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockResolvedValue({
      sessionKey: "agent:gemini:acp:session-1",
      backend: "acpx",
      runtimeSessionName: "runtime-3",
      backendSessionId: "acpx-stale",
    });
    runtimeState.runTurn.mockImplementation(async function* (inputUnknown: unknown) {
      const input = inputUnknown as {
        handle: {
          agentSessionId?: string;
        };
      };
      input.handle.agentSessionId = "gemini-session-1";
      yield { type: "done" as const };
    });
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      details: { status: "alive" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      agent: "gemini",
      identity: {
        state: "pending",
        source: "ensure",
        acpxSessionId: "acpx-stale",
        lastUpdatedAt: Date.now(),
      },
    };
    const sessionKey = "agent:gemini:acp:session-1";
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
      provenance: "system",
      cfg: baseCfg,
      sessionKey,
      text: "learn prompt session",
      mode: "prompt",
      requestId: "run-prompt-learned-agent-id",
    });

    expect(currentMeta.identity?.state).toBe("resolved");
    expect(currentMeta.identity?.agentSessionId).toBe("gemini-session-1");
    expect(currentMeta.identity?.acpxSessionId).toBe("acpx-stale");
  });

  it("preserves existing ACP session identifiers when ensure returns none", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockResolvedValue({
      sessionKey: "agent:codex:acp:session-1",
      backend: "acpx",
      runtimeSessionName: "runtime-2",
    });
    runtimeState.getStatus.mockResolvedValue({
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
      acp: {
        ...readySessionMeta(),
        identity: {
          state: "resolved",
          source: "status",
          acpxSessionId: "acpx-stable",
          agentSessionId: "agent-stable",
          lastUpdatedAt: Date.now(),
        },
      },
    });

    const manager = new AcpSessionManager();
    const status = await manager.getSessionStatus({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
    });

    expect(status.identity?.acpxSessionId).toBe("acpx-stable");
    expect(status.identity?.agentSessionId).toBe("agent-stable");
  });

  it("applies persisted runtime options before running turns", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: {
        ...readySessionMeta(),
        runtimeOptions: {
          runtimeMode: "plan",
          model: "openai/gpt-5.4",
          thinking: "high",
          permissionProfile: "strict",
          timeoutSeconds: 120,
        },
      },
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "do work",
      mode: "prompt",
      requestId: "run-1",
    });

    expectMockCallFields(runtimeState.setMode, {
      mode: "plan",
    });
    expectMockCallFields(runtimeState.setConfigOption, {
      key: "model",
      value: "openai/gpt-5.4",
    });
    expectMockCallFields(runtimeState.setConfigOption, {
      key: "thinking",
      value: "high",
    });
    expectMockCallFields(runtimeState.setConfigOption, {
      key: "approval_policy",
      value: "strict",
    });
    expectMockCallFields(runtimeState.setConfigOption, {
      key: "timeout",
      value: "120",
    });
  });

  it("continues turns when adapters reject optional timeout config", async () => {
    const runtimeState = createRuntime();
    runtimeState.setConfigOption.mockImplementation(async (input: { key: string }) => {
      if (input.key === "timeout") {
        throw new AcpRuntimeError(
          "ACP_TURN_FAILED",
          'Agent rejected session/set_config_option for "timeout": ACP -32602 Invalid params',
        );
      }
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:opencode:acp:session-1",
      storeSessionKey: "agent:opencode:acp:session-1",
      acp: {
        ...readySessionMeta({ agent: "opencode" }),
        runtimeOptions: {
          timeoutSeconds: 120,
        },
      },
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey: "agent:opencode:acp:session-1",
      text: "do work",
      mode: "prompt",
      requestId: "run-opencode",
    });

    expectMockCallFields(runtimeState.setConfigOption, {
      key: "timeout",
      value: "120",
    });
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(1);
  });

  it("fails turns when optional timeout config writes hit runtime failures", async () => {
    const runtimeState = createRuntime();
    runtimeState.setConfigOption.mockImplementation(async (input: { key: string }) => {
      if (input.key === "timeout") {
        throw new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "ACP backend unavailable");
      }
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:opencode:acp:session-1",
      storeSessionKey: "agent:opencode:acp:session-1",
      acp: {
        ...readySessionMeta({ agent: "opencode" }),
        runtimeOptions: {
          timeoutSeconds: 120,
        },
      },
    });

    const manager = new AcpSessionManager();
    await expectRejectedRecord(
      manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:opencode:acp:session-1",
        text: "do work",
        mode: "prompt",
        requestId: "run-opencode",
      }),
      {
        code: "ACP_BACKEND_UNAVAILABLE",
      },
    );

    expectMockCallFields(runtimeState.setConfigOption, {
      key: "timeout",
      value: "120",
    });
    expect(runtimeState.runTurn).not.toHaveBeenCalled();
  });

  it("fails turns when adapters reject required runtime config", async () => {
    const runtimeState = createRuntime();
    runtimeState.setConfigOption.mockImplementation(async (input: { key: string }) => {
      if (input.key === "model") {
        throw new AcpRuntimeError(
          "ACP_TURN_FAILED",
          'Agent rejected session/set_config_option for "model": ACP -32602 Invalid params',
        );
      }
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:opencode:acp:session-1",
      storeSessionKey: "agent:opencode:acp:session-1",
      acp: {
        ...readySessionMeta({ agent: "opencode" }),
        runtimeOptions: {
          model: "opencode/gpt-5.4",
        },
      },
    });

    const manager = new AcpSessionManager();
    await expectRejectedRecord(
      manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:opencode:acp:session-1",
        text: "do work",
        mode: "prompt",
        requestId: "run-opencode",
      }),
      {
        code: "ACP_TURN_FAILED",
      },
    );

    expect(runtimeState.runTurn).not.toHaveBeenCalled();
  });

  it("maps persisted thinking runtime options to advertised effort config keys before running turns", async () => {
    const runtimeState = createRuntime();
    runtimeState.getCapabilities.mockResolvedValue({
      controls: ["session/set_mode", "session/set_config_option", "session/status"],
      configOptionKeys: ["mode", "model", "effort"],
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:claude:acp:session-1",
      storeSessionKey: "agent:claude:acp:session-1",
      acp: {
        ...readySessionMeta({ agent: "claude" }),
        runtimeOptions: {
          thinking: "high",
        },
      },
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey: "agent:claude:acp:session-1",
      text: "do work",
      mode: "prompt",
      requestId: "run-1",
    });

    expectMockCallFields(runtimeState.setConfigOption, {
      key: "effort",
      value: "high",
    });
    expectNoMockCallFields(runtimeState.setConfigOption, {
      key: "thinking",
    });
  });

  it("maps persisted runtime options to backend-advertised aliases before running turns", async () => {
    const runtimeState = createRuntime();
    runtimeState.getCapabilities.mockResolvedValue({
      controls: ["session/set_config_option", "session/status"],
      configOptionKeys: ["model", "thought_level", "permissions", "timeout_seconds"],
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:gemini:acp:session-1",
      storeSessionKey: "agent:gemini:acp:session-1",
      acp: {
        ...readySessionMeta({ agent: "gemini" }),
        runtimeOptions: {
          model: "gemini-3-flash-preview",
          thinking: "high",
          permissionProfile: "strict",
          timeoutSeconds: 120,
        },
      },
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey: "agent:gemini:acp:session-1",
      text: "do work",
      mode: "prompt",
      requestId: "run-1",
    });

    expectMockCallFields(runtimeState.setConfigOption, {
      key: "thought_level",
      value: "high",
    });
    expectMockCallFields(runtimeState.setConfigOption, {
      key: "permissions",
      value: "strict",
    });
    expectMockCallFields(runtimeState.setConfigOption, {
      key: "timeout_seconds",
      value: "120",
    });
    expectNoMockCallFields(runtimeState.setConfigOption, {
      key: "thinking",
    });
    expectNoMockCallFields(runtimeState.setConfigOption, {
      key: "approval_policy",
    });
    expectNoMockCallFields(runtimeState.setConfigOption, {
      key: "timeout",
    });
  });

  it("re-ensures runtime handles after cwd runtime option updates", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:session-cwd-update";
    let currentEntry = {
      sessionKey,
      storeSessionKey: sessionKey,
      acp: readySessionMeta(),
    };
    hoisted.readAcpSessionEntryMock.mockImplementation(() => currentEntry);
    hoisted.upsertAcpSessionMetaMock.mockImplementation((paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const nextMeta = params.mutate(currentEntry.acp, currentEntry);
      if (nextMeta === null) {
        return null;
      }
      currentEntry = {
        ...currentEntry,
        acp: nextMeta ?? currentEntry.acp,
      };
      return currentEntry;
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey,
      text: "first",
      mode: "prompt",
      requestId: "r1",
    });

    await expect(
      manager.updateSessionRuntimeOptions({
        cfg: baseCfg,
        sessionKey,
        patch: { cwd: "/workspace/next" },
      }),
    ).resolves.toEqual({
      cwd: "/workspace/next",
    });

    expect(currentEntry.acp.runtimeOptions).toEqual({
      cwd: "/workspace/next",
    });
    expect(currentEntry.acp.cwd).toBe("/workspace/next");

    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey,
      text: "second",
      mode: "prompt",
      requestId: "r2",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(runtimeState.ensureSession, 1), {
      sessionKey,
      cwd: "/workspace/next",
    });
  });

  it("returns unsupported-control error when backend does not support set_config_option", async () => {
    const runtimeState = createRuntime();
    const unsupportedRuntime: AcpRuntime = {
      ensureSession: runtimeState.ensureSession as AcpRuntime["ensureSession"],
      runTurn: runtimeState.runTurn as AcpRuntime["runTurn"],
      getCapabilities: vi.fn(async () => ({ controls: [] })),
      cancel: runtimeState.cancel as AcpRuntime["cancel"],
      close: runtimeState.close as AcpRuntime["close"],
    };
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: unsupportedRuntime,
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
        key: "model",
        value: "gpt-5.4",
      }),
      { code: "ACP_BACKEND_UNSUPPORTED_CONTROL" },
    );
  });

  it("does not send automatic thinking when the backend advertises no thinking control", async () => {
    const runtimeState = createRuntime();
    runtimeState.getCapabilities.mockResolvedValue({
      controls: ["session/set_config_option"],
      configOptionKeys: ["mode", "model"],
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:opencode:acp:session-1",
      storeSessionKey: "agent:opencode:acp:session-1",
      acp: readySessionMeta({
        agent: "opencode",
        runtimeOptions: { thinking: "high" },
      }),
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey: "agent:opencode:acp:session-1",
      text: "do work",
      mode: "prompt",
      requestId: "run-opencode-no-thinking",
    });

    expect(runtimeState.setConfigOption).not.toHaveBeenCalled();
    expect(runtimeState.runTurn).toHaveBeenCalledOnce();
  });

  it("maps automatic Codex thinking to the advertised reasoning effort control", async () => {
    const runtimeState = createRuntime();
    runtimeState.getCapabilities.mockResolvedValue({
      controls: ["session/set_config_option"],
      configOptionKeys: ["model", "reasoning_effort"],
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta({ runtimeOptions: { thinking: "high" } }),
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "do work",
      mode: "prompt",
      requestId: "run-codex-reasoning",
    });

    expectMockCallFields(runtimeState.setConfigOption, {
      key: "reasoning_effort",
      value: "high",
    });
  });

  it("rejects an explicit thinking write when the backend does not advertise it", async () => {
    const runtimeState = createRuntime();
    runtimeState.getCapabilities.mockResolvedValue({
      controls: ["session/set_config_option"],
      configOptionKeys: ["mode", "model"],
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:opencode:acp:session-1",
      storeSessionKey: "agent:opencode:acp:session-1",
      acp: readySessionMeta({ agent: "opencode" }),
    });

    const manager = new AcpSessionManager();
    await expectRejectedRecord(
      manager.setSessionConfigOption({
        cfg: baseCfg,
        sessionKey: "agent:opencode:acp:session-1",
        key: "thinking",
        value: "high",
      }),
      { code: "ACP_BACKEND_UNSUPPORTED_CONTROL" },
    );

    expect(runtimeState.setConfigOption).not.toHaveBeenCalled();
  });

  it("maps explicit thinking config updates to advertised effort keys", async () => {
    const runtimeState = createRuntime();
    runtimeState.getCapabilities.mockResolvedValue({
      controls: ["session/set_config_option", "session/status"],
      configOptionKeys: ["effort"],
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:claude:acp:session-1",
      storeSessionKey: "agent:claude:acp:session-1",
      acp: readySessionMeta({ agent: "claude" }),
    });

    const manager = new AcpSessionManager();
    const nextOptions = await manager.setSessionConfigOption({
      cfg: baseCfg,
      sessionKey: "agent:claude:acp:session-1",
      key: "thinking",
      value: "high",
    });

    expectMockCallFields(runtimeState.setConfigOption, {
      key: "effort",
      value: "high",
    });
    expect(nextOptions).toEqual({ thinking: "high" });
  });

  it("maps thinking config updates using status config options when capabilities omit keys", async () => {
    const runtimeState = createRuntime();
    runtimeState.getCapabilities.mockResolvedValue({
      controls: ["session/set_config_option", "session/status"],
    });
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      details: {
        configOptions: [{ id: "mode" }, { id: "model" }, { id: "effort" }],
      },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:claude:acp:session-1",
      storeSessionKey: "agent:claude:acp:session-1",
      acp: readySessionMeta({ agent: "claude" }),
    });

    const manager = new AcpSessionManager();
    const nextOptions = await manager.setSessionConfigOption({
      cfg: baseCfg,
      sessionKey: "agent:claude:acp:session-1",
      key: "thinking",
      value: "high",
    });

    expect(runtimeState.getStatus).toHaveBeenCalled();
    expectMockCallFields(runtimeState.setConfigOption, {
      key: "effort",
      value: "high",
    });
    expect(nextOptions).toEqual({ thinking: "high" });
  });

  it("persists explicit native effort config updates as canonical thinking options", async () => {
    const runtimeState = createRuntime();
    runtimeState.getCapabilities.mockResolvedValue({
      controls: ["session/set_config_option", "session/status"],
      configOptionKeys: ["effort"],
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:claude:acp:session-1",
      storeSessionKey: "agent:claude:acp:session-1",
      acp: readySessionMeta({ agent: "claude" }),
    });

    const manager = new AcpSessionManager();
    const nextOptions = await manager.setSessionConfigOption({
      cfg: baseCfg,
      sessionKey: "agent:claude:acp:session-1",
      key: "effort",
      value: "high",
    });

    expectMockCallFields(runtimeState.setConfigOption, {
      key: "effort",
      value: "high",
    });
    expect(nextOptions).toEqual({ thinking: "high" });
  });

  it("persists explicit native permission_mode config updates as canonical permission profiles", async () => {
    const runtimeState = createRuntime();
    runtimeState.getCapabilities.mockResolvedValue({
      controls: ["session/set_config_option", "session/status"],
      configOptionKeys: ["permission_mode"],
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:claude:acp:session-1",
      storeSessionKey: "agent:claude:acp:session-1",
      acp: readySessionMeta({ agent: "claude" }),
    });

    const manager = new AcpSessionManager();
    const nextOptions = await manager.setSessionConfigOption({
      cfg: baseCfg,
      sessionKey: "agent:claude:acp:session-1",
      key: "permission_mode",
      value: "strict",
    });

    expectMockCallFields(runtimeState.setConfigOption, {
      key: "permission_mode",
      value: "strict",
    });
    expect(nextOptions).toEqual({ permissionProfile: "strict" });
  });
});

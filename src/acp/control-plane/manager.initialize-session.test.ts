/** Tests ACP manager session initialization and persisted runtime options. */
import { describe, expect, it } from "vitest";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  expectRecordFields,
  extractRuntimeOptionsFromUpserts,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockCallArg,
  readySessionMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager initializeSession", () => {
  installAcpSessionManagerTestLifecycle();

  it("persists runtime options provided during initializeSession", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.upsertAcpSessionMetaMock.mockResolvedValue({
      sessionKey: "agent:codex:acp:session-a",
      storeSessionKey: "agent:codex:acp:session-a",
      acp: readySessionMeta({
        runtimeOptions: {
          model: "openai/gpt-5.4",
          thinking: "high",
        },
      }),
    });

    const manager = new AcpSessionManager();
    await manager.initializeSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-a",
      agent: "codex",
      mode: "persistent",
      runtimeOptions: {
        model: "openai/gpt-5.4",
        thinking: "high",
      },
    });

    expect(extractRuntimeOptionsFromUpserts()).toEqual([
      {
        model: "openai/gpt-5.4",
        thinking: "high",
      },
    ]);
    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey: "agent:codex:acp:session-a",
      model: "openai/gpt-5.4",
      thinking: "high",
    });
  });

  it("forwards inherited thinking provenance and omits thinking dropped by the backend", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockResolvedValueOnce({
      sessionKey: "agent:codex:acp:session-inherited-max",
      backend: "acpx",
      runtimeSessionName: "codex",
      appliedThinking: { kind: "dropped" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.upsertAcpSessionMetaMock.mockResolvedValue({
      sessionKey: "agent:codex:acp:session-inherited-max",
      storeSessionKey: "agent:codex:acp:session-inherited-max",
      acp: readySessionMeta(),
    });

    const manager = new AcpSessionManager();
    await manager.initializeSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-inherited-max",
      agent: "codex",
      mode: "persistent",
      runtimeOptions: { thinking: "max" },
      thinkingExplicit: false,
    });

    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      thinking: "max",
      thinkingExplicit: false,
    });
    expect(extractRuntimeOptionsFromUpserts()).toEqual([undefined]);
  });

  it("preserves runtimeOptions cwd when initializeSession cwd is omitted", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.upsertAcpSessionMetaMock.mockResolvedValue({
      sessionKey: "agent:codex:acp:session-cwd-runtime-options",
      storeSessionKey: "agent:codex:acp:session-cwd-runtime-options",
      acp: readySessionMeta({
        runtimeOptions: {
          cwd: "/workspace/from-runtime-options",
        },
        cwd: "/workspace/from-runtime-options",
      }),
    });

    const manager = new AcpSessionManager();
    await manager.initializeSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-cwd-runtime-options",
      agent: "codex",
      mode: "persistent",
      runtimeOptions: {
        cwd: "/workspace/from-runtime-options",
      },
    });

    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey: "agent:codex:acp:session-cwd-runtime-options",
      cwd: "/workspace/from-runtime-options",
    });
    expect(extractRuntimeOptionsFromUpserts()).toEqual([
      {
        cwd: "/workspace/from-runtime-options",
      },
    ]);
  });

  it("rolls back ensured runtime sessions when metadata persistence fails", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.upsertAcpSessionMetaMock.mockRejectedValueOnce(new Error("disk full"));

    const manager = new AcpSessionManager();
    await expect(
      manager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        agent: "codex",
        mode: "persistent",
      }),
    ).rejects.toThrow("disk full");
    const closeInput = mockCallArg(runtimeState.close);
    expectRecordFields(closeInput, {
      reason: "init-meta-failed",
    });
    expectRecordFields(closeInput.handle, {
      sessionKey: "agent:codex:acp:session-1",
    });
  });
});

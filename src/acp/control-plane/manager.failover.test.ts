/** Tests ACP manager backend failover across initialization and turn execution. */
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import {
  AcpRuntimeError,
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  readySessionMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager backend failover", () => {
  installAcpSessionManagerTestLifecycle();

  function setupFailoverBackends(
    params: {
      initialBackend?: "primary-backend" | "fallback-backend";
      primaryUnavailableError?: Error;
    } = {},
  ) {
    const primaryRuntime = createRuntime();
    const fallbackRuntime = createRuntime();
    const sessionKey = "agent:codex:acp:session-1";
    const initialBackend = params.initialBackend ?? "primary-backend";
    let currentMeta = readySessionMeta({
      backend: initialBackend,
      runtimeSessionName:
        initialBackend === "fallback-backend" ? "fallback-runtime" : "primary-runtime",
    });
    primaryRuntime.ensureSession.mockImplementation(async (input) => ({
      sessionKey: input.sessionKey,
      backend: "primary-backend",
      runtimeSessionName: "primary-runtime",
    }));
    fallbackRuntime.ensureSession.mockImplementation(async (input) => ({
      sessionKey: input.sessionKey,
      backend: "fallback-backend",
      runtimeSessionName: "fallback-runtime",
    }));
    hoisted.requireAcpRuntimeBackendMock.mockImplementation((backendId?: string) => {
      if (backendId === "primary-backend") {
        if (params.primaryUnavailableError) {
          throw params.primaryUnavailableError;
        }
        return {
          id: "primary-backend",
          runtime: primaryRuntime.runtime,
        };
      }
      if (backendId === "fallback-backend") {
        return {
          id: "fallback-backend",
          runtime: fallbackRuntime.runtime,
        };
      }
      throw new Error(`unexpected backend ${backendId ?? "<auto>"}`);
    });
    hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
      sessionKey,
      storeSessionKey: sessionKey,
      acp: currentMeta,
    }));
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const upsertParams = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = upsertParams.mutate(currentMeta, { acp: currentMeta });
      if (next) {
        currentMeta = next;
      }
      return {
        sessionId: "session-1",
        updatedAt: Date.now(),
        acp: currentMeta,
      };
    });
    const cfg = {
      acp: {
        ...baseCfg.acp,
        backend: "primary-backend",
        fallbacks: ["fallback-backend"],
      },
    } as OpenClawConfig;
    return {
      cfg,
      fallbackRuntime,
      get currentMeta() {
        return currentMeta;
      },
      primaryRuntime,
      sessionKey,
    };
  }

  it("starts later failover turns on the configured primary backend", async () => {
    const harness = setupFailoverBackends({ initialBackend: "fallback-backend" });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: harness.cfg,
      sessionKey: harness.sessionKey,
      text: "use primary",
      mode: "prompt",
      requestId: "r-primary",
    });

    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledWith("primary-backend");
    expect(harness.primaryRuntime.runTurn).toHaveBeenCalledTimes(1);
    expect(harness.fallbackRuntime.runTurn).not.toHaveBeenCalled();
    expect(harness.currentMeta.backend).toBe("primary-backend");
  });

  it("closes cached fallback handles before returning later turns to the primary backend", async () => {
    const harness = setupFailoverBackends();
    harness.primaryRuntime.runtime.startTurn = vi.fn((input) => ({
      requestId: input.requestId,
      promptSubmission: Promise.resolve("not_submitted" as const),
      events: (async function* () {})(),
      result: Promise.resolve({
        status: "failed" as const,
        error: { code: "ACP_TURN_FAILED", message: "backend unavailable" },
      }),
      cancel: async () => {},
      closeStream: async () => {},
    }));

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: harness.cfg,
      sessionKey: harness.sessionKey,
      text: "use fallback",
      mode: "prompt",
      requestId: "r-fallback",
    });
    expect(harness.currentMeta.backend).toBe("fallback-backend");
    expect(harness.fallbackRuntime.runTurn).toHaveBeenCalledTimes(1);

    harness.fallbackRuntime.close.mockClear();
    harness.primaryRuntime.runtime.startTurn = undefined;
    await manager.runTurn({
      provenance: "system",
      cfg: harness.cfg,
      sessionKey: harness.sessionKey,
      text: "return to primary",
      mode: "prompt",
      requestId: "r-primary",
    });

    expect(harness.fallbackRuntime.close).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "runtime-handle-replaced",
      }),
    );
    expect(harness.primaryRuntime.runTurn).toHaveBeenCalledTimes(1);
    expect(harness.currentMeta.backend).toBe("primary-backend");
  });

  it("closes the previous persistent handle before switching fallback backends", async () => {
    const harness = setupFailoverBackends();
    harness.primaryRuntime.runtime.startTurn = (input) => ({
      requestId: input.requestId,
      promptSubmission: Promise.resolve("not_submitted" as const),
      events: (async function* () {})(),
      result: Promise.resolve({
        status: "failed" as const,
        error: { code: "ACP_TURN_FAILED", message: "backend unavailable" },
      }),
      cancel: async () => {},
      closeStream: async () => {},
    });

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        provenance: "system",
        cfg: harness.cfg,
        sessionKey: harness.sessionKey,
        text: "fallback",
        mode: "prompt",
        requestId: "r-fallback",
      }),
    ).resolves.toBeUndefined();

    expect(harness.primaryRuntime.close).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "backend-failover",
      }),
    );
    expect(harness.fallbackRuntime.runTurn).toHaveBeenCalledTimes(1);
  });

  it("fails over when the primary backend is registered but unavailable", async () => {
    const harness = setupFailoverBackends({
      primaryUnavailableError: new AcpRuntimeError(
        "ACP_BACKEND_UNAVAILABLE",
        "primary backend unavailable",
      ),
    });

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        provenance: "system",
        cfg: harness.cfg,
        sessionKey: harness.sessionKey,
        text: "fallback",
        mode: "prompt",
        requestId: "r-unavailable",
      }),
    ).resolves.toBeUndefined();

    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledWith("primary-backend");
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledWith("fallback-backend");
    expect(harness.fallbackRuntime.runTurn).toHaveBeenCalledTimes(1);
  });

  it("fails over for common rate limit wording before output", async () => {
    const harness = setupFailoverBackends();
    const primaryStartTurn = vi.fn((input) => ({
      requestId: input.requestId,
      promptSubmission: Promise.resolve("not_submitted" as const),
      events: (async function* () {})(),
      result: Promise.resolve({
        status: "failed" as const,
        error: { code: "ACP_TURN_FAILED", message: "rate limit exceeded" },
      }),
      cancel: async () => {},
      closeStream: async () => {},
    }));
    harness.primaryRuntime.runtime.startTurn = primaryStartTurn;

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        provenance: "system",
        cfg: harness.cfg,
        sessionKey: harness.sessionKey,
        text: "fallback",
        mode: "prompt",
        requestId: "r-rate-limit",
      }),
    ).resolves.toBeUndefined();

    expect(primaryStartTurn).toHaveBeenCalledTimes(1);
    expect(harness.fallbackRuntime.runTurn).toHaveBeenCalledTimes(1);
  });

  it("fails over when startTurn throws before a turn is acquired", async () => {
    const harness = setupFailoverBackends();
    const primaryStartTurn = vi.fn(() => {
      throw new Error("backend temporarily unavailable");
    });
    harness.primaryRuntime.runtime.startTurn = primaryStartTurn;

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        provenance: "system",
        cfg: harness.cfg,
        sessionKey: harness.sessionKey,
        text: "fallback safely",
        mode: "prompt",
        requestId: "r-sync-not-submitted",
      }),
    ).resolves.toBeUndefined();

    expect(primaryStartTurn).toHaveBeenCalledOnce();
    expect(harness.primaryRuntime.ensureSession).toHaveBeenCalledOnce();
    expect(harness.fallbackRuntime.ensureSession).toHaveBeenCalledOnce();
    expect(harness.fallbackRuntime.runTurn).toHaveBeenCalledOnce();
  });

  it("reports the first acquired turn independently of prompt submission", async () => {
    const harness = setupFailoverBackends();
    harness.primaryRuntime.runtime.startTurn = (input) => ({
      requestId: input.requestId,
      promptSubmission: Promise.resolve("not_submitted" as const),
      events: (async function* () {})(),
      result: Promise.resolve({
        status: "failed" as const,
        error: {
          code: "ACP_TURN_FAILED",
          message: "backend unavailable before submission",
        },
      }),
      cancel: async () => {},
      closeStream: async () => {},
    });
    const fallbackStartTurn = vi.fn((input) => ({
      requestId: input.requestId,
      promptSubmission: Promise.resolve("submitted" as const),
      events: (async function* () {})(),
      result: Promise.resolve({ status: "completed" as const }),
      cancel: async () => {},
      closeStream: async () => {},
    }));
    harness.fallbackRuntime.runtime.startTurn = fallbackStartTurn;
    const onTurnStreamAcquired = vi.fn();
    const onLifecycle = vi.fn();

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        provenance: "system",
        cfg: harness.cfg,
        sessionKey: harness.sessionKey,
        text: "fallback",
        mode: "prompt",
        requestId: "r-prompt-readiness-fallback",
        onTurnStreamAcquired,
        onLifecycle,
      }),
    ).resolves.toBeUndefined();

    expect(onTurnStreamAcquired).toHaveBeenCalledOnce();
    expect(onLifecycle).toHaveBeenCalledOnce();
  });

  it("does not fail over after a prompt was submitted", async () => {
    const harness = setupFailoverBackends();
    harness.primaryRuntime.runtime.startTurn = (input) => ({
      requestId: input.requestId,
      promptSubmission: Promise.resolve("submitted" as const),
      events: (async function* () {})(),
      result: Promise.resolve({
        status: "failed" as const,
        error: {
          code: "ACP_TURN_FAILED",
          message: "backend unavailable after submission",
        },
      }),
      cancel: async () => {},
      closeStream: async () => {},
    });
    const fallbackStartTurn = vi.fn((input) => ({
      requestId: input.requestId,
      promptSubmission: Promise.resolve("submitted" as const),
      events: (async function* () {})(),
      result: Promise.resolve({ status: "completed" as const }),
      cancel: async () => {},
      closeStream: async () => {},
    }));
    harness.fallbackRuntime.runtime.startTurn = fallbackStartTurn;
    const onTurnStreamAcquired = vi.fn();
    const onLifecycle = vi.fn();

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        provenance: "system",
        cfg: harness.cfg,
        sessionKey: harness.sessionKey,
        text: "fallback",
        mode: "prompt",
        requestId: "r-submitted-prompt-failover",
        onTurnStreamAcquired,
        onLifecycle,
      }),
    ).rejects.toThrow("backend unavailable after submission");

    expect(onTurnStreamAcquired).toHaveBeenCalledOnce();
    expect(onLifecycle).toHaveBeenCalledOnce();
    expect(fallbackStartTurn).not.toHaveBeenCalled();
  });

  it("does not fail over when prompt submission authority is unknown", async () => {
    const harness = setupFailoverBackends();
    harness.primaryRuntime.runtime.startTurn = (input) => ({
      requestId: input.requestId,
      events: (async function* () {})(),
      result: Promise.resolve({
        status: "failed" as const,
        error: {
          code: "ACP_TURN_FAILED",
          message: "backend unavailable with unknown submission state",
        },
      }),
      cancel: async () => {},
      closeStream: async () => {},
    });
    const fallbackStartTurn = vi.fn((input) => ({
      requestId: input.requestId,
      promptSubmission: Promise.resolve("submitted" as const),
      events: (async function* () {})(),
      result: Promise.resolve({ status: "completed" as const }),
      cancel: async () => {},
      closeStream: async () => {},
    }));
    harness.fallbackRuntime.runtime.startTurn = fallbackStartTurn;

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        provenance: "system",
        cfg: harness.cfg,
        sessionKey: harness.sessionKey,
        text: "do not duplicate",
        mode: "prompt",
        requestId: "r-unknown-prompt-failover",
      }),
    ).rejects.toThrow("backend unavailable with unknown submission state");

    expect(fallbackStartTurn).not.toHaveBeenCalled();
  });

  it("does not fail over after a backend has emitted output", async () => {
    const harness = setupFailoverBackends();
    harness.primaryRuntime.runTurn.mockImplementation(async function* () {
      yield { type: "text_delta" as const, text: "partial" };
      throw new AcpRuntimeError("ACP_TURN_FAILED", "backend unavailable");
    });
    const events: unknown[] = [];

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        provenance: "system",
        cfg: harness.cfg,
        sessionKey: harness.sessionKey,
        text: "do not duplicate",
        mode: "prompt",
        requestId: "r-output",
        onEvent: (event) => {
          events.push(event);
        },
      }),
    ).rejects.toMatchObject({
      code: "ACP_TURN_FAILED",
    });

    expect(events).toEqual([expect.objectContaining({ type: "text_delta", text: "partial" })]);
    expect(harness.fallbackRuntime.runTurn).not.toHaveBeenCalled();
  });
});

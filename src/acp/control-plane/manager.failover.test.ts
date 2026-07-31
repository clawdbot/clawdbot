/** Tests ACP manager backend failover across initialization and turn execution. */
import { describe, expect, it } from "vitest";
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
    harness.primaryRuntime.runTurn.mockImplementationOnce(async function* () {
      if (Date.now() < 0) {
        yield { type: "done" as const };
      }
      throw new AcpRuntimeError("ACP_TURN_FAILED", "backend unavailable");
    });

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
    expect(harness.primaryRuntime.runTurn).toHaveBeenCalledTimes(2);
    expect(harness.currentMeta.backend).toBe("primary-backend");
  });

  it("closes the previous persistent handle before switching fallback backends", async () => {
    const harness = setupFailoverBackends();
    harness.primaryRuntime.runTurn.mockImplementation(async function* () {
      if (Date.now() < 0) {
        yield { type: "done" as const };
      }
      throw new AcpRuntimeError("ACP_TURN_FAILED", "backend unavailable");
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
    harness.primaryRuntime.runTurn.mockImplementation(async function* () {
      if (Date.now() < 0) {
        yield { type: "done" as const };
      }
      throw new AcpRuntimeError("ACP_TURN_FAILED", "rate limit exceeded");
    });

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

    expect(harness.primaryRuntime.runTurn).toHaveBeenCalledTimes(1);
    expect(harness.fallbackRuntime.runTurn).toHaveBeenCalledTimes(1);
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

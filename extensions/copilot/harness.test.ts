import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CopilotClientPool } from "./harness.js";
import { createCopilotAgentHarness } from "./harness.js";

const mocks = vi.hoisted(() => ({
  runCopilotAttempt: vi.fn(),
  createCopilotClientPool: vi.fn(),
}));

vi.mock("./src/attempt.js", () => ({
  runCopilotAttempt: mocks.runCopilotAttempt,
}));

vi.mock("./src/runtime.js", () => ({
  createCopilotClientPool: mocks.createCopilotClientPool,
}));

const ATTEMPT_PARAMS = { provider: "github-copilot", model: "gpt-4.1" } as any;
const ATTEMPT_RESULT = { ok: true } as any;

function makePoolMock(): CopilotClientPool {
  return {
    acquire: vi.fn(),
    release: vi.fn(),
    dispose: vi.fn().mockResolvedValue([]),
    size: vi.fn().mockReturnValue(0),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createCopilotAgentHarness", () => {
  beforeEach(() => {
    mocks.runCopilotAttempt.mockReset();
    mocks.createCopilotClientPool.mockReset();
    mocks.runCopilotAttempt.mockResolvedValue(ATTEMPT_RESULT);
    mocks.createCopilotClientPool.mockImplementation(() => makePoolMock());
  });

  it("returns the copilot id and default label", () => {
    const harness = createCopilotAgentHarness();

    expect(harness.id).toBe("copilot");
    expect(harness.label).toBe("GitHub Copilot agent runtime");
  });

  it("accepts custom id and label from options", () => {
    const harness = createCopilotAgentHarness({ id: "sdk", label: "SDK Harness" });

    expect(harness.id).toBe("sdk");
    expect(harness.label).toBe("SDK Harness");
  });

  it("supports returns false in auto runtime even for github provider", () => {
    const harness = createCopilotAgentHarness();

    expect(
      harness.supports({
        provider: "github-copilot",
        modelId: "gpt-4.1",
        requestedRuntime: "auto",
      }),
    ).toEqual({
      supported: false,
      reason: "copilot is opt-in only",
    });
  });

  it("supports returns false in pi runtime", () => {
    const harness = createCopilotAgentHarness();

    expect(
      harness.supports({ provider: "github-copilot", modelId: "gpt-4.1", requestedRuntime: "pi" }),
    ).toEqual({
      supported: false,
      reason: "copilot is opt-in only",
    });
  });

  it("supports returns true for requestedRuntime copilot with github-copilot provider", () => {
    const harness = createCopilotAgentHarness();

    expect(
      harness.supports({
        provider: "github-copilot",
        modelId: "gpt-4.1",
        requestedRuntime: "copilot",
      }),
    ).toEqual({ supported: true, priority: 100 });
  });

  it("supports normalizes provider casing and whitespace", () => {
    const harness = createCopilotAgentHarness();

    expect(
      harness.supports({
        provider: "  GitHub-Copilot  ",
        modelId: "gpt-4.1",
        requestedRuntime: "copilot",
      }),
    ).toEqual({ supported: true, priority: 100 });
  });

  it("supports normalizes requestedRuntime casing", () => {
    const harness = createCopilotAgentHarness();

    expect(
      harness.supports({
        provider: "github-copilot",
        modelId: "gpt-4.1",
        requestedRuntime: "  COPILOT  " as any,
      }),
    ).toEqual({ supported: true, priority: 100 });
  });

  it("supports rejects providers outside the whitelist", () => {
    const harness = createCopilotAgentHarness();

    expect(
      harness.supports({
        provider: "anthropic",
        modelId: "claude-sonnet-4.5",
        requestedRuntime: "copilot",
      }),
    ).toEqual({
      supported: false,
      reason: "provider is not one of: github-copilot",
    });
    // Legacy aspirational ids should not be claimed by the harness.
    for (const legacyId of ["github", "openclaw", "copilot"]) {
      expect(
        harness.supports({
          provider: legacyId,
          modelId: "gpt-4.1",
          requestedRuntime: "copilot",
        }),
      ).toEqual({
        supported: false,
        reason: "provider is not one of: github-copilot",
      });
    }
  });

  it("runAttempt lazy-imports attempt by waiting until invocation to create a pool", async () => {
    const pool = makePoolMock();
    mocks.createCopilotClientPool.mockReturnValue(pool);
    const harness = createCopilotAgentHarness();

    expect(mocks.createCopilotClientPool).not.toHaveBeenCalled();
    expect(mocks.runCopilotAttempt).not.toHaveBeenCalled();

    await expect(harness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(ATTEMPT_RESULT);

    expect(mocks.createCopilotClientPool).toHaveBeenCalledTimes(1);
    expect(mocks.runCopilotAttempt).toHaveBeenCalledTimes(1);
  });

  it("runAttempt creates one pool lazily and reuses it across two attempts on the same harness", async () => {
    const pool = makePoolMock();
    const firstResult = { attempt: 1 } as any;
    const secondResult = { attempt: 2 } as any;
    mocks.createCopilotClientPool.mockReturnValue(pool);
    mocks.runCopilotAttempt.mockResolvedValueOnce(firstResult).mockResolvedValueOnce(secondResult);
    const harness = createCopilotAgentHarness();

    await expect(harness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(firstResult);
    await expect(harness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(secondResult);

    expect(mocks.createCopilotClientPool).toHaveBeenCalledTimes(1);
    expect(mocks.runCopilotAttempt).toHaveBeenNthCalledWith(
      1,
      ATTEMPT_PARAMS,
      expect.objectContaining({ pool }),
    );
    expect(mocks.runCopilotAttempt).toHaveBeenNthCalledWith(
      2,
      ATTEMPT_PARAMS,
      expect.objectContaining({ pool }),
    );
  });

  it("multiple harness instances create independent pools", async () => {
    const poolOne = makePoolMock();
    const poolTwo = makePoolMock();
    mocks.createCopilotClientPool.mockReturnValueOnce(poolOne).mockReturnValueOnce(poolTwo);
    const firstHarness = createCopilotAgentHarness();
    const secondHarness = createCopilotAgentHarness();

    await expect(firstHarness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(ATTEMPT_RESULT);
    await expect(secondHarness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(ATTEMPT_RESULT);

    expect(mocks.createCopilotClientPool).toHaveBeenCalledTimes(2);
    expect(mocks.runCopilotAttempt).toHaveBeenNthCalledWith(
      1,
      ATTEMPT_PARAMS,
      expect.objectContaining({ pool: poolOne }),
    );
    expect(mocks.runCopilotAttempt).toHaveBeenNthCalledWith(
      2,
      ATTEMPT_PARAMS,
      expect.objectContaining({ pool: poolTwo }),
    );
  });

  it("runAttempt does not serialize concurrent attempts", async () => {
    const pool = makePoolMock();
    const firstResult = { attempt: 1 } as any;
    const secondResult = { attempt: 2 } as any;
    mocks.createCopilotClientPool.mockReturnValue(pool);
    mocks.runCopilotAttempt.mockResolvedValueOnce(firstResult).mockResolvedValueOnce(secondResult);
    const harness = createCopilotAgentHarness();

    await expect(harness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(firstResult);
    await expect(harness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(secondResult);

    expect(mocks.createCopilotClientPool).toHaveBeenCalledTimes(1);
    expect(mocks.runCopilotAttempt).toHaveBeenCalledTimes(2);
  });

  it("dispose before first runAttempt does not create a pool", async () => {
    const harness = createCopilotAgentHarness();

    await expect(harness.dispose?.()).resolves.toBeUndefined();

    expect(mocks.createCopilotClientPool).not.toHaveBeenCalled();
  });

  it("dispose during lazy startup prevents the attempt from creating a pool", async () => {
    const harness = createCopilotAgentHarness();

    const attemptPromise = harness.runAttempt(ATTEMPT_PARAMS);
    const disposePromise = harness.dispose?.();

    await expect(attemptPromise).rejects.toThrow(
      "[copilot] harness was disposed while starting an attempt",
    );
    await expect(disposePromise).resolves.toBeUndefined();
    expect(mocks.createCopilotClientPool).not.toHaveBeenCalled();
    expect(mocks.runCopilotAttempt).not.toHaveBeenCalled();
  });

  it("dispose after pool creation calls pool.dispose once even when called twice", async () => {
    const pool = makePoolMock();
    mocks.createCopilotClientPool.mockReturnValue(pool);
    const harness = createCopilotAgentHarness();

    await harness.runAttempt(ATTEMPT_PARAMS);

    const firstDispose = harness.dispose?.();
    const secondDispose = harness.dispose?.();

    await expect(firstDispose).resolves.toBeUndefined();
    await expect(secondDispose).resolves.toBeUndefined();
    expect(pool.dispose).toHaveBeenCalledTimes(1);
  });

  it("dispose waits for in-flight runAttempt before disposing", async () => {
    const pool = makePoolMock();
    const deferred = createDeferred<any>();
    mocks.createCopilotClientPool.mockReturnValue(pool);
    mocks.runCopilotAttempt.mockImplementation(() => deferred.promise);
    const harness = createCopilotAgentHarness();

    const attemptPromise = harness.runAttempt(ATTEMPT_PARAMS);
    await flushAsyncWork();

    const disposePromise = harness.dispose?.();
    let disposeSettled = false;
    void disposePromise?.then(() => {
      disposeSettled = true;
    });

    await flushAsyncWork();

    expect(pool.dispose).not.toHaveBeenCalled();
    expect(disposeSettled).toBe(false);

    deferred.resolve(ATTEMPT_RESULT);

    await expect(attemptPromise).resolves.toBe(ATTEMPT_RESULT);
    await expect(disposePromise).resolves.toBeUndefined();
    expect(pool.dispose).toHaveBeenCalledTimes(1);
  });

  it("runAttempt after dispose rejects without creating a new pool", async () => {
    const harness = createCopilotAgentHarness();

    await harness.dispose?.();

    await expect(harness.runAttempt(ATTEMPT_PARAMS)).rejects.toThrow(
      "[copilot] harness has been disposed; cannot start new attempts",
    );
    expect(mocks.createCopilotClientPool).not.toHaveBeenCalled();
  });

  it("dispose surfaces pool.dispose errors as AggregateError", async () => {
    const pool = makePoolMock();
    const errors = [new Error("first"), new Error("second")];
    pool.dispose = vi.fn().mockResolvedValue(errors);
    mocks.createCopilotClientPool.mockReturnValue(pool);
    const harness = createCopilotAgentHarness();

    await harness.runAttempt(ATTEMPT_PARAMS);

    try {
      await harness.dispose?.();
      throw new Error("expected dispose to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).message).toBe("[copilot] pool disposal errors");
      expect((error as AggregateError).errors).toEqual(errors);
    }
  });

  it("dispose does not dispose a caller-supplied pool", async () => {
    const pool = makePoolMock();
    const harness = createCopilotAgentHarness({ pool });

    await harness.runAttempt(ATTEMPT_PARAMS);
    await expect(harness.dispose?.()).resolves.toBeUndefined();

    expect(pool.dispose).not.toHaveBeenCalled();
  });

  it("uses options.pool when supplied", async () => {
    const pool = makePoolMock();
    const harness = createCopilotAgentHarness({ pool });

    await expect(harness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(ATTEMPT_RESULT);

    expect(mocks.createCopilotClientPool).not.toHaveBeenCalled();
    expect(mocks.runCopilotAttempt).toHaveBeenCalledWith(
      ATTEMPT_PARAMS,
      expect.objectContaining({ pool }),
    );
  });

  describe("reset", () => {
    it("is a no-op when params.sessionId is missing", async () => {
      const pool = makePoolMock();
      const harness = createCopilotAgentHarness({ pool });

      await expect(harness.reset?.({})).resolves.toBeUndefined();
    });

    it("is a no-op when the session was never tracked", async () => {
      const pool = makePoolMock();
      const harness = createCopilotAgentHarness({ pool });

      await expect(harness.reset?.({ sessionId: "unknown" })).resolves.toBeUndefined();
    });

    it("calls deleteSession on the client that created the session", async () => {
      const pool = makePoolMock();
      const deleteSession = vi.fn().mockResolvedValue(undefined);
      const client = { deleteSession } as any;
      mocks.runCopilotAttempt.mockImplementation(async (params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-123",
          pooledClient: { key: {} as any, client },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-sess-1" });
      await harness.reset?.({ sessionId: "oc-sess-1" });

      expect(deleteSession).toHaveBeenCalledTimes(1);
      expect(deleteSession).toHaveBeenCalledWith("sdk-sess-123");
    });

    it("does not call deleteSession when no sdkSessionId was reported", async () => {
      const pool = makePoolMock();
      const deleteSession = vi.fn().mockResolvedValue(undefined);
      mocks.runCopilotAttempt.mockImplementation(async (_params, _deps) => ATTEMPT_RESULT);
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-sess-2" });
      await harness.reset?.({ sessionId: "oc-sess-2" });

      expect(deleteSession).not.toHaveBeenCalled();
    });

    it("swallows errors thrown by client.deleteSession", async () => {
      const pool = makePoolMock();
      const deleteSession = vi.fn().mockRejectedValue(new Error("session not found"));
      const client = { deleteSession } as any;
      mocks.runCopilotAttempt.mockImplementation(async (params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-err",
          pooledClient: { key: {} as any, client },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-sess-3" });

      await expect(harness.reset?.({ sessionId: "oc-sess-3" })).resolves.toBeUndefined();
      expect(deleteSession).toHaveBeenCalledTimes(1);
    });

    it("forgets the session after reset; a second reset is a no-op", async () => {
      const pool = makePoolMock();
      const deleteSession = vi.fn().mockResolvedValue(undefined);
      const client = { deleteSession } as any;
      mocks.runCopilotAttempt.mockImplementation(async (params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-x",
          pooledClient: { key: {} as any, client },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-sess-4" });
      await harness.reset?.({ sessionId: "oc-sess-4" });
      await harness.reset?.({ sessionId: "oc-sess-4" });

      expect(deleteSession).toHaveBeenCalledTimes(1);
    });

    it("does not invoke deleteSession for a session belonging to a different openclawSessionId", async () => {
      const pool = makePoolMock();
      const deleteSession = vi.fn().mockResolvedValue(undefined);
      const client = { deleteSession } as any;
      mocks.runCopilotAttempt.mockImplementation(async (params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-y",
          pooledClient: { key: {} as any, client },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-A" });
      await harness.reset?.({ sessionId: "oc-B" });

      expect(deleteSession).not.toHaveBeenCalled();
    });
  });

  it("dispose clears tracked sessions so subsequent reset is a no-op", async () => {
    const pool = makePoolMock();
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const client = { deleteSession } as any;
    mocks.runCopilotAttempt.mockImplementation(async (params, deps) => {
      deps.onSessionEstablished?.({
        sdkSessionId: "sdk-sess-d",
        pooledClient: { key: {} as any, client },
      });
      return ATTEMPT_RESULT;
    });
    const harness = createCopilotAgentHarness({ pool });

    await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-disp" });
    await harness.dispose?.();
    await harness.reset?.({ sessionId: "oc-disp" });

    expect(deleteSession).not.toHaveBeenCalled();
  });

  describe("session reuse across turns (dogfood finding #4)", () => {
    // These tests pin the harness's session-reuse contract: subsequent
    // `runAttempt` calls within the same OpenClaw session should pass
    // the tracked `sdkSessionId` to the attempt via `initialReplayState`
    // so the SDK can `resumeSession` and keep its prompt cache + thread
    // history warm. Compatibility-fingerprint mismatch (provider/model/
    // cwd/auth) starts a fresh SDK session instead, and any caller-
    // provided `replayInvalid: true` must survive untouched.

    function makeAttemptParams(overrides: Record<string, unknown> = {}): any {
      return {
        provider: "github-copilot",
        model: { provider: "github-copilot", id: "gpt-4.1" },
        cwd: "/ws",
        workspaceDir: "/ws",
        agentDir: "/home",
        copilotHome: "/copilot-home",
        auth: { useLoggedInUser: true },
        sessionId: "oc-sess-reuse",
        ...overrides,
      };
    }

    it("seeds initialReplayState.sdkSessionId from trackedSessions on the second turn", async () => {
      const pool = makePoolMock();
      const client = { deleteSession: vi.fn() } as any;
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-warm",
          pooledClient: { key: {} as any, client },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(makeAttemptParams({ runId: "t1" }));
      await harness.runAttempt(makeAttemptParams({ runId: "t2" }));

      expect(mocks.runCopilotAttempt).toHaveBeenCalledTimes(2);
      const secondCallParams = mocks.runCopilotAttempt.mock.calls[1]?.[0] as {
        initialReplayState?: { sdkSessionId?: string; replayInvalid?: boolean };
      };
      expect(secondCallParams.initialReplayState?.sdkSessionId).toBe("sdk-sess-warm");
      // Must not synthesize a replayInvalid signal: undefined → resumable.
      expect(secondCallParams.initialReplayState?.replayInvalid).toBeUndefined();
    });

    it("does not seed sdkSessionId on the first turn (nothing tracked yet)", async () => {
      const pool = makePoolMock();
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-cold",
          pooledClient: { key: {} as any, client: {} as any },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(makeAttemptParams({ runId: "t1" }));

      const firstCallParams = mocks.runCopilotAttempt.mock.calls[0]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };
      expect(firstCallParams.initialReplayState?.sdkSessionId).toBeUndefined();
    });

    it("does not seed when compatibility fingerprint differs (model change)", async () => {
      const pool = makePoolMock();
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-gpt4",
          pooledClient: { key: {} as any, client: {} as any },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(
        makeAttemptParams({ runId: "t1", model: { provider: "github-copilot", id: "gpt-4.1" } }),
      );
      await harness.runAttempt(
        makeAttemptParams({
          runId: "t2",
          model: { provider: "github-copilot", id: "claude-sonnet-4.5" },
        }),
      );

      const secondCallParams = mocks.runCopilotAttempt.mock.calls[1]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };
      expect(secondCallParams.initialReplayState?.sdkSessionId).toBeUndefined();
    });

    it("does not seed when compatibility fingerprint differs (legacy auth.gitHubToken rotation)", async () => {
      const pool = makePoolMock();
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-auth1",
          pooledClient: { key: {} as any, client: {} as any },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      // Use the explicit-token auth branch (which carries gitHubToken
      // + profileId + profileVersion through resolveCopilotAuth and
      // surfaces the version into authProfileVersion) so a profile
      // version bump is a real auth rotation, not a no-op fall-through
      // to useLoggedInUser.
      await harness.runAttempt(
        makeAttemptParams({
          runId: "t1",
          auth: { gitHubToken: "tok-1", profileId: "p1", profileVersion: "v1" },
        }),
      );
      await harness.runAttempt(
        makeAttemptParams({
          runId: "t2",
          auth: { gitHubToken: "tok-1", profileId: "p1", profileVersion: "v2" },
        }),
      );

      const secondCallParams = mocks.runCopilotAttempt.mock.calls[1]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };
      expect(secondCallParams.initialReplayState?.sdkSessionId).toBeUndefined();
    });

    it("G3: does not seed when top-level authProfileId rotates (production path)", async () => {
      // The production main path (EmbeddedRunAttemptParams) carries
      // top-level `authProfileId` + `resolvedApiKey`, not the legacy
      // `auth.*` sub-object. computeSessionCompatKey delegates to
      // resolveCopilotAuth so both paths produce the same effective
      // auth identity. Rotating the top-level profile id must
      // invalidate session reuse.
      const pool = makePoolMock();
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-p1",
          pooledClient: { key: {} as any, client: {} as any },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(
        makeAttemptParams({
          runId: "t1",
          auth: undefined,
          authProfileId: "p1",
          resolvedApiKey: "tok-same",
        }),
      );
      await harness.runAttempt(
        makeAttemptParams({
          runId: "t2",
          auth: undefined,
          authProfileId: "p2",
          resolvedApiKey: "tok-same",
        }),
      );

      const secondCallParams = mocks.runCopilotAttempt.mock.calls[1]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };
      expect(secondCallParams.initialReplayState?.sdkSessionId).toBeUndefined();
    });

    it("G3: does not seed when top-level resolvedApiKey rotates (token fingerprint changes)", async () => {
      // Same authProfileId but the resolved token bytes change.
      // resolveCopilotAuth synthesizes authProfileVersion via
      // tokenFingerprint(resolvedApiKey) for the contract path, so
      // rotating the bytes flips the fingerprint and therefore the
      // compat key. Important for cases where an upstream auth
      // store re-issues a token under the same profile id.
      const pool = makePoolMock();
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-tok1",
          pooledClient: { key: {} as any, client: {} as any },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(
        makeAttemptParams({
          runId: "t1",
          auth: undefined,
          authProfileId: "p1",
          resolvedApiKey: "tok-a",
        }),
      );
      await harness.runAttempt(
        makeAttemptParams({
          runId: "t2",
          auth: undefined,
          authProfileId: "p1",
          resolvedApiKey: "tok-b",
        }),
      );

      const secondCallParams = mocks.runCopilotAttempt.mock.calls[1]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };
      expect(secondCallParams.initialReplayState?.sdkSessionId).toBeUndefined();
    });

    it("preserves caller-provided initialReplayState.replayInvalid:true (does not overwrite)", async () => {
      const pool = makePoolMock();
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-tracked",
          pooledClient: { key: {} as any, client: {} as any },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(makeAttemptParams({ runId: "t1" }));
      await harness.runAttempt(
        makeAttemptParams({
          runId: "t2",
          initialReplayState: { replayInvalid: true },
        }),
      );

      const secondCallParams = mocks.runCopilotAttempt.mock.calls[1]?.[0] as {
        initialReplayState?: { sdkSessionId?: string; replayInvalid?: boolean };
      };
      // sdkSessionId is still injected from tracking, but replayInvalid
      // must remain true so replay-shim treats this as create-not-resume.
      expect(secondCallParams.initialReplayState?.sdkSessionId).toBe("sdk-sess-tracked");
      expect(secondCallParams.initialReplayState?.replayInvalid).toBe(true);
    });

    it("updates the tracked session when onSessionEstablished reports a new sdkSessionId", async () => {
      const pool = makePoolMock();
      const deleteSession = vi.fn();
      const client = { deleteSession } as any;
      let nextSdkId = "sdk-sess-1";
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: nextSdkId,
          pooledClient: { key: {} as any, client },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(makeAttemptParams({ runId: "t1" }));
      nextSdkId = "sdk-sess-2"; // Simulate downgraded resume → new SDK session.
      await harness.runAttempt(makeAttemptParams({ runId: "t2" }));
      await harness.reset?.({ sessionId: "oc-sess-reuse" });

      expect(deleteSession).toHaveBeenCalledTimes(1);
      // The newer sdkSessionId must be the one targeted by reset, not
      // the stale first-turn id.
      expect(deleteSession).toHaveBeenCalledWith("sdk-sess-2");
    });
  });

  describe("compact", () => {
    it("returns ok:false when sessionId is missing", async () => {
      const harness = createCopilotAgentHarness({ pool: makePoolMock() });
      const result = await harness.compact?.({ workspaceDir: "/ws" } as any);
      expect(result).toEqual({
        ok: false,
        compacted: false,
        reason: "missing-required-params",
      });
    });

    it("returns ok:false when workspaceDir is missing", async () => {
      const harness = createCopilotAgentHarness({ pool: makePoolMock() });
      const result = await harness.compact?.({ sessionId: "s" } as any);
      expect(result).toEqual({
        ok: false,
        compacted: false,
        reason: "missing-required-params",
      });
    });

    it("writes an OpenClaw marker under <workspaceDir>/files and returns ok:true,compacted:false", async () => {
      const workspaceDir = await mkdtemp(join(tmpdir(), "copilot-harness-compact-"));
      try {
        const harness = createCopilotAgentHarness({ pool: makePoolMock() });
        const result = await harness.compact?.({
          sessionId: "oc-sess-compact-1",
          workspaceDir,
          trigger: "budget",
          currentTokenCount: 12345,
        } as any);

        expect(result).toEqual({
          ok: true,
          compacted: false,
          reason: "deferred-to-sdk-infinite-sessions",
        });

        const files = await readdir(join(workspaceDir, "files"));
        const marker = files.find((f) => f.startsWith("openclaw-compaction-"));
        expect(marker).toBeDefined();
        expect(marker).toMatch(/openclaw-compaction-\d+-oc-sess-compact-1\.json/);
        const contents = JSON.parse(await readFile(join(workspaceDir, "files", marker!), "utf8"));
        expect(contents).toMatchObject({
          version: 1,
          source: "copilot-harness",
          sessionId: "oc-sess-compact-1",
          compacted: false,
          trigger: "budget",
          currentTokenCount: 12345,
          reason: "deferred-to-sdk-infinite-sessions",
        });
      } finally {
        await rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("records the tracked sdkSessionId in the marker when an attempt has run", async () => {
      const workspaceDir = await mkdtemp(join(tmpdir(), "copilot-harness-compact-tracked-"));
      try {
        const pool = makePoolMock();
        mocks.runCopilotAttempt.mockImplementation(async (params, deps) => {
          deps.onSessionEstablished?.({
            sdkSessionId: "sdk-sess-tracked",
            pooledClient: { key: {} as any, client: { deleteSession: vi.fn() } as any },
          });
          return ATTEMPT_RESULT;
        });
        const harness = createCopilotAgentHarness({ pool });

        await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-sess-tracked" });
        await harness.compact?.({
          sessionId: "oc-sess-tracked",
          workspaceDir,
          trigger: "manual",
        } as any);

        const files = await readdir(join(workspaceDir, "files"));
        const marker = files.find((f) => f.startsWith("openclaw-compaction-"))!;
        const contents = JSON.parse(await readFile(join(workspaceDir, "files", marker), "utf8"));
        expect(contents.sdkSessionId).toBe("sdk-sess-tracked");
      } finally {
        await rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("records force:true in the marker and surfaces a force-specific reason", async () => {
      const workspaceDir = await mkdtemp(join(tmpdir(), "copilot-harness-compact-force-"));
      try {
        const harness = createCopilotAgentHarness({ pool: makePoolMock() });
        const result = await harness.compact?.({
          sessionId: "oc-sess-force",
          workspaceDir,
          force: true,
        } as any);

        expect(result).toEqual({
          ok: true,
          compacted: false,
          reason: "force-requested-but-sdk-has-no-synchronous-compact-api",
        });

        const files = await readdir(join(workspaceDir, "files"));
        const marker = files.find((f) => f.startsWith("openclaw-compaction-"))!;
        const contents = JSON.parse(await readFile(join(workspaceDir, "files", marker), "utf8"));
        expect(contents.force).toBe(true);
        expect(contents.reason).toBe("force-requested-but-sdk-has-no-synchronous-compact-api");
      } finally {
        await rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("returns ok:false with structured failure when the marker write throws", async () => {
      const harness = createCopilotAgentHarness({ pool: makePoolMock() });
      // Use a path with a NUL character which Node rejects synchronously
      // on every platform, simulating a write failure that the harness
      // must convert into a structured failure instead of throwing.
      const badWorkspace = "/this\u0000is/illegal";
      const result = await harness.compact?.({
        sessionId: "oc-sess-bad",
        workspaceDir: badWorkspace,
      } as any);

      expect(result?.ok).toBe(false);
      expect(result?.compacted).toBe(false);
      expect(result?.reason).toBe("marker-write-failed");
      expect(result?.failure?.reason).toBe("marker-write-failed");
      expect(typeof result?.failure?.rawError).toBe("string");
      expect(result?.failure?.rawError?.length ?? 0).toBeGreaterThan(0);
    });
  });

  describe("runSideQuestion", () => {
    it("is not implemented; /btw falls through to the in-tree PI fallback path", () => {
      const harness = createCopilotAgentHarness({ pool: makePoolMock() });
      expect(harness.runSideQuestion).toBeUndefined();
    });
  });
});

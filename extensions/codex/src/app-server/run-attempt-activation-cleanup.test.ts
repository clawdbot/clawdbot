// Codex tests cover cleanup after native turn acceptance.
import path from "node:path";
import {
  resolveActiveEmbeddedRunSessionId,
  type EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerInitialize,
  createPairedAttemptRuntime,
  readHarnessMessages,
  waitForRequest,
} from "./attempt-startup.test-support.js";
import { CodexAppServerClient } from "./client.js";
import { turnCompleted } from "./protocol.test-helpers.js";
import {
  createCodexRuntimePlanFixture,
  createParams,
  fastWait,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { testCodexAppServerBindingStore } from "./session-binding.test-helpers.js";
import {
  captureExclusiveSharedCodexAppServerClient,
  resetSharedCodexAppServerClientForTests,
  retainSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import { createClientHarness } from "./test-support.js";
import type { CodexThreadRouteReservation } from "./turn-router.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

function createAttemptParams(sessionKey: string) {
  const fixturePathSegment = sessionKey.replaceAll(":", "-");
  const params = createParams(
    path.join(tempDir, `${fixturePathSegment}.jsonl`),
    path.join(tempDir, `${fixturePathSegment}-workspace`),
    { sessionKey },
  );
  params.disableTools = true;
  params.config = undefined;
  delete params.contextTokenBudget;
  delete params.contextWindowInfo;
  delete params.observeToolTerminal;
  return params;
}

async function requireRequest(harness: ReturnType<typeof createClientHarness>, method: string) {
  const request = await waitForRequest(harness, method);
  if (request.id === undefined) {
    throw new Error(`Codex harness did not write ${method}`);
  }
  return { id: request.id, params: request.params };
}

async function answerTurnStart(
  harness: ReturnType<typeof createClientHarness>,
  beforeAcceptance: () => void = () => undefined,
): Promise<void> {
  const initialize = await requireRequest(harness, "initialize");
  harness.send({
    id: initialize.id,
    result: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)` },
  });
  const threadStart = await requireRequest(harness, "thread/start");
  harness.send({ id: threadStart.id, result: threadStartResult() });
  const turnStart = await requireRequest(harness, "turn/start");
  beforeAcceptance();
  harness.send({ id: turnStart.id, result: turnStartResult() });
}

function requestMethods(harness: ReturnType<typeof createClientHarness>): string[] {
  return readHarnessMessages(harness.writes).flatMap((message) =>
    typeof message.method === "string" ? [message.method] : [],
  );
}

async function installFailingRouteBinding(
  failure: Error,
  beforeFailure: (
    route: CodexThreadRouteReservation,
    turnId: string,
  ) => Promise<void> | void = () => undefined,
) {
  const turnRouterModule = await import("./turn-router.js");
  const readTurnRouter = turnRouterModule.getCodexAppServerTurnRouter;
  return vi.spyOn(turnRouterModule, "getCodexAppServerTurnRouter").mockImplementation((client) => {
    const router = readTurnRouter(client);
    return {
      reserveThread: (options) => {
        const route = router.reserveThread(options);
        return {
          ...route,
          bindTurn: async (turnId) => {
            await beforeFailure(route, turnId);
            throw failure;
          },
        };
      },
      watchNativeTurnCompletion: (options) => router.watchNativeTurnCompletion(options),
    };
  });
}

function configurePairedNodeAttempt(params: EmbeddedRunAttemptParamsV2) {
  const runtimePlan = createCodexRuntimePlanFixture();
  params.runtimePlan = {
    ...runtimePlan,
    auth: {
      ...runtimePlan.auth,
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai",
      selectedAuthMode: "api-key",
      modelRoute: {
        provider: "openai",
        modelId: "gpt-5.4-codex",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authRequirement: "api-key",
        requestTransportOverrides: "none",
      },
    },
  };
  params.resolvedApiKey = "isolated-cleanup-test-key";
  params.sandbox = Object.assign(createSandboxContext({}), {
    backendId: "node",
    backend: undefined,
    fsBridge: undefined,
    runtimeId: `paired-node-${params.runId}`,
    placementExecutionMode: "remote-exec",
    placementNodeId: "paired-device-1",
    placementEnvironmentId: `environment-${params.runId}`,
    placementSessionId: params.sessionId,
    placementOwnerEpoch: 1,
  });
  return createPairedAttemptRuntime();
}

async function answerPairedNodeStartupUntilTurnStart(
  harness: ReturnType<typeof createClientHarness>,
) {
  await answerInitialize(harness);
  const login = await waitForRequest(harness, "account/login/start");
  harness.send({ id: login.id, result: { type: "apiKey" } });
  const environment = await waitForRequest(harness, "environment/add");
  harness.send({ id: environment.id, result: {} });
  const thread = await waitForRequest(harness, "thread/start");
  harness.send({ id: thread.id, result: threadStartResult() });
  return await waitForRequest(harness, "turn/start");
}

setupRunAttemptTestHooks();

describe("Codex accepted-turn cleanup", () => {
  beforeEach(() => {
    resetSharedCodexAppServerClientForTests();
  });

  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
  });

  it("reclaims a route-bind failure after the exact native terminal", async () => {
    const failure = new Error("injected route binding failure");
    let routeSignal: AbortSignal | undefined;
    const getTurnRouter = await installFailingRouteBinding(failure, (route) => {
      routeSignal = route.signal;
    });
    const harness = createClientHarness();
    const startClient = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(harness.client);
    const sessionKey = "agent:main:dashboard:route-failure";
    const params = createAttemptParams(sessionKey);
    const upstreamAbort = new AbortController();
    const addAbortListener = vi.spyOn(upstreamAbort.signal, "addEventListener");
    const removeAbortListener = vi.spyOn(upstreamAbort.signal, "removeEventListener");
    const onAttemptAbort = vi.fn();
    params.abortSignal = upstreamAbort.signal;
    params.onAttemptAbort = onAttemptAbort;
    const observedFailure = runCodexAppServerAttempt(params).then(
      () => undefined,
      (error: unknown) => error,
    );
    let settled = false;
    void observedFailure.then(() => {
      settled = true;
    });

    try {
      await answerTurnStart(harness);
      const interrupt = await requireRequest(harness, "turn/interrupt");
      expect(interrupt.params).toEqual({ threadId: "thread-1", turnId: "turn-1" });
      harness.send({ id: interrupt.id, result: {} });
      harness.send({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-unrelated",
          turn: { id: "turn-unrelated", status: "interrupted" },
        },
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(settled).toBe(false);
      expect(requestMethods(harness)).not.toContain("thread/unsubscribe");
      const pendingProbe = retainSharedCodexAppServerClientIfCurrent(harness.client);
      if (!pendingProbe) {
        throw new Error("expected the accepted turn lease to remain pending");
      }
      expect(() => captureExclusiveSharedCodexAppServerClient(harness.client)).toThrow();
      pendingProbe();

      harness.send({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: { id: "turn-1", status: "interrupted" },
        },
      });
      const unsubscribe = await requireRequest(harness, "thread/unsubscribe");
      harness.send({ id: unsubscribe.id, result: {} });

      await expect(observedFailure).resolves.toBe(failure);
      if (!routeSignal) {
        throw new Error("expected a reserved route signal");
      }
      expect(routeSignal.aborted).toBe(true);
      const routeProbe = (await import("./turn-router.js"))
        .getCodexAppServerTurnRouter(harness.client)
        .reserveThread({ threadId: "thread-1" });
      routeProbe.release();
      expect(resolveActiveEmbeddedRunSessionId(sessionKey)).toBeUndefined();
      const finalProbe = retainSharedCodexAppServerClientIfCurrent(harness.client);
      if (!finalProbe) {
        throw new Error("expected cleanup to preserve the safe shared client");
      }
      const assertExclusive = captureExclusiveSharedCodexAppServerClient(harness.client);
      assertExclusive();
      finalProbe();
      const abortRegistration = addAbortListener.mock.calls.find(([type]) => type === "abort");
      if (!abortRegistration) {
        throw new Error("expected an upstream abort listener registration");
      }
      expect(removeAbortListener).toHaveBeenCalledWith("abort", abortRegistration[1]);
      upstreamAbort.abort("late abort");
      expect(onAttemptAbort).not.toHaveBeenCalled();
      expect(startClient).toHaveBeenCalledOnce();
    } finally {
      addAbortListener.mockRestore();
      removeAbortListener.mockRestore();
      getTurnRouter.mockRestore();
      startClient.mockRestore();
    }
  });

  it("cleans active publication when active-run registration throws", async () => {
    const failure = new Error("injected active-run registration failure");
    const harnessRuntime = await import("openclaw/plugin-sdk/agent-harness-runtime");
    const publishActiveRun = harnessRuntime.setActiveEmbeddedRun;
    const setActiveRun = vi
      .spyOn(harnessRuntime, "setActiveEmbeddedRun")
      .mockImplementation((sessionId, handle, sessionKey, sessionFile) => {
        publishActiveRun(sessionId, handle, sessionKey, sessionFile);
        throw failure;
      });
    const harness = createClientHarness();
    const startClient = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(harness.client);
    const sessionKey = "agent:main:dashboard:reply-publication-failure";
    const params = createAttemptParams(sessionKey);
    const observedFailure = runCodexAppServerAttempt(params).then(
      () => undefined,
      (error: unknown) => error,
    );

    try {
      await answerTurnStart(harness);
      const interrupt = await requireRequest(harness, "turn/interrupt");
      harness.send({ id: interrupt.id, result: {} });
      harness.send(turnCompleted({ id: "turn-1", status: "interrupted" }));
      const unsubscribe = await requireRequest(harness, "thread/unsubscribe");
      harness.send({ id: unsubscribe.id, result: {} });

      await expect(observedFailure).resolves.toBe(failure);
      expect(resolveActiveEmbeddedRunSessionId(sessionKey)).toBeUndefined();
      expect(startClient).toHaveBeenCalledOnce();
    } finally {
      setActiveRun.mockRestore();
      startClient.mockRestore();
    }
  });

  it("checkpoints projected commentary when activation fails after route binding", async () => {
    const failure = new Error("injected post-projection binding failure");
    let routeBoundBeforeFailure = false;
    const getTurnRouter = await installFailingRouteBinding(failure, async (route, turnId) => {
      await route.bindTurn(turnId);
      routeBoundBeforeFailure = true;
    });
    const harness = createClientHarness();
    const startClient = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(harness.client);
    const sessionKey = "agent:main:dashboard:partial-activation";
    const params = createAttemptParams(sessionKey);
    let releaseNotificationTail: () => void = () => undefined;
    const notificationTailGate = new Promise<void>((resolve) => {
      releaseNotificationTail = resolve;
    });
    let notificationTailBlocked = false;
    params.onAssistantMessageStart = async () => {
      notificationTailBlocked = true;
      await notificationTailGate;
    };
    const storePath = path.join(tempDir, "partial-activation-sessions.json");
    params.sessionTarget = {
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey,
      storePath,
    };
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      storePath,
      entry: {
        sessionFile: params.sessionFile,
        sessionId: params.sessionId,
        updatedAt: Date.now(),
      },
    });
    const observedFailure = runCodexAppServerAttempt(params).then(
      () => undefined,
      (error: unknown) => error,
    );

    try {
      const initialize = await requireRequest(harness, "initialize");
      harness.send({
        id: initialize.id,
        result: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)` },
      });
      const threadStart = await requireRequest(harness, "thread/start");
      harness.send({ id: threadStart.id, result: threadStartResult() });
      const turnStart = await requireRequest(harness, "turn/start");
      harness.send({ id: turnStart.id, result: turnStartResult() });
      const interrupt = await requireRequest(harness, "turn/interrupt");
      expect(interrupt.params).toEqual({ threadId: "thread-1", turnId: "turn-1" });
      expect(routeBoundBeforeFailure).toBe(true);
      harness.send({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "partial-activation-commentary",
            phase: "commentary",
            text: "",
          },
        },
      });
      harness.send({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "partial-activation-commentary",
          delta: "Checkpoint this partial activation.",
        },
      });
      await vi.waitFor(() => expect(notificationTailBlocked).toBe(true), fastWait);
      harness.send({ id: interrupt.id, result: {} });
      harness.send({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: { id: "turn-1", status: "interrupted" },
        },
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(requestMethods(harness)).not.toContain("thread/unsubscribe");
      releaseNotificationTail();
      const unsubscribe = await requireRequest(harness, "thread/unsubscribe");
      harness.send({ id: unsubscribe.id, result: {} });

      await expect(observedFailure).resolves.toBe(failure);
      const transcript = await readSessionTranscriptEvents({
        agentId: "main",
        sessionId: params.sessionId,
        sessionKey,
        storePath,
      });
      expect(JSON.stringify(transcript)).toContain("Checkpoint this partial activation.");
      expect(startClient).toHaveBeenCalledOnce();
    } finally {
      releaseNotificationTail();
      getTurnRouter.mockRestore();
      startClient.mockRestore();
    }
  });

  it("detaches the client before later cleanup after interruption is unconfirmed", async () => {
    const failure = new Error("injected route binding failure");
    const getTurnRouter = await installFailingRouteBinding(failure);
    const harness = createClientHarness();
    const startClient = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(harness.client);
    let releaseBindingCleanup: () => void = () => undefined;
    const bindingCleanupGate = new Promise<void>((resolve) => {
      releaseBindingCleanup = resolve;
    });
    let holdBindingCleanup = false;
    let bindingCleanupEntered = false;
    let blockedMutation: Parameters<typeof testCodexAppServerBindingStore.mutate>[1] | undefined;
    const bindingStore: typeof testCodexAppServerBindingStore = {
      ...testCodexAppServerBindingStore,
      mutate: async (identity, mutation, assertCurrent) => {
        if (holdBindingCleanup) {
          bindingCleanupEntered = true;
          blockedMutation = mutation;
          await bindingCleanupGate;
          throw new Error("injected binding cleanup failure");
        }
        return await testCodexAppServerBindingStore.mutate(identity, mutation, assertCurrent);
      },
    };
    const sessionKey = "agent:main:dashboard:incognito-unsafe-activation";
    const params = createAttemptParams(sessionKey);
    const run = runCodexAppServerAttempt(params, { bindingStore });
    const observedFailure = run.then(
      () => undefined,
      (error: unknown) => error,
    );

    try {
      await answerTurnStart(harness, () => {
        holdBindingCleanup = true;
      });
      const interrupt = await requireRequest(harness, "turn/interrupt");
      harness.send({
        id: interrupt.id,
        error: { code: -32_000, message: "injected interrupt failure" },
      });
      await vi.waitFor(() => expect(bindingCleanupEntered).toBe(true), {
        interval: 1,
        timeout: 5_000,
      });

      expect(blockedMutation).toEqual({ kind: "clear", threadId: "thread-1" });
      expect(retainSharedCodexAppServerClientIfCurrent(harness.client)).toBeUndefined();
      expect(requestMethods(harness)).not.toContain("thread/unsubscribe");
      expect(resolveActiveEmbeddedRunSessionId(sessionKey)).toBeUndefined();
      releaseBindingCleanup();

      await expect(observedFailure).resolves.toBe(failure);
      await vi.waitFor(() => expect(harness.stdinDestroyed).toBe(true), {
        interval: 1,
        timeout: 5_000,
      });
      expect(startClient).toHaveBeenCalledOnce();
    } finally {
      releaseBindingCleanup();
      getTurnRouter.mockRestore();
      startClient.mockRestore();
    }
  });

  it("joins an unsafe isolated client exactly once during cleanup", async () => {
    const failure = new Error("isolated route binding failed");
    const getTurnRouter = await installFailingRouteBinding(failure);
    const params = createAttemptParams("agent:main:dashboard:isolated-route-failure");
    const pairedRuntime = configurePairedNodeAttempt(params);
    const harness = createClientHarness();
    const closeAndWait = vi.spyOn(harness.client, "closeAndWait");
    const startClient = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(harness.client);

    try {
      const run = runCodexAppServerAttempt(params, {
        bindingStore: testCodexAppServerBindingStore,
        runtime: pairedRuntime.runtime,
      });
      const turn = await answerPairedNodeStartupUntilTurnStart(harness);
      harness.send({ id: turn.id, result: turnStartResult() });
      const interrupt = await waitForRequest(harness, "turn/interrupt");
      harness.send({
        id: interrupt.id,
        error: { code: -32_000, message: "isolated interrupt failed" },
      });

      await expect(run).rejects.toBe(failure);
      expect(closeAndWait).toHaveBeenCalledOnce();
    } finally {
      getTurnRouter.mockRestore();
      startClient.mockRestore();
    }
  });

  it("joins an indeterminate isolated startup client exactly once", async () => {
    const params = createAttemptParams("agent:main:dashboard:isolated-startup-cancellation");
    params.runId = "run-isolated-startup-cancellation";
    const abort = new AbortController();
    params.abortSignal = abort.signal;
    const pairedRuntime = configurePairedNodeAttempt(params);
    const harness = createClientHarness();
    const closeAndWait = vi.spyOn(harness.client, "closeAndWait");
    const startClient = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(harness.client);

    try {
      const run = runCodexAppServerAttempt(params, {
        bindingStore: testCodexAppServerBindingStore,
        runtime: pairedRuntime.runtime,
      });
      const turn = await answerPairedNodeStartupUntilTurnStart(harness);

      abort.abort("cancelled");
      const interrupt = await waitForRequest(harness, "turn/interrupt");
      harness.send({ id: turn.id, result: turnStartResult() });
      harness.send({
        id: interrupt.id,
        error: { code: -32_000, message: "isolated startup interrupt failed" },
      });

      await expect(run).rejects.toMatchObject({ message: "turn/start aborted" });
      expect(closeAndWait).toHaveBeenCalledOnce();
    } finally {
      startClient.mockRestore();
    }
  });

  it("joins an activated isolated client once when abort interruption is unconfirmed", async () => {
    const params = createAttemptParams("agent:main:dashboard:isolated-activated-cancellation");
    params.runId = "run-isolated-activated-interrupt-failure";
    const abort = new AbortController();
    params.abortSignal = abort.signal;
    const pairedRuntime = configurePairedNodeAttempt(params);
    const harness = createClientHarness();
    const closeAndWait = vi.spyOn(harness.client, "closeAndWait");
    const startClient = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(harness.client);

    try {
      const run = runCodexAppServerAttempt(params, {
        bindingStore: testCodexAppServerBindingStore,
        runtime: pairedRuntime.runtime,
      });
      const turn = await answerPairedNodeStartupUntilTurnStart(harness);
      harness.send({ id: turn.id, result: turnStartResult() });
      await vi.waitFor(
        () =>
          expect(resolveActiveEmbeddedRunSessionId(params.sessionKey ?? params.sessionId)).toBe(
            params.sessionId,
          ),
        fastWait,
      );

      abort.abort("cancelled");
      const interrupt = await waitForRequest(harness, "turn/interrupt");
      harness.send({
        id: interrupt.id,
        error: { code: -32_000, message: "isolated activated interrupt failed" },
      });

      await expect(run).rejects.toThrow(
        "Codex cancellation could not confirm the turn stopped; background terminals may still be running.",
      );
      expect(closeAndWait).toHaveBeenCalledOnce();
    } finally {
      startClient.mockRestore();
    }
  });

  it("preserves activation failure when unsubscribe retirement rejects", async () => {
    const failure = new Error("isolated activation failed before cleanup");
    let routeSignal: AbortSignal | undefined;
    const getTurnRouter = await installFailingRouteBinding(failure, (route) => {
      routeSignal = route.signal;
    });
    const params = createAttemptParams("agent:main:dashboard:isolated-retirement-rejection");
    params.runId = "run-isolated-activation-retirement-rejection";
    const pairedRuntime = configurePairedNodeAttempt(params);
    const harness = createClientHarness();
    const transportExited = new Promise<void>((resolve) => {
      harness.process.once("exit", () => resolve());
    });
    const closeClient = harness.client.close.bind(harness.client);
    let routeReleasedBeforeFallback: boolean | undefined;
    const close = vi.spyOn(harness.client, "close").mockImplementation(() => {
      routeReleasedBeforeFallback ??= routeSignal?.aborted;
      closeClient();
    });
    const closeAndWait = vi
      .spyOn(harness.client, "closeAndWait")
      .mockRejectedValue(new Error("isolated retirement rejected"));
    const startClient = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(harness.client);

    try {
      const run = runCodexAppServerAttempt(params, {
        bindingStore: testCodexAppServerBindingStore,
        runtime: pairedRuntime.runtime,
      });
      const turn = await answerPairedNodeStartupUntilTurnStart(harness);
      harness.send({ id: turn.id, result: turnStartResult() });
      const interrupt = await waitForRequest(harness, "turn/interrupt");
      harness.send({ id: interrupt.id, result: {} });
      harness.send(turnCompleted({ id: "turn-1", status: "interrupted" }));
      const unsubscribe = await waitForRequest(harness, "thread/unsubscribe");
      harness.send({
        id: unsubscribe.id,
        error: { code: -32_000, message: "isolated unsubscribe failed" },
      });

      await expect(run).rejects.toBe(failure);
      expect(closeAndWait).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalled();
      expect(routeReleasedBeforeFallback).toBe(false);
      await transportExited;
      expect(harness.stdinDestroyed).toBe(true);
    } finally {
      getTurnRouter.mockRestore();
      startClient.mockRestore();
    }
  });

  it("joins an isolated client once when a completed turn cannot unsubscribe", async () => {
    const params = createAttemptParams("agent:main:dashboard:isolated-unsubscribe-failure");
    params.runId = "run-isolated-unsubscribe-failure";
    params.cleanupBundleMcpOnRunEnd = true;
    const pairedRuntime = configurePairedNodeAttempt(params);
    const harness = createClientHarness();
    const closeAndWait = vi.spyOn(harness.client, "closeAndWait");
    const startClient = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(harness.client);

    try {
      const run = runCodexAppServerAttempt(params, {
        bindingStore: testCodexAppServerBindingStore,
        runtime: pairedRuntime.runtime,
      });
      const turn = await answerPairedNodeStartupUntilTurnStart(harness);
      harness.send({ id: turn.id, result: turnStartResult() });
      harness.send(turnCompleted({ id: "turn-1", status: "completed" }));
      const unsubscribe = await waitForRequest(harness, "thread/unsubscribe");
      harness.send({
        id: unsubscribe.id,
        error: { code: -32_000, message: "isolated unsubscribe failed" },
      });

      await run;
      expect(closeAndWait).toHaveBeenCalledOnce();
    } finally {
      startClient.mockRestore();
    }
  });
});

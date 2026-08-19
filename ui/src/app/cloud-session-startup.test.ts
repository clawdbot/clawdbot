import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { cloudSessionRecoveryExactStorageKey } from "../lib/sessions/cloud-recovery-storage-key.ts";
import {
  readCloudSessionRecovery,
  type CloudSessionRecovery,
  writeCloudSessionRecovery,
} from "../lib/sessions/cloud-recovery.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import {
  createApplicationCloudStartup,
  type ApplicationCloudStartupStatus,
  type ApplicationCloudStartupRuntime,
} from "./cloud-session-startup.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { createInitialUserMessageHandoff } from "./initial-user-message-handoff.ts";

type CloudStartupInput = Parameters<ApplicationCloudStartupRuntime["start"]>[0];

function placement(state: string, generation: number, updatedAtMs = generation) {
  return {
    state,
    generation,
    createdAtMs: 1,
    updatedAtMs,
    stateChangedAtMs: updatedAtMs,
    ...(state === "active"
      ? {
          environmentId: "environment-1",
          activeOwnerEpoch: 1,
          workerBundleHash: "a".repeat(64),
          workspaceBaseManifestRef: "manifest",
          remoteWorkspaceDir: "/workspace",
        }
      : {}),
  };
}

function harness(
  request: ReturnType<typeof vi.fn>,
  options: {
    loadRuntime?: Parameters<typeof createApplicationCloudStartup>[1];
    recoveryBeforeStartup?: boolean;
  } = {},
) {
  const sessionKey = "agent:cloud:startup";
  const client = {
    request,
    recoveryScope: "principal-a",
    recoveryScopeReady: true,
  };
  const gateway = {
    connection: { gatewayUrl: "ws://gateway.example" },
    snapshot: { phase: "connected", client, hello: {} },
    subscribe: vi.fn(() => () => undefined),
  } as unknown as ApplicationGateway;
  const row = { key: sessionKey, placement: placement("requested", 1) } as GatewaySessionRow;
  const state = { result: { sessions: [row] } as SessionsListResult };
  const sessions = {
    get state() {
      return state;
    },
    refresh: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
  } as unknown as SessionCapability;
  const recovery: CloudSessionRecovery = {
    sessionKey,
    messageId: "message-stable",
    message: "fix the cloud task",
    profileId: "aws",
    agentId: "cloud",
    gatewayUrl: "ws://gateway.example",
    recoveryScope: "principal-a",
    phase: "dispatching",
  };
  if (options.recoveryBeforeStartup) {
    expect(writeCloudSessionRecovery(recovery)).toBe(true);
  }
  const initialUserMessage = createInitialUserMessageHandoff();
  const dependencies = { gateway, sessions, initialUserMessage };
  const startup = createApplicationCloudStartup(dependencies, options.loadRuntime);
  if (!options.recoveryBeforeStartup) {
    expect(writeCloudSessionRecovery(recovery)).toBe(true);
  }
  return {
    startup,
    input: { recovery, persistRecovery: true, recovering: false, createdAt: 1_000 },
    client,
    gateway,
    sessions,
    state,
    initialUserMessage,
    dependencies,
  };
}

async function flush() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

type RuntimeModule = Awaited<
  ReturnType<NonNullable<Parameters<typeof createApplicationCloudStartup>[1]>>
>;

function createFakeRuntime() {
  let status: ApplicationCloudStartupStatus | null = null;
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((listener) => listener());
  const runtime: ApplicationCloudStartupRuntime = {
    get: () => status,
    start: vi.fn((input: CloudStartupInput) => {
      status = {
        sessionKey: input.recovery.sessionKey,
        phase: "pending",
        startedAt: input.createdAt,
      };
      publish();
    }),
    retry: vi.fn(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: vi.fn(),
  };
  return {
    runtime,
    setStatus(next: ApplicationCloudStartupStatus) {
      status = next;
      publish();
    },
  };
}

describe("application cloud startup", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("publishes pending status synchronously and bridges it into the loaded runtime", async () => {
    const moduleLoad = createDeferred<RuntimeModule>();
    const fake = createFakeRuntime();
    const factory = vi.fn(() => fake.runtime);
    const { startup, input } = harness(vi.fn(), {
      loadRuntime: () => moduleLoad.promise,
    });
    const listener = vi.fn();
    startup.subscribe(listener);

    startup.start(input);
    expect(startup.get(input.recovery.sessionKey)?.phase).toBe("pending");
    expect(listener).toHaveBeenCalledOnce();
    moduleLoad.resolve({ default: factory });
    await flush();

    expect(factory).toHaveBeenCalledWith(expect.anything());
    expect(startup.get(input.recovery.sessionKey)?.phase).toBe("pending");
    expect(listener).toHaveBeenCalledTimes(2);
    fake.setStatus({
      sessionKey: input.recovery.sessionKey,
      phase: "sending",
      startedAt: input.createdAt,
    });
    expect(startup.get(input.recovery.sessionKey)?.phase).toBe("sending");
    expect(listener).toHaveBeenCalledTimes(3);
    startup.dispose();
  });

  it("does not install a runtime that finishes loading after disposal", async () => {
    const moduleLoad = createDeferred<RuntimeModule>();
    const fake = createFakeRuntime();
    const factory = vi.fn(() => fake.runtime);
    const { startup, input } = harness(vi.fn(), {
      loadRuntime: () => moduleLoad.promise,
    });
    const listener = vi.fn();
    startup.subscribe(listener);

    startup.start(input);
    expect(listener).toHaveBeenCalledOnce();
    startup.dispose();
    moduleLoad.resolve({ default: factory });
    await flush();

    expect(factory).not.toHaveBeenCalled();
    expect(fake.runtime.start).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledOnce();
    expect(startup.get(input.recovery.sessionKey)).toBeNull();
  });

  it("bounds coalesced starts and fences an older same-session completion", async () => {
    const moduleLoad = createDeferred<RuntimeModule>();
    const fake = createFakeRuntime();
    const loader = vi.fn(() => moduleLoad.promise);
    const { startup, input } = harness(vi.fn(), { loadRuntime: loader });
    const starts: CloudStartupInput[] = [];
    for (let index = 0; index < 32; index += 1) {
      const next = {
        ...input,
        recovery: { ...input.recovery, sessionKey: `agent:cloud:bounded-${index}` },
      };
      starts.push(next);
      startup.start(next);
    }
    const replaced = {
      ...input,
      recovery: { ...input.recovery, sessionKey: "agent:cloud:durable", messageId: "replaced" },
    };
    const replacement = {
      ...input,
      recovery: { ...input.recovery, sessionKey: "agent:cloud:durable", messageId: "replacement" },
    };
    startup.start(replaced);
    startup.start(replacement);

    expect(loader).toHaveBeenCalledOnce();
    expect(startup.get(starts[0]!.recovery.sessionKey)).toBeNull();
    moduleLoad.resolve({ default: () => fake.runtime });
    await flush();

    expect(fake.runtime.start).toHaveBeenCalledTimes(32);
    expect(fake.runtime.start).not.toHaveBeenCalledWith(replaced);
    expect(fake.runtime.start).toHaveBeenCalledWith(replacement);
    startup.dispose();
  });

  it("keeps get and retry inert before any runtime load", async () => {
    const loader = vi.fn<NonNullable<Parameters<typeof createApplicationCloudStartup>[1]>>();
    const { startup, input, gateway } = harness(vi.fn(), { loadRuntime: loader });

    expect(startup.get(input.recovery.sessionKey)).toBeNull();
    startup.retry(input.recovery.sessionKey);
    expect(loader).not.toHaveBeenCalled();
    expect(gateway.subscribe).not.toHaveBeenCalled();
    startup.dispose();
  });

  it("prewarms the runtime on connection even when recovery storage is empty", async () => {
    const request = vi.fn();
    const loader = vi.fn(() => import("./cloud-session-startup.runtime.ts"));
    const { startup } = harness(request, { loadRuntime: loader });
    sessionStorage.clear();

    startup.resumeRecovery();
    await flush();

    expect(loader).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    startup.dispose();
  });

  it("lets Start own recovery when it arrives during connection prewarm", async () => {
    const moduleLoad = createDeferred<RuntimeModule>();
    const fake = createFakeRuntime();
    const factory = vi.fn(() => fake.runtime);
    const loader = vi.fn(() => moduleLoad.promise);
    const { startup, input } = harness(vi.fn(), { loadRuntime: loader });

    startup.resumeRecovery();
    startup.start(input);
    moduleLoad.resolve({ default: factory });
    await flush();

    expect(loader).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(expect.anything());
    expect(fake.runtime.start).toHaveBeenCalledWith(input);
    startup.dispose();
  });

  it("keeps durable recovery available after a background load rejection", async () => {
    const fake = createFakeRuntime();
    const factory = vi.fn(() => fake.runtime);
    const loader = vi
      .fn<NonNullable<Parameters<typeof createApplicationCloudStartup>[1]>>()
      .mockRejectedValueOnce(new Error("cloud startup chunk unavailable"))
      .mockResolvedValueOnce({ default: factory });
    const { startup } = harness(vi.fn(), { loadRuntime: loader });

    startup.resumeRecovery();
    await flush();
    expect(loader).toHaveBeenCalledOnce();

    startup.resumeRecovery();
    await flush();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledOnce();
    startup.dispose();
  });

  it("fresh-imports on Start after a connection prewarm rejection", async () => {
    const fake = createFakeRuntime();
    const factory = vi.fn(() => fake.runtime);
    const loader = vi
      .fn<NonNullable<Parameters<typeof createApplicationCloudStartup>[1]>>()
      .mockRejectedValueOnce(new Error("cloud startup chunk unavailable"))
      .mockResolvedValueOnce({ default: factory });
    const { startup, input } = harness(vi.fn(), { loadRuntime: loader });

    startup.resumeRecovery();
    await flush();
    expect(loader).toHaveBeenCalledOnce();

    startup.start(input);
    await flush();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledWith(expect.anything());
    expect(fake.runtime.start).toHaveBeenCalledWith(input);
    startup.dispose();
  });

  it("surfaces a runtime load failure and fresh-imports on retry", async () => {
    const fake = createFakeRuntime();
    const factory = vi.fn(() => fake.runtime);
    const loader = vi
      .fn<NonNullable<Parameters<typeof createApplicationCloudStartup>[1]>>()
      .mockRejectedValueOnce(new Error("cloud startup chunk unavailable"))
      .mockResolvedValueOnce({ default: factory });
    const { startup, input } = harness(vi.fn(), { loadRuntime: loader });
    const listener = vi.fn();
    startup.subscribe(listener);

    startup.start(input);
    expect(startup.get(input.recovery.sessionKey)?.phase).toBe("pending");
    await flush();
    expect(startup.get(input.recovery.sessionKey)).toMatchObject({
      phase: "failed",
      error: "cloud startup chunk unavailable",
      retryable: true,
    });
    expect(listener).toHaveBeenCalledTimes(2);

    startup.retry(input.recovery.sessionKey);
    await flush();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledWith(expect.anything());
    expect(fake.runtime.start).toHaveBeenCalledWith(input);
    expect(startup.get(input.recovery.sessionKey)?.phase).toBe("pending");
    expect(listener).toHaveBeenCalledTimes(4);
    startup.dispose();
  });

  it("loads and reconciles recovery when resumed on an existing connection", async () => {
    const activePlacement = placement("active", 2);
    const request = vi.fn((method: string) => {
      if (method === "sessions.describe") {
        return Promise.resolve({ session: { placement: activePlacement } });
      }
      if (method === "sessions.send") {
        return Promise.resolve({ messageSeq: 11 });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const loader = vi.fn(() => import("./cloud-session-startup.runtime.ts"));
    const { startup, input } = harness(request, {
      loadRuntime: loader,
      recoveryBeforeStartup: true,
    });
    startup.resumeRecovery();

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "sessions.send",
        expect.objectContaining({ idempotencyKey: input.recovery.messageId }),
      );
    });
    expect(loader).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalledWith("sessions.dispatch", expect.anything());
    startup.dispose();
  });

  it("resumes every persisted session once and clears them independently", async () => {
    const secondSend = createDeferred<{ messageSeq: number }>();
    const activePlacement = placement("active", 2);
    const request = vi.fn((method: string, params?: unknown) => {
      const key = (params as { key?: string } | undefined)?.key;
      if (method === "sessions.describe") {
        return Promise.resolve({ session: { placement: activePlacement } });
      }
      if (method === "sessions.send") {
        return key === "agent:cloud:startup"
          ? Promise.resolve({ messageSeq: 11 })
          : secondSend.promise;
      }
      throw new Error(`unexpected method ${method}`);
    });
    const loader = vi.fn(() => import("./cloud-session-startup.runtime.ts"));
    const { startup, input } = harness(request, {
      loadRuntime: loader,
      recoveryBeforeStartup: true,
    });
    const secondRecovery: CloudSessionRecovery = {
      ...input.recovery,
      sessionKey: "agent:cloud:two",
      messageId: "message-two",
      message: "resume another task",
    };
    expect(writeCloudSessionRecovery(secondRecovery)).toBe(true);

    startup.resumeRecovery();
    await vi.waitFor(() => {
      expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(2);
    });
    expect(
      readCloudSessionRecovery(
        input.recovery.gatewayUrl,
        input.recovery.recoveryScope,
        input.recovery.sessionKey,
      ),
    ).toBeNull();
    expect(
      readCloudSessionRecovery(
        secondRecovery.gatewayUrl,
        secondRecovery.recoveryScope,
        secondRecovery.sessionKey,
      ),
    ).toMatchObject({ phase: "sending", messageId: secondRecovery.messageId });

    secondSend.resolve({ messageSeq: 12 });
    await vi.waitFor(() => {
      expect(
        readCloudSessionRecovery(
          secondRecovery.gatewayUrl,
          secondRecovery.recoveryScope,
          secondRecovery.sessionKey,
        ),
      ).toBeNull();
    });
    const sends = request.mock.calls.filter(([method]) => method === "sessions.send");
    expect(sends.map(([, params]) => (params as { key: string }).key).toSorted()).toEqual([
      input.recovery.sessionKey,
      secondRecovery.sessionKey,
    ]);
    startup.dispose();
  });

  it("derives durable progress from canonical sessions and sends only after active", async () => {
    const dispatch = createDeferred<{ placement: ReturnType<typeof placement> }>();
    const request = vi.fn((method: string, _params?: unknown) => {
      if (method === "sessions.dispatch") {
        return dispatch.promise;
      }
      if (method === "sessions.send") {
        return Promise.resolve({ messageSeq: 7 });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const { startup, input, client, sessions, state, initialUserMessage } = harness(request);
    const published = vi.fn();
    startup.subscribe(published);
    startup.start(input);
    expect(published).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(request.mock.calls.filter(([method]) => method === "sessions.dispatch")).toHaveLength(
        1,
      );
    });
    const publishedBeforePlacementChanges = published.mock.calls.length;

    for (const [phase, generation] of [
      ["requested", 1],
      ["provisioning", 2],
      ["syncing", 3],
      ["starting", 4],
    ] as const) {
      state.result.sessions[0] = {
        ...state.result.sessions[0],
        placement: placement(phase, generation),
      } as GatewaySessionRow;
      expect(startup.get(input.recovery.sessionKey)?.phase).toBe(phase);
      expect(request).not.toHaveBeenCalledWith("sessions.send", expect.anything());
    }
    expect(published).toHaveBeenCalledTimes(publishedBeforePlacementChanges);
    expect(request).not.toHaveBeenCalledWith("sessions.describe", expect.anything());

    dispatch.resolve({ placement: placement("active", 5) });
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("sessions.send", {
        key: input.recovery.sessionKey,
        agentId: input.recovery.agentId,
        message: input.recovery.message,
        attachments: undefined,
        idempotencyKey: input.recovery.messageId,
      });
    });
    expect(startup.get(input.recovery.sessionKey)).toBeNull();
    expect(initialUserMessage.read(input.recovery.sessionKey, client)).toMatchObject({
      pendingRunId: "message-stable",
      message: {
        role: "user",
        __openclaw: { idempotencyKey: "message-stable:user", seq: 7 },
      },
    });
    expect(sessions.refresh).not.toHaveBeenCalled();
    startup.dispose();
  });

  it("advances two sessions in one recovery scope without replacing either owner", async () => {
    const firstDispatch = createDeferred<{ placement: ReturnType<typeof placement> }>();
    const secondDispatch = createDeferred<{ placement: ReturnType<typeof placement> }>();
    const request = vi.fn((method: string, params?: unknown) => {
      const key = (params as { key?: string } | undefined)?.key;
      if (method === "sessions.dispatch") {
        return key === "agent:cloud:startup" ? firstDispatch.promise : secondDispatch.promise;
      }
      if (method === "sessions.send") {
        return Promise.resolve({ messageSeq: key === "agent:cloud:startup" ? 7 : 8 });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const { startup, input, client, initialUserMessage } = harness(request);
    const secondInput = {
      ...input,
      recovery: {
        ...input.recovery,
        sessionKey: "agent:cloud:second",
        messageId: "message-second",
        message: "start the second task",
      },
    };

    startup.start(input);
    startup.start(secondInput);
    await vi.waitFor(() => {
      expect(request.mock.calls.filter(([method]) => method === "sessions.dispatch")).toHaveLength(
        2,
      );
    });
    expect(startup.get(input.recovery.sessionKey)?.phase).toBe("requested");
    expect(startup.get(secondInput.recovery.sessionKey)?.phase).toBe("pending");
    expect(request.mock.calls.filter(([method]) => method === "sessions.delete")).toHaveLength(0);
    expect(request.mock.calls.filter(([method]) => method === "sessions.abort")).toHaveLength(0);
    expect(request.mock.calls.filter(([method]) => method === "environments.destroy")).toHaveLength(
      0,
    );

    firstDispatch.resolve({ placement: placement("active", 2) });
    await vi.waitFor(() => {
      expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(1);
    });
    expect(
      readCloudSessionRecovery(
        "ws://gateway.example",
        "principal-a",
        secondInput.recovery.sessionKey,
      ),
    ).toMatchObject({
      messageId: secondInput.recovery.messageId,
      phase: "dispatching",
    });
    expect(initialUserMessage.read(input.recovery.sessionKey, client)).not.toBeNull();
    expect(startup.get(secondInput.recovery.sessionKey)).not.toBeNull();

    secondDispatch.resolve({ placement: placement("active", 3) });
    await vi.waitFor(() => {
      expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(2);
    });
    const sends = request.mock.calls.filter(([method]) => method === "sessions.send");
    expect(sends.map(([, params]) => (params as { key: string }).key)).toEqual([
      input.recovery.sessionKey,
      secondInput.recovery.sessionKey,
    ]);
    expect(
      readCloudSessionRecovery(
        "ws://gateway.example",
        "principal-a",
        secondInput.recovery.sessionKey,
      ),
    ).toBeNull();
    expect(initialUserMessage.read(secondInput.recovery.sessionKey, client)).not.toBeNull();
    for (const method of ["sessions.delete", "sessions.abort", "environments.destroy"]) {
      expect(request.mock.calls.filter(([candidate]) => candidate === method)).toHaveLength(0);
    }
    startup.dispose();
  });

  it("keeps a definitive dispatch failure visible and refreshes canonical sessions once", async () => {
    const request = vi.fn((method: string) => {
      if (method === "sessions.dispatch") {
        return Promise.reject(
          new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "cloud profile was removed",
            retryable: false,
          }),
        );
      }
      throw new Error(`unexpected method ${method}`);
    });
    const { startup, input, sessions } = harness(request);
    startup.start(input);
    await vi.waitFor(() => {
      expect(startup.get(input.recovery.sessionKey)).toMatchObject({
        phase: "failed",
        error: "cloud profile was removed",
        retryable: false,
      });
    });
    expect(sessions.refresh).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalledWith("sessions.send", expect.anything());
    startup.dispose();
  });

  it("retries incognito startup in memory with the same message identity", async () => {
    let sendAttempt = 0;
    const activePlacement = placement("active", 2);
    const request = vi.fn((method: string, _params?: unknown) => {
      if (method === "sessions.dispatch") {
        return Promise.resolve({ placement: activePlacement });
      }
      if (method === "sessions.describe") {
        return Promise.resolve({ session: { placement: activePlacement } });
      }
      if (method === "sessions.send") {
        sendAttempt += 1;
        return sendAttempt === 1
          ? Promise.reject(new Error("send response lost"))
          : Promise.resolve({ messageSeq: 9 });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const { startup, input } = harness(request);
    sessionStorage.clear();
    startup.start({ ...input, persistRecovery: false });
    await vi.waitFor(() => {
      expect(startup.get(input.recovery.sessionKey)).toMatchObject({
        phase: "failed",
        retryable: true,
      });
    });

    startup.retry(input.recovery.sessionKey);
    await vi.waitFor(() => expect(startup.get(input.recovery.sessionKey)).toBeNull());
    const sends = request.mock.calls.filter(([method]) => method === "sessions.send");
    expect(sends).toHaveLength(2);
    expect(sends.map(([, payload]) => payload)).toEqual([
      expect.objectContaining({ idempotencyKey: input.recovery.messageId }),
      expect.objectContaining({ idempotencyKey: input.recovery.messageId }),
    ]);
    expect(sessionStorage.length).toBe(0);
    startup.dispose();
  });

  it("uses retained recovery identity and refuses retry after gateway identity changes", async () => {
    const activePlacement = placement("active", 2);
    const request = vi.fn((method: string) => {
      if (method === "sessions.dispatch") {
        return Promise.resolve({ placement: activePlacement });
      }
      if (method === "sessions.describe") {
        return Promise.resolve({ session: { placement: activePlacement } });
      }
      if (method === "sessions.send") {
        return Promise.reject(new Error("send response lost"));
      }
      throw new Error(`unexpected method ${method}`);
    });
    const { startup, input, client, gateway } = harness(request);
    startup.start(input);
    await vi.waitFor(() => {
      expect(startup.get(input.recovery.sessionKey)?.phase).toBe("failed");
    });

    const storage = sessionStorage;
    const storageRead = vi.fn(storage.getItem.bind(storage));
    vi.stubGlobal("sessionStorage", {
      getItem: storageRead,
      setItem: storage.setItem.bind(storage),
      removeItem: storage.removeItem.bind(storage),
    });
    startup.retry(input.recovery.sessionKey);
    await vi.waitFor(() => {
      expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(2);
    });
    expect(storageRead).toHaveBeenCalledWith(
      cloudSessionRecoveryExactStorageKey(
        "ws://gateway.example",
        "principal-a",
        input.recovery.sessionKey,
      ),
    );
    expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(2);

    const requestCount = request.mock.calls.length;
    (gateway.connection as { gatewayUrl: string }).gatewayUrl = "ws://other.example";
    startup.retry(input.recovery.sessionKey);
    await flush();
    expect(request).toHaveBeenCalledTimes(requestCount);

    (gateway.connection as { gatewayUrl: string }).gatewayUrl = input.recovery.gatewayUrl;
    client.recoveryScope = "principal-b";
    startup.retry(input.recovery.sessionKey);
    await flush();
    expect(request).toHaveBeenCalledTimes(requestCount);
    startup.dispose();
  });

  it("refreshes after active placement failure without replacing the visible error", async () => {
    const activePlacement = placement("active", 2);
    const request = vi.fn((method: string) => {
      if (method === "sessions.dispatch") {
        return Promise.resolve({ placement: activePlacement });
      }
      if (method === "sessions.send") {
        return Promise.reject(new Error("send response lost"));
      }
      throw new Error(`unexpected method ${method}`);
    });
    const { startup, input, sessions, state } = harness(request);
    state.result.sessions[0] = {
      ...state.result.sessions[0],
      placement: activePlacement,
    } as GatewaySessionRow;
    vi.mocked(sessions.refresh).mockRejectedValueOnce(new Error("refresh unavailable"));

    startup.start(input);
    await vi.waitFor(() => {
      expect(startup.get(input.recovery.sessionKey)).toMatchObject({
        phase: "failed",
        error: "send response lost",
        retryable: true,
      });
    });
    expect(sessions.refresh).toHaveBeenCalledOnce();
    startup.dispose();
  });

  it("does not start a duplicate operation for an equivalent session key", async () => {
    const dispatch = createDeferred<{ placement: ReturnType<typeof placement> }>();
    const request = vi.fn((method: string) => {
      if (method === "sessions.dispatch") {
        return dispatch.promise;
      }
      throw new Error(`unexpected method ${method}`);
    });
    const { startup, input } = harness(request);
    startup.start({
      ...input,
      recovery: { ...input.recovery, sessionKey: "agent:main:main" },
    });
    startup.start({ ...input, recovery: { ...input.recovery, sessionKey: "main" } });
    await vi.waitFor(() => {
      expect(request.mock.calls.filter(([method]) => method === "sessions.dispatch")).toHaveLength(
        1,
      );
    });
    startup.dispose();
  });

  it("replaces a stale persistent operation without letting its settlement clean up", async () => {
    const oldDispatch = createDeferred<{ placement: ReturnType<typeof placement> }>();
    const oldRequest = vi.fn((method: string) => {
      if (method === "sessions.dispatch") {
        return oldDispatch.promise;
      }
      throw new Error(`unexpected old-client method ${method}`);
    });
    const { startup, input, gateway, initialUserMessage } = harness(oldRequest);
    startup.start(input);
    await vi.waitFor(() => {
      expect(oldRequest).toHaveBeenCalledWith("sessions.dispatch", expect.anything());
    });

    const newRequest = vi.fn((method: string) => {
      if (method === "sessions.describe") {
        return Promise.resolve({ session: { placement: placement("active", 3) } });
      }
      if (method === "sessions.send") {
        return Promise.resolve({ messageSeq: 21 });
      }
      throw new Error(`unexpected replacement-client method ${method}`);
    });
    const newClient = {
      request: newRequest,
      recoveryScope: "principal-a",
      recoveryScopeReady: true,
    };
    const nextSnapshot = { ...gateway.snapshot, client: newClient };
    (gateway as unknown as { snapshot: typeof nextSnapshot }).snapshot = nextSnapshot;
    const gatewayListener = vi.mocked(gateway.subscribe).mock.calls[0]?.[0];
    expect(gatewayListener).toBeDefined();
    gatewayListener?.(nextSnapshot as never);

    await vi.waitFor(() => {
      expect(newRequest).toHaveBeenCalledWith(
        "sessions.send",
        expect.objectContaining({ idempotencyKey: input.recovery.messageId }),
      );
    });
    expect(startup.get(input.recovery.sessionKey)).toBeNull();
    expect(initialUserMessage.read(input.recovery.sessionKey, newClient as never)).not.toBeNull();

    oldDispatch.resolve({ placement: placement("active", 2) });
    await flush();
    for (const method of ["sessions.delete", "sessions.abort", "environments.destroy"]) {
      expect(oldRequest.mock.calls.filter(([candidate]) => candidate === method)).toHaveLength(0);
    }
    expect(startup.get(input.recovery.sessionKey)).toBeNull();
    expect(initialUserMessage.read(input.recovery.sessionKey, newClient as never)).not.toBeNull();
    startup.dispose();
  });

  it("reclaims the worker and deletes the session when incognito startup is interrupted", async () => {
    const dispatch = createDeferred<{ placement: ReturnType<typeof placement> }>();
    const request = vi.fn((method: string) => {
      if (method === "sessions.dispatch") {
        return dispatch.promise;
      }
      if (method === "sessions.describe") {
        return Promise.resolve({
          session: { sessionId: "session-cloud-startup", placement: placement("active", 2) },
        });
      }
      if (
        method === "sessions.reclaim" ||
        method === "sessions.patch" ||
        method === "sessions.delete"
      ) {
        return Promise.resolve({ ok: true });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const { startup, input, gateway } = harness(request);
    sessionStorage.clear();
    startup.start({ ...input, persistRecovery: false });
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("sessions.dispatch", expect.anything());
    });

    const nextSnapshot = {
      ...gateway.snapshot,
      client: {
        request: vi.fn(),
        recoveryScope: "principal-a",
        recoveryScopeReady: true,
      },
    };
    (gateway as unknown as { snapshot: typeof nextSnapshot }).snapshot = nextSnapshot;
    vi.mocked(gateway.subscribe).mock.calls[0]?.[0](nextSnapshot as never);
    dispatch.resolve({ placement: placement("active", 2) });

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("sessions.reclaim", {
        key: input.recovery.sessionKey,
        agentId: input.recovery.agentId,
      });
      expect(request).toHaveBeenCalledWith("sessions.patch", {
        key: input.recovery.sessionKey,
        agentId: input.recovery.agentId,
        archived: true,
        expectedSessionId: "session-cloud-startup",
      });
      expect(request).toHaveBeenCalledWith("sessions.delete", {
        key: input.recovery.sessionKey,
        agentId: input.recovery.agentId,
        deleteTranscript: true,
        expectedSessionId: "session-cloud-startup",
        archivedOnly: true,
      });
    });
    expect(request).not.toHaveBeenCalledWith("sessions.abort", expect.anything());
    expect(request).not.toHaveBeenCalledWith("environments.destroy", expect.anything());
    expect(sessionStorage.length).toBe(0);
    startup.dispose();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import {
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

  it("bridges pre-load listeners and resolves start after runtime registration", async () => {
    const moduleLoad = createDeferred<RuntimeModule>();
    const fake = createFakeRuntime();
    const factory = vi.fn(() => fake.runtime);
    const { startup, input } = harness(vi.fn(), {
      loadRuntime: () => moduleLoad.promise,
    });
    const listener = vi.fn();
    startup.subscribe(listener);

    const starting = startup.start(input);
    expect(startup.get(input.recovery.sessionKey)).toBeNull();
    moduleLoad.resolve({ createApplicationCloudStartupRuntime: factory });
    await starting;

    expect(factory).toHaveBeenCalledWith(expect.anything(), {
      reconcileCurrentSnapshot: false,
    });
    expect(startup.get(input.recovery.sessionKey)?.phase).toBe("pending");
    expect(listener).toHaveBeenCalledOnce();
    fake.setStatus({
      sessionKey: input.recovery.sessionKey,
      phase: "sending",
      startedAt: input.createdAt,
    });
    expect(startup.get(input.recovery.sessionKey)?.phase).toBe("sending");
    expect(listener).toHaveBeenCalledTimes(2);
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

    const starting = startup.start(input);
    startup.dispose();
    moduleLoad.resolve({ createApplicationCloudStartupRuntime: factory });
    await starting;

    expect(factory).not.toHaveBeenCalled();
    expect(fake.runtime.start).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(startup.get(input.recovery.sessionKey)).toBeNull();
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

  it("resumes recovery only for the current connected recovery scope", async () => {
    const fake = createFakeRuntime();
    const factory = vi.fn(() => fake.runtime);
    const loader = vi.fn(async () => ({ createApplicationCloudStartupRuntime: factory }));
    const { startup, gateway, client } = harness(vi.fn(), { loadRuntime: loader });
    const snapshot = gateway.snapshot as { phase: string; client: typeof client };

    snapshot.phase = "connecting";
    startup.resumeRecovery();
    client.recoveryScopeReady = false;
    snapshot.phase = "connected";
    startup.resumeRecovery();
    client.recoveryScopeReady = true;
    client.recoveryScope = "principal-b";
    startup.resumeRecovery();
    expect(loader).not.toHaveBeenCalled();

    client.recoveryScope = "principal-a";
    startup.resumeRecovery();
    await flush();
    expect(loader).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(expect.anything(), {
      reconcileCurrentSnapshot: true,
    });
    startup.dispose();
  });

  it("keeps durable recovery available after a background load rejection", async () => {
    const fake = createFakeRuntime();
    const factory = vi.fn(() => fake.runtime);
    const loader = vi
      .fn<NonNullable<Parameters<typeof createApplicationCloudStartup>[1]>>()
      .mockRejectedValueOnce(new Error("cloud startup chunk unavailable"))
      .mockResolvedValueOnce({ createApplicationCloudStartupRuntime: factory });
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

  it("rejects a runtime load and fresh-imports on the next start", async () => {
    const fake = createFakeRuntime();
    const factory = vi.fn(() => fake.runtime);
    const loader = vi
      .fn<NonNullable<Parameters<typeof createApplicationCloudStartup>[1]>>()
      .mockRejectedValueOnce(new Error("cloud startup chunk unavailable"))
      .mockResolvedValueOnce({ createApplicationCloudStartupRuntime: factory });
    const { startup, input } = harness(vi.fn(), { loadRuntime: loader });
    const listener = vi.fn();
    startup.subscribe(listener);

    await expect(startup.start(input)).rejects.toThrow("cloud startup chunk unavailable");
    expect(startup.get(input.recovery.sessionKey)).toBeNull();
    expect(listener).not.toHaveBeenCalled();

    await startup.start(input);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledWith(expect.anything(), {
      reconcileCurrentSnapshot: false,
    });
    expect(fake.runtime.start).toHaveBeenCalledWith(input);
    expect(startup.get(input.recovery.sessionKey)?.phase).toBe("pending");
    expect(listener).toHaveBeenCalledOnce();
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
    await startup.start(input);
    expect(published).toHaveBeenCalledTimes(1);

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
    expect(published).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalledWith("sessions.describe", expect.anything());

    dispatch.resolve({ placement: placement("active", 5) });
    await flush();
    expect(request).toHaveBeenCalledWith("sessions.send", {
      key: input.recovery.sessionKey,
      agentId: input.recovery.agentId,
      message: input.recovery.message,
      attachments: undefined,
      idempotencyKey: input.recovery.messageId,
    });
    expect(startup.get(input.recovery.sessionKey)).toBeNull();
    expect(initialUserMessage.read(input.recovery.sessionKey, client)).toMatchObject({
      role: "user",
      __openclaw: { idempotencyKey: "message-stable:user", seq: 7 },
    });
    expect(sessions.refresh).not.toHaveBeenCalled();
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
    await startup.start(input);
    await flush();
    expect(startup.get(input.recovery.sessionKey)).toMatchObject({
      phase: "failed",
      error: "cloud profile was removed",
      retryable: false,
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
    await startup.start({ ...input, persistRecovery: false });
    await flush();
    expect(startup.get(input.recovery.sessionKey)).toMatchObject({
      phase: "failed",
      retryable: true,
    });

    startup.retry(input.recovery.sessionKey);
    await flush();
    expect(startup.get(input.recovery.sessionKey)).toBeNull();
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
    await startup.start(input);
    await flush();

    const storage = sessionStorage;
    const storageRead = vi.fn(storage.getItem.bind(storage));
    vi.stubGlobal("sessionStorage", {
      getItem: storageRead,
      setItem: storage.setItem.bind(storage),
      removeItem: storage.removeItem.bind(storage),
    });
    startup.retry(input.recovery.sessionKey);
    await flush();
    expect(storageRead).toHaveBeenCalledWith(
      "openclaw.new-session.cloud-recovery.v1:ws://gateway.example:principal-a",
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

    await startup.start(input);
    await flush();
    expect(sessions.refresh).toHaveBeenCalledOnce();
    expect(startup.get(input.recovery.sessionKey)).toMatchObject({
      phase: "failed",
      error: "send response lost",
      retryable: true,
    });
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
    await startup.start({
      ...input,
      recovery: { ...input.recovery, sessionKey: "agent:main:main" },
    });
    await startup.start({ ...input, recovery: { ...input.recovery, sessionKey: "main" } });
    expect(request.mock.calls.filter(([method]) => method === "sessions.dispatch")).toHaveLength(1);
    startup.dispose();
  });
});

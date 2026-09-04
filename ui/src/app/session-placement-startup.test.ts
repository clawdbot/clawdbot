import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { sessionPlacementRecoveryExactStorageKey } from "../lib/sessions/session-placement-recovery-storage-key.ts";
import {
  readSessionPlacementRecovery,
  type SessionPlacementRecovery,
  writeSessionPlacementRecovery,
} from "../lib/sessions/session-placement-recovery.ts";
import { makeChatHost } from "../pages/chat/chat-host.test-support.ts";
import { applyChatPendingInputs } from "../pages/chat/chat-pending-inputs.ts";
import { admitChatSubmission, reduceChatSessionProjection } from "../pages/chat/history-merge.ts";
import {
  createPlacementStartupHarness,
  createStartupPlacement,
  flushStartupMicrotasks,
} from "./session-placement-startup.test-support.ts";
import {
  createApplicationPlacementStartup,
  type ApplicationPlacementStartupStatus,
  type ApplicationPlacementStartupRuntime,
} from "./session-placement-startup.ts";

type PlacementStartupInput = Parameters<ApplicationPlacementStartupRuntime["start"]>[0];

type RuntimeModule = Awaited<
  ReturnType<NonNullable<Parameters<typeof createApplicationPlacementStartup>[1]>>
>;

function createFakeRuntime() {
  let status: ApplicationPlacementStartupStatus | null = null;
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((listener) => listener());
  const runtime: ApplicationPlacementStartupRuntime = {
    get: () => status,
    hasPendingTurn: () => status !== null,
    resumeRecovery: vi.fn(),
    start: vi.fn((input: PlacementStartupInput) => {
      status = {
        sessionKey: input.recovery.sessionKey,
        phase: "pending",
        targetKind: input.recovery.target.kind,
        startedAt: input.createdAt,
      };
      publish();
    }),
    retry: vi.fn(),
    pause: vi.fn(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: vi.fn(),
  };
  return {
    runtime,
    setStatus(next: ApplicationPlacementStartupStatus) {
      status = next;
      publish();
    },
  };
}

describe("application session placement startup", () => {
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
    const { startup, input } = createPlacementStartupHarness(vi.fn(), {
      loadRuntime: () => moduleLoad.promise,
    });
    const listener = vi.fn();
    startup.subscribe(listener);

    startup.start(input);
    expect(startup.get(input.recovery.sessionKey)?.phase).toBe("pending");
    expect(listener).toHaveBeenCalledOnce();
    moduleLoad.resolve({ default: factory });
    await flushStartupMicrotasks();

    expect(factory).toHaveBeenCalledWith(expect.anything());
    expect(startup.get(input.recovery.sessionKey)?.phase).toBe("pending");
    expect(listener).toHaveBeenCalledTimes(2);
    fake.setStatus({
      sessionKey: input.recovery.sessionKey,
      phase: "sending",
      targetKind: input.recovery.target.kind,
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
    const { startup, input } = createPlacementStartupHarness(vi.fn(), {
      loadRuntime: () => moduleLoad.promise,
    });
    const listener = vi.fn();
    startup.subscribe(listener);

    startup.start(input);
    expect(listener).toHaveBeenCalledOnce();
    startup.dispose();
    moduleLoad.resolve({ default: factory });
    await flushStartupMicrotasks();

    expect(factory).not.toHaveBeenCalled();
    expect(fake.runtime.start).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledOnce();
    expect(startup.get(input.recovery.sessionKey)).toBeNull();
  });

  it("bounds coalesced starts and fences an older same-session completion", async () => {
    const moduleLoad = createDeferred<RuntimeModule>();
    const fake = createFakeRuntime();
    const loader = vi.fn(() => moduleLoad.promise);
    const { startup, input } = createPlacementStartupHarness(vi.fn(), { loadRuntime: loader });
    const starts: PlacementStartupInput[] = [];
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
    await flushStartupMicrotasks();

    expect(fake.runtime.start).toHaveBeenCalledTimes(32);
    expect(fake.runtime.start).not.toHaveBeenCalledWith(replaced);
    expect(fake.runtime.start).toHaveBeenCalledWith(replacement);
    startup.dispose();
  });

  it("keeps get and retry inert before any runtime load", async () => {
    const loader = vi.fn<NonNullable<Parameters<typeof createApplicationPlacementStartup>[1]>>();
    const { startup, input, gateway } = createPlacementStartupHarness(vi.fn(), {
      loadRuntime: loader,
    });

    expect(startup.get(input.recovery.sessionKey)).toBeNull();
    startup.retry(input.recovery.sessionKey);
    expect(loader).not.toHaveBeenCalled();
    expect(gateway.subscribe).not.toHaveBeenCalled();
    startup.dispose();
  });

  it("prewarms the runtime on connection even when recovery storage is empty", async () => {
    const request = vi.fn();
    const loader = vi.fn(() => import("./session-placement-startup.runtime.ts"));
    const { startup } = createPlacementStartupHarness(request, { loadRuntime: loader });
    sessionStorage.clear();

    startup.resumeRecovery();
    await flushStartupMicrotasks();

    expect(loader).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    startup.dispose();
  });

  it("lets Start own recovery when it arrives during connection prewarm", async () => {
    const moduleLoad = createDeferred<RuntimeModule>();
    const fake = createFakeRuntime();
    const factory = vi.fn(() => fake.runtime);
    const loader = vi.fn(() => moduleLoad.promise);
    const { startup, input } = createPlacementStartupHarness(vi.fn(), { loadRuntime: loader });

    startup.resumeRecovery();
    startup.start(input);
    moduleLoad.resolve({ default: factory });
    await flushStartupMicrotasks();

    expect(loader).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(expect.anything());
    expect(fake.runtime.start).toHaveBeenCalledWith(input);
    startup.dispose();
  });

  it("keeps durable recovery available after a background load rejection", async () => {
    const fake = createFakeRuntime();
    const factory = vi.fn(() => fake.runtime);
    const loader = vi
      .fn<NonNullable<Parameters<typeof createApplicationPlacementStartup>[1]>>()
      .mockRejectedValueOnce(new Error("cloud startup chunk unavailable"))
      .mockResolvedValueOnce({ default: factory });
    const { startup } = createPlacementStartupHarness(vi.fn(), { loadRuntime: loader });

    startup.resumeRecovery();
    await flushStartupMicrotasks();
    expect(loader).toHaveBeenCalledOnce();

    startup.resumeRecovery();
    await flushStartupMicrotasks();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledOnce();
    startup.dispose();
  });

  it("fresh-imports on Start after a connection prewarm rejection", async () => {
    const fake = createFakeRuntime();
    const factory = vi.fn(() => fake.runtime);
    const loader = vi
      .fn<NonNullable<Parameters<typeof createApplicationPlacementStartup>[1]>>()
      .mockRejectedValueOnce(new Error("cloud startup chunk unavailable"))
      .mockResolvedValueOnce({ default: factory });
    const { startup, input } = createPlacementStartupHarness(vi.fn(), { loadRuntime: loader });

    startup.resumeRecovery();
    await flushStartupMicrotasks();
    expect(loader).toHaveBeenCalledOnce();

    startup.start(input);
    await flushStartupMicrotasks();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledWith(expect.anything());
    expect(fake.runtime.start).toHaveBeenCalledWith(input);
    startup.dispose();
  });

  it("surfaces a runtime load failure and fresh-imports on retry", async () => {
    const fake = createFakeRuntime();
    const factory = vi.fn(() => fake.runtime);
    const loader = vi
      .fn<NonNullable<Parameters<typeof createApplicationPlacementStartup>[1]>>()
      .mockRejectedValueOnce(new Error("cloud startup chunk unavailable"))
      .mockResolvedValueOnce({ default: factory });
    const { startup, input } = createPlacementStartupHarness(vi.fn(), { loadRuntime: loader });
    const listener = vi.fn();
    startup.subscribe(listener);

    startup.start(input);
    expect(startup.get(input.recovery.sessionKey)?.phase).toBe("pending");
    await flushStartupMicrotasks();
    expect(startup.get(input.recovery.sessionKey)).toMatchObject({
      phase: "failed",
      error: "cloud startup chunk unavailable",
      retryable: true,
    });
    expect(listener).toHaveBeenCalledTimes(2);

    startup.retry(input.recovery.sessionKey);
    await flushStartupMicrotasks();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledWith(expect.anything());
    expect(fake.runtime.start).toHaveBeenCalledWith(input);
    expect(startup.get(input.recovery.sessionKey)?.phase).toBe("pending");
    expect(listener).toHaveBeenCalledTimes(4);
    startup.dispose();
  });

  it("loads and reconciles recovery when resumed on an existing connection", async () => {
    const activePlacement = createStartupPlacement("active", 2);
    const request = vi.fn((method: string) => {
      if (method === "sessions.describe") {
        return Promise.resolve({ session: { placement: activePlacement } });
      }
      if (method === "sessions.send") {
        return Promise.resolve({ messageSeq: 11 });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const loader = vi.fn(() => import("./session-placement-startup.runtime.ts"));
    const { startup, input } = createPlacementStartupHarness(request, {
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
    const activePlacement = createStartupPlacement("active", 2);
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
    const loader = vi.fn(() => import("./session-placement-startup.runtime.ts"));
    const { startup, input } = createPlacementStartupHarness(request, {
      loadRuntime: loader,
      recoveryBeforeStartup: true,
    });
    const secondRecovery: SessionPlacementRecovery = {
      ...input.recovery,
      sessionKey: "agent:cloud:two",
      messageId: "message-two",
      message: "resume another task",
    };
    expect(writeSessionPlacementRecovery(secondRecovery)).toBe(true);

    startup.resumeRecovery();
    await vi.waitFor(() => {
      expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(2);
    });
    expect(
      readSessionPlacementRecovery(
        input.recovery.gatewayUrl,
        input.recovery.recoveryScope,
        input.recovery.sessionKey,
      ),
    ).toBeNull();
    expect(
      readSessionPlacementRecovery(
        secondRecovery.gatewayUrl,
        secondRecovery.recoveryScope,
        secondRecovery.sessionKey,
      ),
    ).toMatchObject({ phase: "sending", messageId: secondRecovery.messageId });

    secondSend.resolve({ messageSeq: 12 });
    await vi.waitFor(() => {
      expect(
        readSessionPlacementRecovery(
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

  it.each([
    { kind: "profile", profileId: "test-cloud" },
    { kind: "device", deviceId: "test-device" },
    { kind: "auto-device" },
  ] as const)(
    "retains $kind targeting through lazy and loaded progress, sending only after active",
    async (target) => {
      const dispatch = createDeferred<{ placement: ReturnType<typeof createStartupPlacement> }>();
      const request = vi.fn((method: string, _params?: unknown) => {
        if (method === "sessions.dispatch") {
          return dispatch.promise;
        }
        if (method === "sessions.send") {
          return Promise.resolve({ messageSeq: 7 });
        }
        throw new Error(`unexpected method ${method}`);
      });
      const { startup, input, client, sessions, state, chatSubmissions } =
        createPlacementStartupHarness(request);
      input.recovery = { ...input.recovery, target };
      const published = vi.fn();
      startup.subscribe(published);
      startup.start(input);
      expect(startup.get(input.recovery.sessionKey)).toMatchObject({
        phase: "pending",
        targetKind: target.kind,
      });
      expect(published).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(
          request.mock.calls.filter(([method]) => method === "sessions.dispatch"),
        ).toHaveLength(1);
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
          placement: createStartupPlacement(phase, generation),
        } as GatewaySessionRow;
        expect(startup.get(input.recovery.sessionKey)).toMatchObject({
          phase,
          targetKind: target.kind,
        });
        expect(request).not.toHaveBeenCalledWith("sessions.send", expect.anything());
      }
      expect(published).toHaveBeenCalledTimes(publishedBeforePlacementChanges);
      expect(request).not.toHaveBeenCalledWith("sessions.describe", expect.anything());

      dispatch.resolve({ placement: createStartupPlacement("active", 5) });
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
      expect(chatSubmissions.readInitial(input.recovery.sessionKey, client)).toMatchObject({
        pendingRunId: "message-stable",
        message: {
          role: "user",
          __openclaw: { idempotencyKey: "message-stable:user" },
        },
      });
      const handoff = chatSubmissions.readInitial(input.recovery.sessionKey, client)!;
      expect(handoff.message["__openclaw"]).not.toHaveProperty("seq");
      const pane = makeChatHost({
        sessionKey: input.recovery.sessionKey,
        chatSubmissions,
        client: client as never,
      });
      admitChatSubmission(pane);
      expect(pane.chatMessages).toHaveLength(1);
      applyChatPendingInputs(pane, {
        total: 1,
        items: [
          {
            id: "remote-custody",
            runId: input.recovery.messageId,
            acceptedAt: 1000,
            state: "queued",
            message: handoff.message,
          },
        ],
      });
      expect(pane.chatMessages).toEqual([]);
      reduceChatSessionProjection(
        pane,
        { type: "snapshotLoaded", messages: [] },
        { runActive: true },
      );
      expect(admitChatSubmission(pane)).toBe(false);
      expect(pane.chatMessages).toEqual([]);
      expect(sessions.refresh).not.toHaveBeenCalled();
      startup.dispose();
    },
  );

  it("advances two sessions in one recovery scope without replacing either owner", async () => {
    const firstDispatch = createDeferred<{
      placement: ReturnType<typeof createStartupPlacement>;
    }>();
    const secondDispatch = createDeferred<{
      placement: ReturnType<typeof createStartupPlacement>;
    }>();
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
    const { startup, input, client, chatSubmissions } = createPlacementStartupHarness(request);
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

    firstDispatch.resolve({ placement: createStartupPlacement("active", 2) });
    await vi.waitFor(() => {
      expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(1);
    });
    expect(
      readSessionPlacementRecovery(
        "ws://gateway.example",
        "principal-a",
        secondInput.recovery.sessionKey,
      ),
    ).toMatchObject({
      messageId: secondInput.recovery.messageId,
      phase: "dispatching",
    });
    expect(chatSubmissions.readInitial(input.recovery.sessionKey, client)).not.toBeNull();
    expect(startup.get(secondInput.recovery.sessionKey)).not.toBeNull();

    secondDispatch.resolve({ placement: createStartupPlacement("active", 3) });
    await vi.waitFor(() => {
      expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(2);
    });
    const sends = request.mock.calls.filter(([method]) => method === "sessions.send");
    expect(sends.map(([, params]) => (params as { key: string }).key)).toEqual([
      input.recovery.sessionKey,
      secondInput.recovery.sessionKey,
    ]);
    expect(
      readSessionPlacementRecovery(
        "ws://gateway.example",
        "principal-a",
        secondInput.recovery.sessionKey,
      ),
    ).toBeNull();
    expect(chatSubmissions.readInitial(secondInput.recovery.sessionKey, client)).not.toBeNull();
    for (const method of ["sessions.delete", "sessions.abort", "environments.destroy"]) {
      expect(request.mock.calls.filter(([candidate]) => candidate === method)).toHaveLength(0);
    }
    startup.dispose();
  });

  it.each([
    {
      target: { kind: "profile", profileId: "aws", machineClass: "fast" } as const,
      message: "retain this submission",
      wire: { profileId: "aws", machineClass: "fast" },
    },
    {
      target: { kind: "device", deviceId: "device-1" } as const,
      message: "retain this submission",
      wire: { deviceId: "device-1" },
    },
    { target: { kind: "auto-device" } as const, message: "", wire: { autoDevice: true } },
  ])(
    "retains a rejected $target.kind submission across reload until explicit retry",
    async ({ target, message, wire }) => {
      const retryDispatch = createDeferred<{
        placement: ReturnType<typeof createStartupPlacement>;
      }>();
      let dispatches = 0;
      const request = vi.fn((method: string) => {
        if (method === "sessions.dispatch") {
          if (++dispatches > 1) {
            return retryDispatch.promise;
          }
          return Promise.reject(
            new GatewayRequestError({
              code: "INVALID_REQUEST",
              message: "cloud profile was removed",
              retryable: false,
            }),
          );
        }
        if (method === "sessions.send") {
          return Promise.resolve({ messageSeq: 19 });
        }
        throw new Error(`unexpected method ${method}`);
      });
      const { startup, input, sessions, dependencies, chatSubmissions, client } =
        createPlacementStartupHarness(request);
      const attachments = [
        { type: "file", mimeType: "text/plain", fileName: "note.txt", content: "SGk=" },
      ];
      input.recovery = { ...input.recovery, target, message, attachments };
      expect(writeSessionPlacementRecovery(input.recovery)).toBe(true);
      startup.start(input);
      await vi.waitFor(() => {
        expect(startup.get(input.recovery.sessionKey)).toMatchObject({
          phase: "failed",
          targetKind: target.kind,
          error: "cloud profile was removed",
          retryable: true,
          initialTurn: {
            text: message,
            attachments: [{ fileName: "note.txt", dataUrl: "data:text/plain;base64,SGk=" }],
          },
        });
      });
      expect(
        readSessionPlacementRecovery(
          input.recovery.gatewayUrl,
          input.recovery.recoveryScope,
          input.recovery.sessionKey,
        ),
      ).toMatchObject({
        phase: "paused",
        message,
        attachments,
        target,
        messageId: input.recovery.messageId,
      });
      expect(sessions.refresh).toHaveBeenCalledOnce();
      expect(request).not.toHaveBeenCalledWith("sessions.send", expect.anything());
      startup.dispose();
      const reloaded = createApplicationPlacementStartup(dependencies);
      reloaded.resumeRecovery();
      await vi.waitFor(() =>
        expect(reloaded.get(input.recovery.sessionKey)).toMatchObject({
          phase: "failed",
          targetKind: target.kind,
          error: "cloud profile was removed",
        }),
      );
      expect(request).toHaveBeenCalledTimes(1);
      reloaded.retry(input.recovery.sessionKey);
      reloaded.retry(input.recovery.sessionKey);
      await vi.waitFor(() => expect(dispatches).toBe(2));
      expect(request).toHaveBeenLastCalledWith("sessions.dispatch", {
        key: input.recovery.sessionKey,
        agentId: input.recovery.agentId,
        ...wire,
      });
      expect(request).not.toHaveBeenCalledWith("sessions.send", expect.anything());
      retryDispatch.resolve({ placement: createStartupPlacement("active", 2) });
      await vi.waitFor(() => expect(reloaded.get(input.recovery.sessionKey)).toBeNull());
      expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(1);
      expect(request).toHaveBeenLastCalledWith("sessions.send", {
        key: input.recovery.sessionKey,
        agentId: input.recovery.agentId,
        message,
        attachments,
        idempotencyKey: input.recovery.messageId,
      });
      expect(chatSubmissions.readInitial(input.recovery.sessionKey, client)).not.toBeNull();
      expect(
        readSessionPlacementRecovery(
          input.recovery.gatewayUrl,
          input.recovery.recoveryScope,
          input.recovery.sessionKey,
        ),
      ).toBeNull();
      reloaded.dispose();
    },
  );

  it("checks incognito delivery in memory with the same message identity", async () => {
    const activePlacement = createStartupPlacement("active", 2);
    const request = vi.fn((method: string, _params?: unknown) => {
      if (method === "sessions.dispatch") {
        return Promise.resolve({ placement: activePlacement });
      }
      if (method === "sessions.describe") {
        return Promise.resolve({ session: { placement: activePlacement } });
      }
      if (method === "sessions.send") {
        return Promise.reject(new Error("send response lost"));
      }
      if (method === "chat.history") {
        return Promise.resolve({
          messages: [{ role: "user", __openclaw: { idempotencyKey: "message-stable:user" } }],
        });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const { startup, input } = createPlacementStartupHarness(request);
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
    expect(sends).toHaveLength(1);
    expect(sends.map(([, payload]) => payload)).toEqual([
      expect.objectContaining({ idempotencyKey: input.recovery.messageId }),
    ]);
    expect(sessionStorage.length).toBe(0);
    startup.dispose();
  });

  it("uses retained recovery identity and refuses retry after gateway identity changes", async () => {
    const activePlacement = createStartupPlacement("active", 2);
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
      if (method === "chat.history") {
        return Promise.resolve({ messages: [] });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const { startup, input, client, gateway } = createPlacementStartupHarness(request);
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
      expect(request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(1);
    });
    expect(storageRead).toHaveBeenCalledWith(
      sessionPlacementRecoveryExactStorageKey(
        "ws://gateway.example",
        "principal-a",
        input.recovery.sessionKey,
      ),
    );
    expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(1);

    const requestCount = request.mock.calls.length;
    (gateway.connection as { gatewayUrl: string }).gatewayUrl = "ws://other.example";
    expect(startup.get(input.recovery.sessionKey)).toBeNull();
    startup.retry(input.recovery.sessionKey);
    await flushStartupMicrotasks();
    expect(request).toHaveBeenCalledTimes(requestCount);

    (gateway.connection as { gatewayUrl: string }).gatewayUrl = input.recovery.gatewayUrl;
    client.recoveryScope = "principal-b";
    expect(startup.get(input.recovery.sessionKey)).toBeNull();
    startup.retry(input.recovery.sessionKey);
    await flushStartupMicrotasks();
    expect(request).toHaveBeenCalledTimes(requestCount);
    startup.dispose();
  });

  it("refreshes after active placement failure without replacing the visible error", async () => {
    const activePlacement = createStartupPlacement("active", 2);
    const request = vi.fn((method: string) => {
      if (method === "sessions.dispatch") {
        return Promise.resolve({ placement: activePlacement });
      }
      if (method === "sessions.send") {
        return Promise.reject(new Error("send response lost"));
      }
      throw new Error(`unexpected method ${method}`);
    });
    const { startup, input, sessions, state } = createPlacementStartupHarness(request);
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
    const dispatch = createDeferred<{ placement: ReturnType<typeof createStartupPlacement> }>();
    const request = vi.fn((method: string) => {
      if (method === "sessions.dispatch") {
        return dispatch.promise;
      }
      throw new Error(`unexpected method ${method}`);
    });
    const { startup, input } = createPlacementStartupHarness(request);
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
    const oldDispatch = createDeferred<{ placement: ReturnType<typeof createStartupPlacement> }>();
    const oldRequest = vi.fn((method: string) => {
      if (method === "sessions.dispatch") {
        return oldDispatch.promise;
      }
      throw new Error(`unexpected old-client method ${method}`);
    });
    const { startup, input, gateway, chatSubmissions } = createPlacementStartupHarness(oldRequest);
    startup.start(input);
    await vi.waitFor(() => {
      expect(oldRequest).toHaveBeenCalledWith("sessions.dispatch", expect.anything());
    });

    const newRequest = vi.fn((method: string) => {
      if (method === "sessions.describe") {
        return Promise.resolve({ session: { placement: createStartupPlacement("active", 3) } });
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
    expect(
      chatSubmissions.readInitial(input.recovery.sessionKey, newClient as never),
    ).not.toBeNull();

    oldDispatch.resolve({ placement: createStartupPlacement("active", 2) });
    await flushStartupMicrotasks();
    for (const method of ["sessions.delete", "sessions.abort", "environments.destroy"]) {
      expect(oldRequest.mock.calls.filter(([candidate]) => candidate === method)).toHaveLength(0);
    }
    expect(startup.get(input.recovery.sessionKey)).toBeNull();
    expect(
      chatSubmissions.readInitial(input.recovery.sessionKey, newClient as never),
    ).not.toBeNull();
    startup.dispose();
  });

  it("reclaims the worker and deletes the session when incognito startup is interrupted", async () => {
    const dispatch = createDeferred<{ placement: ReturnType<typeof createStartupPlacement> }>();
    const request = vi.fn((method: string) => {
      if (method === "sessions.dispatch") {
        return dispatch.promise;
      }
      if (method === "sessions.describe") {
        return Promise.resolve({
          session: {
            sessionId: "session-cloud-startup",
            placement: createStartupPlacement("active", 2),
          },
        });
      }
      if (method === "sessions.delete") {
        return Promise.resolve({ ok: true, deleted: true });
      }
      if (method === "sessions.reclaim" || method === "sessions.patch") {
        return Promise.resolve({ ok: true });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const { startup, input, gateway } = createPlacementStartupHarness(request);
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
    dispatch.resolve({ placement: createStartupPlacement("active", 2) });

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
      expect(startup.hasPendingTurn(input.recovery.sessionKey)).toBe(false);
    });
    expect(startup.get(input.recovery.sessionKey)).toBeNull();
    expect(request).not.toHaveBeenCalledWith(
      "sessions.patch",
      expect.objectContaining({ archived: false }),
    );
    expect(request).not.toHaveBeenCalledWith("sessions.abort", expect.anything());
    expect(request).not.toHaveBeenCalledWith("environments.destroy", expect.anything());
    expect(sessionStorage.length).toBe(0);
    startup.dispose();
  });
});

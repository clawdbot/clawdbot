// Whatsapp tests cover connection controller plugin behavior.
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DisconnectReason } from "baileys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeWaSocket,
  waitForWhatsAppLoginResult,
  WhatsAppConnectionController,
} from "./connection-controller.js";
import { enqueueCredsSave, writeCredsJsonAtomically } from "./creds-persistence.js";
import { createAcceptedWhatsAppSendResult } from "./inbound/send-result.test-helper.js";
import {
  createWaSocket,
  logoutWeb,
  readWebAuthExistsForDecision,
  waitForCredsSaveQueueWithTimeout,
  waitForWaConnection,
} from "./session.js";
import { DEFAULT_WHATSAPP_SOCKET_TIMING } from "./socket-timing.js";

vi.mock("./session.js", async () => {
  const actual = await vi.importActual<typeof import("./session.js")>("./session.js");
  return {
    ...actual,
    createWaSocket: vi.fn(),
    waitForWaConnection: vi.fn(),
    logoutWeb: vi.fn(async () => true),
    readWebAuthExistsForDecision: vi.fn(async () => ({ outcome: "stable" as const, exists: true })),
    waitForCredsSaveQueueWithTimeout: vi.fn(async () => "drained" as const),
  };
});

const runtimeContextMocks = vi.hoisted(() => ({
  channelRuntime: { runtimeContexts: {} },
  register: vi.fn(),
}));

const connectionOwnerMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-runtime-context", () => {
  return {
    getChannelRuntimeContext: vi.fn(),
    registerChannelRuntimeContext: runtimeContextMocks.register,
  };
});

vi.mock("./runtime.js", () => ({
  getWhatsAppRuntime: () => ({ channel: runtimeContextMocks.channelRuntime }),
}));

vi.mock("./connection-owner.js", () => ({
  acquireWhatsAppGatewayConnectionOwner: connectionOwnerMocks.acquire,
}));

const createWaSocketMock = vi.mocked(createWaSocket);
const waitForWaConnectionMock = vi.mocked(waitForWaConnection);
const logoutWebMock = vi.mocked(logoutWeb);
const readWebAuthExistsForDecisionMock = vi.mocked(readWebAuthExistsForDecision);
const waitForCredsSaveQueueWithTimeoutMock = vi.mocked(waitForCredsSaveQueueWithTimeout);
const registerChannelRuntimeContextMock = runtimeContextMocks.register;

function createListenerStub(messageId = "ok") {
  return {
    sendMessage: vi.fn(async () => createAcceptedWhatsAppSendResult("text", messageId)),
    sendPoll: vi.fn(async () => createAcceptedWhatsAppSendResult("poll", messageId)),
    sendReaction: vi.fn(async () => createAcceptedWhatsAppSendResult("reaction", messageId)),
    sendComposingTo: vi.fn(async () => {}),
  };
}

function createSocketWithTransportEmitter() {
  let closed = false;
  const ws = new EventEmitter() as EventEmitter & {
    close: ReturnType<typeof vi.fn>;
    readonly isClosed: boolean;
  };
  Object.defineProperty(ws, "isClosed", { get: () => closed });
  ws.close = vi.fn(async () => {
    closed = true;
  });
  return {
    end: vi.fn(async (_error?: Error) => {
      closed = true;
    }),
    ws,
  };
}

const loginAuthDir = "/tmp/wa-auth";

function loggedOutError() {
  return { output: { statusCode: DisconnectReason.loggedOut } };
}

function createLoginResultHarness() {
  const initialSock = createSocketWithTransportEmitter();
  const replacementSock = createSocketWithTransportEmitter();
  const runtime = { log: vi.fn() } as never;

  return {
    initialSock,
    replacementSock,
    runtime,
    run: (opts: {
      waitForConnection: ReturnType<typeof vi.fn>;
      createSocket: ReturnType<typeof vi.fn>;
      verbose?: boolean;
      socketTiming?: {
        connectTimeoutMs: number;
        defaultQueryTimeoutMs: number;
        keepAliveIntervalMs: number;
      };
      onQr?: (qr: string) => void;
      onSocketReplaced?: (sock: unknown) => void;
    }) =>
      waitForWhatsAppLoginResult({
        sock: initialSock as never,
        authDir: loginAuthDir,
        isLegacyAuthDir: false,
        verbose: opts.verbose ?? false,
        runtime,
        waitForConnection: opts.waitForConnection as never,
        createSocket: opts.createSocket as never,
        ...(opts.socketTiming ? { socketTiming: opts.socketTiming } : {}),
        ...(opts.onQr ? { onQr: opts.onQr } : {}),
        ...(opts.onSocketReplaced ? { onSocketReplaced: opts.onSocketReplaced } : {}),
      }),
  };
}

async function runLoggedOutRecovery(opts: {
  cleanupCleared?: boolean;
  authDecisions?: Array<{ outcome: "stable"; exists: boolean }>;
  secondWait?: "resolve" | "logged-out";
}) {
  if (opts.cleanupCleared === false) {
    logoutWebMock.mockResolvedValueOnce(false);
  }
  for (const decision of opts.authDecisions ?? []) {
    readWebAuthExistsForDecisionMock.mockResolvedValueOnce(decision);
  }
  const harness = createLoginResultHarness();
  const error = loggedOutError();
  const waitForConnection = vi.fn().mockRejectedValueOnce(error);
  if (opts.secondWait === "resolve") {
    waitForConnection.mockResolvedValueOnce(undefined);
  } else if (opts.secondWait === "logged-out") {
    waitForConnection.mockRejectedValueOnce(error);
  }
  const createSocket = vi.fn(async () => harness.replacementSock);
  const result = await harness.run({ waitForConnection, createSocket });
  return { createSocket, error, harness, result, waitForConnection };
}

describe("WhatsAppConnectionController", () => {
  let controller: WhatsAppConnectionController;

  beforeEach(() => {
    vi.clearAllMocks();
    registerChannelRuntimeContextMock.mockReturnValue({ dispose: vi.fn() });
    connectionOwnerMocks.acquire.mockResolvedValue({ release: connectionOwnerMocks.release });
    connectionOwnerMocks.release.mockResolvedValue(undefined);
    logoutWebMock.mockResolvedValue(true);
    readWebAuthExistsForDecisionMock
      .mockReset()
      .mockResolvedValue({ outcome: "stable", exists: true });
    waitForCredsSaveQueueWithTimeoutMock.mockReset().mockResolvedValue("drained");
    controller = new WhatsAppConnectionController({
      accountId: "work",
      authDir: "/tmp/wa-auth",
      verbose: false,
      keepAlive: false,
      heartbeatSeconds: 30,
      transportTimeoutMs: 60_000,
      messageTimeoutMs: 60_000,
      watchdogCheckMs: 5_000,
      reconnectPolicy: {
        initialMs: 250,
        maxMs: 1_000,
        factor: 2,
        jitter: 0,
        maxAttempts: 5,
      },
    });
  });

  afterEach(async () => {
    await controller.shutdown();
  });

  it("closes the socket when open fails before listener creation", async () => {
    const sock = createSocketWithTransportEmitter();
    const createListener = vi.fn();

    createWaSocketMock.mockResolvedValueOnce(sock as never);
    waitForWaConnectionMock.mockRejectedValueOnce(new Error("handshake failed"));

    await expect(
      controller.openConnection({
        connectionId: "conn-1",
        createListener,
      }),
    ).rejects.toThrow("handshake failed");

    expect(createListener).not.toHaveBeenCalled();
    expect(sock.end).toHaveBeenCalledOnce();
    const closeError = sock.end.mock.calls[0]?.[0] as Error | undefined;
    expect(closeError).toBeInstanceOf(Error);
    expect(closeError?.message).toBe("OpenClaw WhatsApp socket close");
    expect(sock.ws.close).not.toHaveBeenCalled();
    expect(controller.socketRef.current).toBeNull();
    expect(controller.getActiveListener()).toBeNull();
  });

  it("falls back to raw websocket close when Baileys end is unavailable", () => {
    const sock = { ws: { close: vi.fn() } };

    closeWaSocket(sock);

    expect(sock.ws.close).toHaveBeenCalledOnce();
  });

  it("keeps asynchronous fallback close failures best-effort", async () => {
    const sock = {
      end: vi.fn().mockRejectedValue(new Error("end failed")),
      ws: { close: vi.fn(() => Promise.reject(new Error("websocket close failed"))) },
    };

    closeWaSocket(sock);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(sock.end).toHaveBeenCalledOnce();
    expect(sock.ws.close).toHaveBeenCalledOnce();
  });

  it("lets createWaSocket own the auth barrier before opening a socket", async () => {
    const callOrder: string[] = [];
    createWaSocketMock.mockImplementationOnce(async () => {
      callOrder.push("create");
      return createSocketWithTransportEmitter() as never;
    });
    waitForWaConnectionMock.mockImplementationOnce(async () => {
      callOrder.push("wait-for-connection");
    });

    await controller.openConnection({
      connectionId: "conn-flush-first",
      createListener: async () => createListenerStub() as never,
    });

    expect(callOrder).toEqual(["create", "wait-for-connection"]);
    expect(waitForWaConnectionMock).toHaveBeenCalledWith(expect.anything(), {
      timeoutMs: DEFAULT_WHATSAPP_SOCKET_TIMING.connectTimeoutMs,
    });
  });

  it("restarts login once on status 408 and preserves replacement socket options", async () => {
    const harness = createLoginResultHarness();
    const waitForConnection = vi
      .fn()
      .mockRejectedValueOnce({ output: { statusCode: DisconnectReason.timedOut } })
      .mockResolvedValueOnce(undefined);
    const onQr = vi.fn();
    const onSocketReplaced = vi.fn();
    const createSocket = vi.fn(
      async (_printQr: boolean, _verbose: boolean, opts?: { onQr?: (qr: string) => void }) => {
        opts?.onQr?.("qr-after-timeout");
        return harness.replacementSock;
      },
    );

    const result = await harness.run({
      verbose: true,
      waitForConnection,
      createSocket,
      socketTiming: {
        connectTimeoutMs: 10_000,
        defaultQueryTimeoutMs: 20_000,
        keepAliveIntervalMs: 30_000,
      },
      onQr,
      onSocketReplaced,
    });

    expect(result).toEqual({
      outcome: "connected",
      restarted: true,
      sock: harness.replacementSock,
    });
    expect(harness.initialSock.end).toHaveBeenCalledOnce();
    expect(createSocket).toHaveBeenCalledWith(false, true, {
      authDir: loginAuthDir,
      connectTimeoutMs: 10_000,
      defaultQueryTimeoutMs: 20_000,
      keepAliveIntervalMs: 30_000,
      onQr,
    });
    expect(onQr).toHaveBeenCalledWith("qr-after-timeout");
    expect(onSocketReplaced).toHaveBeenCalledWith(harness.replacementSock);
    expect(waitForConnection).toHaveBeenNthCalledWith(1, harness.initialSock, {
      timeout: "none",
    });
    expect(waitForConnection).toHaveBeenNthCalledWith(2, harness.replacementSock, {
      timeout: "none",
    });
  });

  it("still honors the post-pairing 515 restart after a status 408 recovery", async () => {
    const harness = createLoginResultHarness();
    const afterTimeoutSock = createSocketWithTransportEmitter();
    const afterPairingRestartSock = createSocketWithTransportEmitter();
    const waitForConnection = vi
      .fn()
      .mockRejectedValueOnce({ output: { statusCode: DisconnectReason.timedOut } })
      .mockRejectedValueOnce({ output: { statusCode: 515 } })
      .mockResolvedValueOnce(undefined);
    const createSocket = vi
      .fn()
      .mockResolvedValueOnce(afterTimeoutSock)
      .mockResolvedValueOnce(afterPairingRestartSock);

    const result = await harness.run({ waitForConnection, createSocket });

    expect(result).toEqual({
      outcome: "connected",
      restarted: true,
      sock: afterPairingRestartSock,
    });
    expect(createSocket).toHaveBeenCalledTimes(2);
    expect(waitForConnection).toHaveBeenCalledTimes(3);
    expect(waitForConnection).toHaveBeenNthCalledWith(1, harness.initialSock, {
      timeout: "none",
    });
    expect(waitForConnection).toHaveBeenNthCalledWith(2, afterTimeoutSock, { timeout: "none" });
    expect(waitForConnection).toHaveBeenNthCalledWith(3, afterPairingRestartSock, {
      timeout: "none",
    });
    expect(harness.initialSock.end).toHaveBeenCalledOnce();
    expect(afterTimeoutSock.end).toHaveBeenCalledOnce();
  });

  it("clears stale logged-out auth once and continues login with a fresh socket", async () => {
    const harness = createLoginResultHarness();
    const error = loggedOutError();
    const waitForConnection = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
    const onQr = vi.fn();
    const onSocketReplaced = vi.fn();
    const createSocket = vi.fn(
      async (_printQr: boolean, _verbose: boolean, opts?: { onQr?: (qr: string) => void }) => {
        opts?.onQr?.("qr-after-logout");
        return harness.replacementSock;
      },
    );

    const result = await harness.run({
      verbose: true,
      waitForConnection,
      createSocket,
      onQr,
      onSocketReplaced,
    });

    expect(result).toEqual({
      outcome: "connected",
      restarted: true,
      sock: harness.replacementSock,
    });
    expect(logoutWebMock).toHaveBeenCalledWith({
      authDir: loginAuthDir,
      isLegacyAuthDir: false,
      runtime: harness.runtime,
    });
    expect(harness.initialSock.end).toHaveBeenCalledOnce();
    expect(createSocket).toHaveBeenCalledWith(false, true, {
      authDir: loginAuthDir,
      onQr,
    });
    expect(onQr).toHaveBeenCalledWith("qr-after-logout");
    expect(onSocketReplaced).toHaveBeenCalledWith(harness.replacementSock);
    expect(waitForConnection).toHaveBeenNthCalledWith(1, harness.initialSock, {
      timeout: "none",
    });
    expect(waitForConnection).toHaveBeenNthCalledWith(2, harness.replacementSock, {
      timeout: "none",
    });
  });

  it("does not retry logged-out login when stale auth cleanup is skipped", async () => {
    const { createSocket, error, harness, result, waitForConnection } = await runLoggedOutRecovery({
      cleanupCleared: false,
      authDecisions: [{ outcome: "stable", exists: true }],
    });

    expect(result).toEqual({
      outcome: "failed",
      message:
        "existing auth could not be cleared. Remove or fix the configured WhatsApp auth directory, then retry login.",
      error,
    });
    expect(logoutWebMock).toHaveBeenCalledWith({
      authDir: loginAuthDir,
      isLegacyAuthDir: false,
      runtime: harness.runtime,
    });
    expect(harness.initialSock.end).toHaveBeenCalledOnce();
    expect(createSocket).not.toHaveBeenCalled();
    expect(waitForConnection).toHaveBeenCalledOnce();
  });

  it("retries logged-out login when cleanup is a no-op because no auth exists", async () => {
    const { createSocket, harness, result, waitForConnection } = await runLoggedOutRecovery({
      cleanupCleared: false,
      authDecisions: [
        { outcome: "stable", exists: false },
        { outcome: "stable", exists: true },
      ],
      secondWait: "resolve",
    });

    expect(result).toEqual({
      outcome: "connected",
      restarted: true,
      sock: harness.replacementSock,
    });
    expect(createSocket).toHaveBeenCalledOnce();
    expect(waitForConnection).toHaveBeenNthCalledWith(2, harness.replacementSock, {
      timeout: "none",
    });
  });

  it("does not clear stale logged-out auth more than once", async () => {
    const { createSocket, error, result, waitForConnection } = await runLoggedOutRecovery({
      secondWait: "logged-out",
    });

    expect(result).toMatchObject({
      outcome: "logged-out",
      statusCode: DisconnectReason.loggedOut,
      error,
    });
    expect(logoutWebMock).toHaveBeenCalledOnce();
    expect(createSocket).toHaveBeenCalledOnce();
    expect(waitForConnection).toHaveBeenCalledTimes(2);
  });

  it("does not keep recreating sockets when login status 408 persists", async () => {
    const harness = createLoginResultHarness();
    const timeoutError = { output: { statusCode: DisconnectReason.timedOut } };
    const waitForConnection = vi
      .fn()
      .mockRejectedValueOnce(timeoutError)
      .mockRejectedValueOnce(timeoutError);
    const createSocket = vi.fn(async () => harness.replacementSock);

    const result = await harness.run({ waitForConnection, createSocket });

    expect(result).toMatchObject({
      outcome: "failed",
      statusCode: DisconnectReason.timedOut,
      error: timeoutError,
    });
    expect(createSocket).toHaveBeenCalledOnce();
    expect(waitForConnection).toHaveBeenCalledTimes(2);
  });

  it("preserves credential persistence guards on a replacement login socket", async () => {
    const harness = createLoginResultHarness();
    const restartError = { output: { statusCode: DisconnectReason.restartRequired } };
    const waitForConnection = vi
      .fn()
      .mockRejectedValueOnce(restartError)
      .mockResolvedValueOnce(undefined);
    const createSocket = vi.fn(async () => harness.replacementSock);
    const beforeCredentialPersistence = vi.fn(async () => {});
    const onCredentialPersistenceError = vi.fn();
    const onCredentialPersistenceTask = vi.fn();
    const waitForCredentialPersistence = vi.fn(async () => {});

    const result = await waitForWhatsAppLoginResult({
      sock: harness.initialSock as never,
      authDir: loginAuthDir,
      isLegacyAuthDir: false,
      verbose: false,
      runtime: harness.runtime,
      waitForConnection: waitForConnection as never,
      createSocket: createSocket as never,
      beforeCredentialPersistence,
      onCredentialPersistenceError,
      onCredentialPersistenceTask,
      waitForCredentialPersistence,
    });

    expect(result.outcome).toBe("connected");
    expect(createSocket).toHaveBeenCalledWith(false, false, {
      authDir: loginAuthDir,
      onQr: undefined,
      beforeCredentialPersistence,
      onCredentialPersistenceError,
      onCredentialPersistenceTask,
    });
    expect(waitForCredentialPersistence).toHaveBeenCalledOnce();
  });

  it("returns a retryable failure when the socket opens before auth persistence settles", async () => {
    readWebAuthExistsForDecisionMock.mockResolvedValue({ outcome: "unstable" });
    const waitForConnection = vi.fn().mockResolvedValueOnce(undefined);

    const result = await waitForWhatsAppLoginResult({
      sock: createSocketWithTransportEmitter() as never,
      authDir: "/tmp/wa-auth",
      isLegacyAuthDir: false,
      verbose: false,
      runtime: { log: vi.fn() } as never,
      waitForConnection: waitForConnection as never,
    });

    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.message).toMatch(/retry/i);
      expect((result.error as { code?: string })?.code).toBe("whatsapp-auth-unstable");
    }
  });

  it("aborts an indefinite login wait when guarded credential persistence fails", async () => {
    const guardError = new Error("verified inference route changed");
    let persistenceFailure: { error: unknown } | null = null;
    let resolvePersistenceFailure = (_failure: { error: unknown }) => {};
    const persistenceFailurePromise = new Promise<{ error: unknown }>((resolve) => {
      resolvePersistenceFailure = resolve;
    });
    const pendingResult = waitForWhatsAppLoginResult({
      sock: createSocketWithTransportEmitter() as never,
      authDir: "/tmp/wa-auth",
      isLegacyAuthDir: false,
      verbose: false,
      runtime: { log: vi.fn() } as never,
      waitForConnection: vi.fn(() => new Promise<void>(() => {})) as never,
      credentialPersistenceFailure: persistenceFailurePromise,
      getCredentialPersistenceFailure: () => persistenceFailure,
    });

    persistenceFailure = { error: guardError };
    resolvePersistenceFailure(persistenceFailure);

    const result = await pendingResult;
    expect(result).toMatchObject({ outcome: "failed", error: guardError });
  });

  it("returns a retryable failure when auth is not linked on disk after the socket opens", async () => {
    readWebAuthExistsForDecisionMock.mockResolvedValue({ outcome: "stable", exists: false });
    const waitForConnection = vi.fn().mockResolvedValueOnce(undefined);

    const result = await waitForWhatsAppLoginResult({
      sock: createSocketWithTransportEmitter() as never,
      authDir: "/tmp/wa-auth",
      isLegacyAuthDir: false,
      verbose: false,
      runtime: { log: vi.fn() } as never,
      waitForConnection: waitForConnection as never,
    });

    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.message).toMatch(/retry/i);
      expect((result.error as { code?: string })?.code).toBe("whatsapp-auth-unstable");
    }
  });

  it("returns connected only after auth is confirmed durable on disk", async () => {
    readWebAuthExistsForDecisionMock.mockResolvedValue({ outcome: "stable", exists: true });
    const waitForConnection = vi.fn().mockResolvedValueOnce(undefined);
    const sock = createSocketWithTransportEmitter();

    const result = await waitForWhatsAppLoginResult({
      sock: sock as never,
      authDir: "/tmp/wa-auth",
      isLegacyAuthDir: false,
      verbose: false,
      runtime: { log: vi.fn() } as never,
      waitForConnection: waitForConnection as never,
    });

    expect(result).toEqual({ outcome: "connected", restarted: false, sock });
    expect(readWebAuthExistsForDecisionMock).toHaveBeenCalledWith("/tmp/wa-auth");
  });

  it("waits for queued creds persistence so linked auth survives an auth-dir reuse", async () => {
    const actualSession = await vi.importActual<typeof import("./session.js")>("./session.js");
    const actualAuthStore =
      await vi.importActual<typeof import("./auth-store.js")>("./auth-store.js");
    const authDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-auth-durability-"));
    try {
      readWebAuthExistsForDecisionMock.mockImplementation(
        actualSession.readWebAuthExistsForDecision,
      );
      let credsSaved = false;
      enqueueCredsSave(
        authDir,
        async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, 50);
          });
          await writeCredsJsonAtomically(authDir, { me: { id: "123@s.whatsapp.net" } });
          credsSaved = true;
        },
        () => {},
      );

      const result = await waitForWhatsAppLoginResult({
        sock: createSocketWithTransportEmitter() as never,
        authDir,
        isLegacyAuthDir: false,
        verbose: false,
        runtime: { log: vi.fn() } as never,
        waitForConnection: vi.fn().mockResolvedValueOnce(undefined) as never,
      });

      expect(credsSaved).toBe(true);
      expect(result.outcome).toBe("connected");
      // A fresh read of the same auth dir is what a restarted/rebuilt container does.
      await expect(actualAuthStore.webAuthExists(authDir)).resolves.toBe(true);
    } finally {
      await fs.rm(authDir, { recursive: true, force: true });
    }
  });

  it("keeps the ready controller published while a different-auth replacement connects", async () => {
    const disposeRuntimeContext = vi.fn();
    registerChannelRuntimeContextMock.mockReturnValueOnce({ dispose: disposeRuntimeContext });
    const liveController = new WhatsAppConnectionController({
      accountId: "work",
      authDir: "/tmp/wa-auth",
      verbose: false,
      keepAlive: false,
      heartbeatSeconds: 30,
      transportTimeoutMs: 60_000,
      messageTimeoutMs: 60_000,
      watchdogCheckMs: 5_000,
      reconnectPolicy: {
        initialMs: 250,
        maxMs: 1_000,
        factor: 2,
        jitter: 0,
        maxAttempts: 5,
      },
    });
    const liveListener = createListenerStub("live");
    createWaSocketMock.mockResolvedValueOnce(createSocketWithTransportEmitter() as never);
    waitForWaConnectionMock.mockResolvedValueOnce(undefined);
    await liveController.openConnection({
      connectionId: "live-conn",
      createListener: async () => liveListener,
    });

    const replacement = new WhatsAppConnectionController({
      accountId: "work",
      authDir: "/tmp/wa-auth-2",
      verbose: false,
      keepAlive: false,
      heartbeatSeconds: 30,
      transportTimeoutMs: 60_000,
      messageTimeoutMs: 60_000,
      watchdogCheckMs: 5_000,
      reconnectPolicy: {
        initialMs: 250,
        maxMs: 1_000,
        factor: 2,
        jitter: 0,
        maxAttempts: 5,
      },
    });

    try {
      createWaSocketMock.mockResolvedValueOnce(createSocketWithTransportEmitter() as never);
      waitForWaConnectionMock.mockRejectedValueOnce(new Error("replacement failed"));

      await expect(
        replacement.openConnection({
          connectionId: "replacement-conn",
          createListener: async () => liveListener,
        }),
      ).rejects.toThrow("replacement failed");

      expect(registerChannelRuntimeContextMock).toHaveBeenCalledTimes(3);
      expect(registerChannelRuntimeContextMock).toHaveBeenLastCalledWith({
        channelRuntime: runtimeContextMocks.channelRuntime,
        channelId: "whatsapp",
        accountId: "work",
        capability: "connection-owner-pending",
        context: true,
        abortSignal: undefined,
      });
      const activeControllerRegistrations = registerChannelRuntimeContextMock.mock.calls.filter(
        ([registration]) => registration.capability === "connection-controller",
      );
      expect(activeControllerRegistrations).toHaveLength(1);
      expect(activeControllerRegistrations[0]?.[0].context).toBe(liveController);
    } finally {
      await replacement.shutdown();
      await liveController.shutdown();
    }
    expect(disposeRuntimeContext).toHaveBeenCalledOnce();
  });

  it("releases connection ownership only after the Baileys socket closes", async () => {
    const order: string[] = [];
    let closed = false;
    const sock = {
      end: vi.fn(async () => {
        closed = true;
        order.push("socket-close");
      }),
      ws: {
        close: vi.fn(async () => {
          closed = true;
        }),
        get isClosed() {
          return closed;
        },
      },
    };
    connectionOwnerMocks.release.mockImplementationOnce(async () => {
      order.push("owner-release");
    });
    createWaSocketMock.mockResolvedValueOnce(sock as never);
    waitForWaConnectionMock.mockResolvedValueOnce(undefined);

    await controller.openConnection({
      connectionId: "owned-conn",
      createListener: async () => createListenerStub() as never,
    });
    await controller.shutdown();

    expect(order).toEqual(["socket-close", "owner-release"]);
  });

  it("joins pending ownership acquisition before shutdown returns", async () => {
    let resolveOwner = (_lease: { release: () => Promise<void> }) => {};
    connectionOwnerMocks.acquire.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOwner = resolve;
      }),
    );
    const openPromise = controller.openConnection({
      connectionId: "pending-owner",
      createListener: async () => createListenerStub() as never,
    });
    const shutdownPromise = controller.shutdown();

    resolveOwner({ release: connectionOwnerMocks.release });

    await expect(openPromise).rejects.toThrow("controller is shutting down");
    await expect(shutdownPromise).resolves.toBeUndefined();
    expect(registerChannelRuntimeContextMock).not.toHaveBeenCalled();
    expect(createWaSocketMock).not.toHaveBeenCalled();
    expect(connectionOwnerMocks.release).toHaveBeenCalledOnce();
  });

  it("cancels handshake setup and closes its socket before shutdown returns", async () => {
    const sock = createSocketWithTransportEmitter();
    createWaSocketMock.mockResolvedValueOnce(sock as never);
    waitForWaConnectionMock.mockReturnValueOnce(new Promise(() => {}));
    const openPromise = controller.openConnection({
      connectionId: "pending-handshake",
      createListener: async () => createListenerStub() as never,
    });
    await vi.waitFor(() => expect(waitForWaConnectionMock).toHaveBeenCalledOnce());

    await expect(controller.shutdown()).resolves.toBeUndefined();
    await expect(openPromise).rejects.toThrow("controller is shutting down");
    expect(sock.end).toHaveBeenCalledOnce();
    expect(registerChannelRuntimeContextMock).toHaveBeenCalledTimes(1);
    expect(registerChannelRuntimeContextMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ capability: "connection-owner-pending" }),
    );
    expect(connectionOwnerMocks.release).toHaveBeenCalledOnce();
  });

  it("does not publish a listener that resolves after setup is cancelled", async () => {
    const sock = createSocketWithTransportEmitter();
    const lateListener = { ...createListenerStub(), close: vi.fn(async () => {}) };
    let resolveListener = (_listener: ReturnType<typeof createListenerStub>) => {};
    const listenerPromise = new Promise<ReturnType<typeof createListenerStub>>((resolve) => {
      resolveListener = resolve;
    });
    createWaSocketMock.mockResolvedValueOnce(sock as never);
    waitForWaConnectionMock.mockResolvedValueOnce(undefined);
    const openPromise = controller.openConnection({
      connectionId: "pending-listener",
      createListener: async () => await listenerPromise,
    });
    await vi.waitFor(() => expect(waitForWaConnectionMock).toHaveBeenCalledOnce());

    await expect(controller.shutdown()).resolves.toBeUndefined();
    await expect(openPromise).rejects.toThrow("controller is shutting down");
    resolveListener(lateListener);
    await listenerPromise;
    await vi.waitFor(() => expect(lateListener.close).toHaveBeenCalledOnce());
    expect(controller.getActiveListener()).toBeNull();
    expect(controller.getCurrentSock()).toBeNull();
    expect(registerChannelRuntimeContextMock).toHaveBeenCalledTimes(1);
    expect(connectionOwnerMocks.release).toHaveBeenCalledOnce();
  });

  it("closes a listener resolved at the setup cancellation boundary", async () => {
    const sock = createSocketWithTransportEmitter();
    const listener = { ...createListenerStub(), close: vi.fn(async () => {}) };
    let shutdownPromise: Promise<void> | undefined;
    createWaSocketMock.mockResolvedValueOnce(sock as never);
    waitForWaConnectionMock.mockResolvedValueOnce(undefined);
    const openPromise = controller.openConnection({
      connectionId: "resolved-listener",
      createListener: async () => {
        queueMicrotask(() => {
          shutdownPromise = controller.shutdown();
        });
        return listener as never;
      },
    });

    await expect(openPromise).rejects.toThrow("controller is shutting down");
    await vi.waitFor(() => expect(shutdownPromise).toBeDefined());
    await shutdownPromise;
    expect(listener.close).toHaveBeenCalledOnce();
    expect(controller.getActiveListener()).toBeNull();
    expect(connectionOwnerMocks.release).toHaveBeenCalledOnce();
  });

  it("retains connection ownership when socket close cannot be confirmed", async () => {
    let closed = false;
    const sock = {
      end: vi
        .fn()
        .mockRejectedValueOnce(new Error("end failed"))
        .mockImplementationOnce(async () => {
          closed = true;
        }),
      ws: {
        close: vi.fn().mockRejectedValueOnce(new Error("websocket close failed")),
        get isClosed() {
          return closed;
        },
      },
    };
    createWaSocketMock.mockResolvedValueOnce(sock as never);
    waitForWaConnectionMock.mockResolvedValueOnce(undefined);
    await controller.openConnection({
      connectionId: "uncertain-close",
      createListener: async () => createListenerStub() as never,
    });

    await expect(controller.shutdown()).rejects.toThrow("socket close could not be confirmed");
    expect(connectionOwnerMocks.release).not.toHaveBeenCalled();
  });

  it("retains connection ownership until queued credentials drain", async () => {
    let closed = false;
    const sock = {
      end: vi.fn(async () => {
        closed = true;
      }),
      ws: {
        close: vi.fn(async () => {
          closed = true;
        }),
        get isClosed() {
          return closed;
        },
      },
    };
    createWaSocketMock.mockResolvedValueOnce(sock as never);
    waitForWaConnectionMock.mockResolvedValueOnce(undefined);
    waitForCredsSaveQueueWithTimeoutMock
      .mockResolvedValueOnce("timed_out")
      .mockResolvedValueOnce("drained");
    await controller.openConnection({
      connectionId: "pending-creds",
      createListener: async () => createListenerStub() as never,
    });

    await expect(controller.shutdown()).rejects.toThrow("credential persistence did not drain");
    expect(connectionOwnerMocks.release).not.toHaveBeenCalled();
    expect(sock.end).toHaveBeenCalledOnce();
    expect(controller.getActiveListener()).toBeNull();
    expect(controller.getCurrentSock()).toBeNull();

    await expect(controller.shutdown()).resolves.toBeUndefined();
    expect(connectionOwnerMocks.release).toHaveBeenCalledOnce();
  });

  it("retains connection ownership until a failed release can be retried", async () => {
    const sock = createSocketWithTransportEmitter();
    connectionOwnerMocks.release
      .mockRejectedValueOnce(new Error("owner release failed"))
      .mockResolvedValueOnce(undefined);
    createWaSocketMock.mockResolvedValueOnce(sock as never);
    waitForWaConnectionMock.mockResolvedValueOnce(undefined);
    await controller.openConnection({
      connectionId: "release-retry",
      createListener: async () => createListenerStub() as never,
    });

    await expect(controller.shutdown()).rejects.toThrow("owner release failed");
    expect(controller.getActiveListener()).toBeNull();
    expect(controller.getCurrentSock()).toBeNull();

    await expect(controller.shutdown()).resolves.toBeUndefined();
    expect(connectionOwnerMocks.release).toHaveBeenCalledTimes(2);
  });

  it("tracks real websocket frame activity in the connection snapshot", async () => {
    vi.useFakeTimers();
    const controllerValue = new WhatsAppConnectionController({
      accountId: "work",
      authDir: "/tmp/wa-auth",
      verbose: false,
      keepAlive: true,
      heartbeatSeconds: 1,
      transportTimeoutMs: 60_000,
      messageTimeoutMs: 60_000,
      watchdogCheckMs: 5_000,
      reconnectPolicy: {
        initialMs: 250,
        maxMs: 1_000,
        factor: 2,
        jitter: 0,
        maxAttempts: 5,
      },
    });

    try {
      const sock = createSocketWithTransportEmitter();
      createWaSocketMock.mockResolvedValueOnce(sock as never);
      waitForWaConnectionMock.mockResolvedValueOnce(undefined);

      const snapshots: Array<{ lastTransportActivityAt: number }> = [];
      await controllerValue.openConnection({
        connectionId: "conn-frame-activity",
        createListener: async () => createListenerStub() as never,
        onHeartbeat: (snapshot) => snapshots.push(snapshot),
      });

      await vi.advanceTimersByTimeAsync(1_000);
      const firstSnapshot = snapshots.at(-1);
      expect(firstSnapshot?.lastTransportActivityAt).toBeTypeOf("number");

      const firstTransportAt = firstSnapshot?.lastTransportActivityAt ?? 0;
      await vi.advanceTimersByTimeAsync(250);
      sock.ws.emit("frame");
      await vi.advanceTimersByTimeAsync(1_000);

      const lastSnapshot = snapshots.at(-1);
      expect(lastSnapshot?.lastTransportActivityAt).toBeGreaterThan(firstTransportAt);
    } finally {
      await controllerValue.shutdown();
      vi.useRealTimers();
    }
  });

  it("forces reconnect on transport stall before the long app-silence window", async () => {
    vi.useFakeTimers();
    const controllerLocal = new WhatsAppConnectionController({
      accountId: "work",
      authDir: "/tmp/wa-auth",
      verbose: false,
      keepAlive: true,
      heartbeatSeconds: 1,
      transportTimeoutMs: 30,
      messageTimeoutMs: 3_000,
      watchdogCheckMs: 5,
      reconnectPolicy: {
        initialMs: 250,
        maxMs: 1_000,
        factor: 2,
        jitter: 0,
        maxAttempts: 5,
      },
    });

    try {
      const sock = createSocketWithTransportEmitter();
      createWaSocketMock.mockResolvedValueOnce(sock as never);
      waitForWaConnectionMock.mockResolvedValueOnce(undefined);

      const timeouts: string[] = [];
      await controllerLocal.openConnection({
        connectionId: "conn-transport-timeout",
        createListener: async () => createListenerStub() as never,
        onWatchdogTimeout: () => timeouts.push("timeout"),
      });

      await vi.advanceTimersByTimeAsync(40);

      expect(timeouts.length).toBeGreaterThanOrEqual(1);
    } finally {
      await controllerLocal.shutdown();
      vi.useRealTimers();
    }
  });

  it("uses messageTimeoutMs * 4 as the app-silence window for fresh connections with no inbound", async () => {
    // Verifies the watchdog respects appSilenceTimeoutMs = messageTimeoutMs * 4 on first open.
    // Transport is kept well within its own timeout so only app-silence fires.
    vi.useFakeTimers();
    const msgTimeoutMs = 100;
    const controllerLocal = new WhatsAppConnectionController({
      accountId: "work",
      authDir: "/tmp/wa-auth",
      verbose: false,
      keepAlive: true,
      heartbeatSeconds: 1,
      transportTimeoutMs: 10_000,
      messageTimeoutMs: msgTimeoutMs,
      watchdogCheckMs: 10,
      reconnectPolicy: {
        initialMs: 250,
        maxMs: 1_000,
        factor: 2,
        jitter: 0,
        maxAttempts: 5,
      },
    });

    try {
      const sock = createSocketWithTransportEmitter();
      createWaSocketMock.mockResolvedValueOnce(sock as never);
      waitForWaConnectionMock.mockResolvedValueOnce(undefined);

      const timeouts: string[] = [];
      await controllerLocal.openConnection({
        connectionId: "conn-app-silence",
        createListener: async () => createListenerStub() as never,
        onWatchdogTimeout: () => timeouts.push("timeout"),
      });

      // Just before messageTimeoutMs * 4 — no force-close expected
      await vi.advanceTimersByTimeAsync(msgTimeoutMs * 4 - 20);
      expect(timeouts).toHaveLength(0);

      // Past messageTimeoutMs * 4 — force-close must fire
      await vi.advanceTimersByTimeAsync(40);
      expect(timeouts.length).toBeGreaterThanOrEqual(1);
    } finally {
      await controllerLocal.shutdown();
      vi.useRealTimers();
    }
  });

  it("settles close and cancels setup when the stop signal is already aborted", async () => {
    const abort = new AbortController();
    const stopReason = new Error("already stopped");
    abort.abort(stopReason);
    const preAbortedController = new WhatsAppConnectionController({
      accountId: "work",
      authDir: "/tmp/wa-auth",
      verbose: false,
      keepAlive: false,
      heartbeatSeconds: 30,
      transportTimeoutMs: 60_000,
      messageTimeoutMs: 60_000,
      watchdogCheckMs: 5_000,
      reconnectPolicy: {
        initialMs: 250,
        maxMs: 1_000,
        factor: 2,
        jitter: 0,
        maxAttempts: 5,
      },
      abortSignal: abort.signal,
    });

    let ownerAcquireSignal: AbortSignal | undefined;
    connectionOwnerMocks.acquire.mockImplementationOnce(async (_authDir, signal) => {
      ownerAcquireSignal = signal;
      return { release: connectionOwnerMocks.release };
    });

    try {
      const abortPromise = (
        preAbortedController as unknown as { abortPromise?: Promise<"aborted"> }
      ).abortPromise;
      await expect(abortPromise).resolves.toBe("aborted");
      await expect(
        preAbortedController.openConnection({
          connectionId: "conn-pre-aborted",
          createListener: async () => createListenerStub() as never,
        }),
      ).rejects.toThrow("controller is shutting down");

      expect(ownerAcquireSignal?.aborted).toBe(true);
      expect(ownerAcquireSignal?.reason).toBe(stopReason);
      expect(createWaSocketMock).not.toHaveBeenCalled();
    } finally {
      await preAbortedController.shutdown();
    }
  });
});

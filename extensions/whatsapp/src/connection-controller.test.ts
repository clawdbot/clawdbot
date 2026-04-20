import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRegisteredWhatsAppConnectionController } from "./connection-controller-registry.js";
import { WhatsAppConnectionController } from "./connection-controller.js";
import { createWaSocket, waitForWaConnection } from "./session.js";

vi.mock("./session.js", async () => {
  const actual = await vi.importActual<typeof import("./session.js")>("./session.js");
  return {
    ...actual,
    createWaSocket: vi.fn(),
    waitForWaConnection: vi.fn(),
  };
});

const createWaSocketMock = vi.mocked(createWaSocket);
const waitForWaConnectionMock = vi.mocked(waitForWaConnection);

function createListenerStub(messageId = "ok") {
  return {
    sendMessage: vi.fn(async () => ({ messageId })),
    sendPoll: vi.fn(async () => ({ messageId })),
    sendReaction: vi.fn(async () => {}),
    sendComposingTo: vi.fn(async () => {}),
  };
}

describe("WhatsAppConnectionController", () => {
  let controller: WhatsAppConnectionController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new WhatsAppConnectionController({
      accountId: "work",
      authDir: "/tmp/wa-auth",
      verbose: false,
      keepAlive: false,
      heartbeatSeconds: 30,
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
    const sock = {
      ws: {
        close: vi.fn(),
      },
    };
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
    expect(sock.ws.close).toHaveBeenCalledOnce();
    expect(controller.socketRef.current).toBeNull();
    expect(controller.getActiveListener()).toBeNull();
  });

  it("lets createWaSocket own the auth barrier before opening a socket", async () => {
    const callOrder: string[] = [];
    createWaSocketMock.mockImplementationOnce(async () => {
      callOrder.push("create");
      return { ws: { close: vi.fn() } } as never;
    });
    waitForWaConnectionMock.mockImplementationOnce(async () => {
      callOrder.push("wait-for-connection");
    });

    await controller.openConnection({
      connectionId: "conn-flush-first",
      createListener: async () => createListenerStub() as never,
    });

    expect(callOrder).toEqual(["create", "wait-for-connection"]);
  });

  it("keeps the previous registered controller until a replacement listener is ready", async () => {
    const liveController = new WhatsAppConnectionController({
      accountId: "work",
      authDir: "/tmp/wa-auth",
      verbose: false,
      keepAlive: false,
      heartbeatSeconds: 30,
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
    createWaSocketMock.mockResolvedValueOnce({ ws: { close: vi.fn() } } as never);
    waitForWaConnectionMock.mockResolvedValueOnce(undefined);
    await liveController.openConnection({
      connectionId: "live-conn",
      createListener: async () => liveListener,
    });

    expect(getRegisteredWhatsAppConnectionController("work")).toBe(liveController);

    const replacement = new WhatsAppConnectionController({
      accountId: "work",
      authDir: "/tmp/wa-auth-2",
      verbose: false,
      keepAlive: false,
      heartbeatSeconds: 30,
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
      createWaSocketMock.mockResolvedValueOnce({ ws: { close: vi.fn() } } as never);
      waitForWaConnectionMock.mockRejectedValueOnce(new Error("replacement failed"));

      await expect(
        replacement.openConnection({
          connectionId: "replacement-conn",
          createListener: async () => liveListener,
        }),
      ).rejects.toThrow("replacement failed");

      expect(getRegisteredWhatsAppConnectionController("work")).toBe(liveController);
    } finally {
      await replacement.shutdown();
      await liveController.shutdown();
    }
  });
});

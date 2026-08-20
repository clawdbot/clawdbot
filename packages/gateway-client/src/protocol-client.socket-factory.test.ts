import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayClient } from "./client.js";
import {
  GatewayProtocolClient,
  type GatewayProtocolSocket,
  type GatewayProtocolSocketHandlers,
} from "./protocol-client.js";

type SocketFactoryHarness = {
  client: GatewayProtocolClient<Record<string, never>>;
  createSocket: ReturnType<
    typeof vi.fn<(handlers: GatewayProtocolSocketHandlers) => GatewayProtocolSocket>
  >;
  onConnectError: ReturnType<typeof vi.fn<(error: Error) => void>>;
};

function createSocketFactoryHarness(options?: {
  initialFailures?: number;
  onConnectError?: (error: Error) => void;
  retryFactoryError?: (error: Error) => boolean;
  rethrowFactoryError?: (error: Error) => boolean;
}): SocketFactoryHarness {
  let remainingFailures = options?.initialFailures ?? 0;
  const onConnectError = vi.fn<(error: Error) => void>((error) => options?.onConnectError?.(error));
  const createSocket = vi.fn<(handlers: GatewayProtocolSocketHandlers) => GatewayProtocolSocket>(
    () => {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("temporary socket construction failure");
      }
      return {
        isOpen: () => true,
        send: vi.fn(),
        close: vi.fn(),
      };
    },
  );
  const client = new GatewayProtocolClient<Record<string, never>>({
    createSocket,
    createRequestId: () => "request-1",
    buildConnectPlan: () => ({}),
    buildConnectParams: (plan) => plan,
    resolveClose: () => ({ retry: true, notify: true }),
    onConnectError,
    handshake: { mode: "require-challenge", timeoutMs: 100 },
    reconnect: { initialMs: 10, multiplier: 2, maxMs: 100 },
    ...(options?.retryFactoryError
      ? { shouldRetrySocketFactoryError: options.retryFactoryError }
      : {}),
    ...(options?.rethrowFactoryError
      ? { rethrowSocketFactoryError: options.rethrowFactoryError }
      : {}),
  });
  return { client, createSocket, onConnectError };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GatewayProtocolClient socket factory recovery", () => {
  it("automatically retries a socket factory failure when the transport opts in", async () => {
    vi.useFakeTimers();
    const { client, createSocket, onConnectError } = createSocketFactoryHarness({
      initialFailures: 1,
      retryFactoryError: () => true,
    });

    client.start();

    expect(createSocket).toHaveBeenCalledOnce();
    expect(onConnectError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "temporary socket construction failure" }),
    );
    expect(vi.getTimerCount()).toBe(1);

    client.start();
    expect(createSocket).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(9);
    expect(createSocket).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(createSocket).toHaveBeenCalledTimes(2);
    expect(client.connected).toBe(true);

    client.stop();
  });

  it("uses the canonical exponential reconnect schedule for consecutive failures", async () => {
    vi.useFakeTimers();
    const { client, createSocket, onConnectError } = createSocketFactoryHarness({
      initialFailures: 3,
      retryFactoryError: () => true,
    });

    client.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(createSocket).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(19);
    expect(createSocket).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(createSocket).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(39);
    expect(createSocket).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(createSocket).toHaveBeenCalledTimes(4);
    expect(onConnectError).toHaveBeenCalledTimes(3);
    expect(client.connected).toBe(true);

    client.stop();
  });

  it("cancels a pending factory retry when the client is stopped", async () => {
    vi.useFakeTimers();
    const { client, createSocket } = createSocketFactoryHarness({
      initialFailures: 1,
      retryFactoryError: () => true,
    });

    client.start();
    expect(vi.getTimerCount()).toBe(1);
    client.stop();

    await vi.advanceTimersByTimeAsync(100);
    expect(createSocket).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not schedule a retry when an error callback stops the client", () => {
    vi.useFakeTimers();
    const { client, createSocket } = createSocketFactoryHarness({
      initialFailures: 1,
      onConnectError: () => client.stop(),
      retryFactoryError: () => true,
    });

    client.start();

    expect(createSocket).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not schedule a retry over a socket restarted by an error callback", async () => {
    vi.useFakeTimers();
    const { client, createSocket } = createSocketFactoryHarness({
      initialFailures: 1,
      onConnectError: () => client.start(),
      retryFactoryError: () => true,
    });

    client.start();

    expect(createSocket).toHaveBeenCalledTimes(2);
    expect(client.connected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(createSocket).toHaveBeenCalledTimes(2);
    expect(client.connected).toBe(true);

    client.stop();
  });

  it("keeps socket factory failures terminal unless a transport explicitly opts in", async () => {
    vi.useFakeTimers();
    const { client, createSocket, onConnectError } = createSocketFactoryHarness({
      initialFailures: 2,
    });

    client.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(createSocket).toHaveBeenCalledOnce();
    expect(onConnectError).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    client.stop();
  });

  it("does not schedule retries for factory errors rejected by the transport", async () => {
    vi.useFakeTimers();
    const { client, createSocket } = createSocketFactoryHarness({
      initialFailures: 2,
      retryFactoryError: () => false,
    });

    client.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(createSocket).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    client.stop();
  });

  it("does not turn a rethrown policy failure into a scheduled retry", () => {
    vi.useFakeTimers();
    const { client, createSocket } = createSocketFactoryHarness({
      initialFailures: 1,
      retryFactoryError: () => true,
      rethrowFactoryError: () => true,
    });

    expect(() => client.start()).toThrow("temporary socket construction failure");
    expect(createSocket).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    client.stop();
  });
});

describe("GatewayClient socket factory recovery", () => {
  it("accepts uppercase WSS URLs with a TLS fingerprint", () => {
    const onConnectError = vi.fn<(error: Error) => void>();
    const beforeConnect = vi.fn(() => {
      throw new Error("stop after transport policy");
    });
    const client = new GatewayClient({
      url: "WSS://gateway.example:18789",
      tlsFingerprint: "ab".repeat(32),
      onConnectError,
      hostDeps: { beforeConnect },
    });

    client.start();

    expect(beforeConnect).toHaveBeenCalledOnce();
    expect(onConnectError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "stop after transport policy" }),
    );
    client.stop();
  });

  it("retries transient node-host setup failures without requiring another start", async () => {
    vi.useFakeTimers();
    const onConnectError = vi.fn<(error: Error) => void>();
    const beforeConnect = vi.fn(() => {
      throw new Error("temporary node transport setup failure");
    });
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      onConnectError,
      hostDeps: { beforeConnect },
    });

    client.start();
    expect(beforeConnect).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(999);
    expect(beforeConnect).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(beforeConnect).toHaveBeenCalledTimes(2);
    expect(onConnectError).toHaveBeenCalledTimes(2);

    client.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(beforeConnect).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    {
      label: "insecure remote plaintext",
      url: "ws://gateway.example:18789",
      expectedMessage: "SECURITY ERROR",
    },
    {
      label: "malformed gateway URL",
      url: "not a gateway URL",
      expectedMessage: "SECURITY ERROR",
    },
    {
      label: "TLS fingerprint on plaintext",
      url: "ws://127.0.0.1:18789",
      tlsFingerprint: "deadbeef",
      expectedMessage: "gateway tls fingerprint requires wss:// gateway url",
    },
    {
      label: "invalid TLS fingerprint",
      url: "wss://gateway.example:18789",
      tlsFingerprint: "deadbeef",
      expectedMessage: "gateway tls fingerprint must be a SHA-256 fingerprint",
    },
  ])("does not retry $label", async ({ url, tlsFingerprint, expectedMessage }) => {
    vi.useFakeTimers();
    const onConnectError = vi.fn<(error: Error) => void>();
    const beforeConnect = vi.fn();
    const client = new GatewayClient({
      url,
      tlsFingerprint,
      onConnectError,
      hostDeps: { beforeConnect },
    });

    expect(() => client.start()).not.toThrow();
    expect(onConnectError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: expect.stringContaining(expectedMessage) }),
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(onConnectError).toHaveBeenCalledOnce();
    expect(beforeConnect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    client.stop();
  });

  it("keeps a loopback proxy policy failure terminal and observable", () => {
    vi.useFakeTimers();
    const registerGatewayLoopbackBypass = vi.fn(() => {
      throw new Error("loopback proxy policy rejected");
    });
    const onConnectError = vi.fn<(error: Error) => void>();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      onConnectError,
      hostDeps: { registerGatewayLoopbackBypass },
    });

    expect(() => client.start()).toThrow("loopback proxy policy rejected");
    expect(registerGatewayLoopbackBypass).toHaveBeenCalledOnce();
    expect(onConnectError).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    client.stop();
  });

  it.each([
    { label: "malformed syntax", error: new SyntaxError("invalid socket") },
    { label: "invalid socket options", error: new TypeError("invalid socket options") },
    { label: "invalid protocol range", error: new RangeError("unsupported protocol") },
  ])("does not retry $label from the socket factory", async ({ error }) => {
    vi.useFakeTimers();
    const beforeConnect = vi.fn(() => {
      throw error;
    });
    const onConnectError = vi.fn<(error: Error) => void>();
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      onConnectError,
      hostDeps: { beforeConnect },
    });

    client.start();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(beforeConnect).toHaveBeenCalledOnce();
    expect(onConnectError).toHaveBeenCalledExactlyOnceWith(error);
    expect(vi.getTimerCount()).toBe(0);
    client.stop();
  });
});

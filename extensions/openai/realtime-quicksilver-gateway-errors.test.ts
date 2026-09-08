import { describe, expect, it, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import { emitSideband, FakeSocket } from "./realtime-quicksilver.test-helpers.js";

const OPAQUE_MODEL = "gpt-live-test-canary";
const SENSITIVE_DETAILS = ["sensitive-route", "sensitive-session", "sensitive-transcript"];

function createDirectBridge(params?: {
  socketFactory?: () => FakeSocket;
  resolveAuth?: () => Promise<{ type: "api-key"; token: string }>;
}) {
  let socket: FakeSocket | undefined;
  const logger = { debug: vi.fn(), warn: vi.fn() };
  const onClose = vi.fn();
  const onError = vi.fn();
  const bridge = new OpenAIQuicksilverGatewayBridge(
    {
      providerConfig: {},
      model: OPAQUE_MODEL,
      voice: "marin",
      audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onClose,
      onError,
      runAgentConsult: vi.fn(async () => ({ text: "done" })),
      logger,
      resolveAuth:
        params?.resolveAuth ??
        vi.fn(async () => ({
          type: "api-key" as const,
          token: "platform-key",
        })),
      webSocketFactory: () => {
        socket = params?.socketFactory?.() ?? new FakeSocket();
        return socket;
      },
    },
    openAIRealtimeHost,
  );
  return {
    bridge,
    logger,
    onClose,
    onError,
    readSocket: () => {
      if (!socket) {
        throw new Error("expected direct socket");
      }
      return socket;
    },
  };
}

function expectNoPrivateDetail(harness: ReturnType<typeof createDirectBridge>): void {
  const projected = JSON.stringify([
    ...harness.logger.debug.mock.calls,
    ...harness.logger.warn.mock.calls,
  ]);
  for (const privateValue of [OPAQUE_MODEL, ...SENSITIVE_DETAILS]) {
    expect(projected).not.toContain(privateValue);
  }
}

describe("GPT-Live gateway relay error projection", () => {
  it("projects arbitrary auth-store errors before provider I/O", async () => {
    const socketFactory = vi.fn(() => new FakeSocket());
    const authError = new Error(`Secret owner profile:private-account (${OPAQUE_MODEL})`);
    authError.name = `Private${OPAQUE_MODEL}`;
    const harness = createDirectBridge({
      socketFactory,
      resolveAuth: vi.fn(async () => {
        throw authError;
      }),
    });

    const error = await harness.bridge.connect().catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      message: "OpenAI GPT-Live authentication failed",
      name: "Error",
    });
    expect(socketFactory).not.toHaveBeenCalled();
    expect(harness.onError).not.toHaveBeenCalled();
    expectNoPrivateDetail(harness);
  });

  it("redacts an opaque model from a startup socket failure", async () => {
    const harness = createDirectBridge({
      socketFactory: () => {
        const socket = new FakeSocket("manual");
        queueMicrotask(() => {
          const error = new Error(
            `provider rejected ${OPAQUE_MODEL} ${SENSITIVE_DETAILS.join(" ")}`,
          );
          error.name = `Provider${OPAQUE_MODEL}`;
          socket.readyState = 1;
          socket.emit("open");
          socket.emit("error", error);
        });
        return socket;
      },
    });

    const error = await harness.bridge.connect().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: "OpenAI GPT-Live gateway relay failed",
      name: "Error",
    });
    expect(harness.onError).not.toHaveBeenCalled();
    expectNoPrivateDetail(harness);
  });

  it.each(["error", "close"] as const)(
    "redacts an opaque model from a live socket %s",
    async (terminalEvent) => {
      const harness = createDirectBridge();
      const connection = harness.bridge.connect();
      await vi.waitFor(() => expect(harness.readSocket().readyState).toBe(1));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      emitSideband(harness.readSocket(), {
        type: "session.started",
        session: { expires_at: Math.floor(Date.now() / 1000) + 60 },
      });
      await connection;

      if (terminalEvent === "error") {
        harness
          .readSocket()
          .emit(
            "error",
            new Error(`provider rejected ${OPAQUE_MODEL} ${SENSITIVE_DETAILS.join(" ")}`),
          );
      } else {
        harness
          .readSocket()
          .emit(
            "close",
            1011,
            Buffer.from(`provider rejected ${OPAQUE_MODEL} ${SENSITIVE_DETAILS.join(" ")}`),
          );
      }

      expect(harness.onError).toHaveBeenCalledOnce();
      const reported = harness.onError.mock.calls[0]?.[0];
      expect(reported).toMatchObject({
        message: "OpenAI GPT-Live gateway relay failed",
        name: "Error",
      });
      expect(harness.onClose).toHaveBeenCalledWith("error");
      expectNoPrivateDetail(harness);
    },
  );
});

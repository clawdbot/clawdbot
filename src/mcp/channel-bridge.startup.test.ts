import { beforeEach, describe, expect, it, vi } from "vitest";
import type { resolveGatewayClientBootstrap } from "../gateway/client-bootstrap.js";

const mockState = vi.hoisted(() => ({
  clientOptions: null as Record<string, unknown> | null,
  autoHello: true,
}));

const resolveGatewayClientBootstrapMock = vi.hoisted(() =>
  vi.fn<typeof resolveGatewayClientBootstrap>(async () => ({
    url: "wss://127.0.0.1:18789",
    urlSource: "local loopback",
    connectionDetails: {
      url: "wss://127.0.0.1:18789",
      urlSource: "local loopback",
      message: "Gateway target: wss://127.0.0.1:18789",
    },
    tlsFingerprint: "sha256:local",
    auth: {
      token: undefined,
      password: undefined,
    },
  })),
);

vi.mock("../gateway/client-bootstrap.js", () => ({
  resolveGatewayClientBootstrap: resolveGatewayClientBootstrapMock,
}));

vi.mock("../gateway/client.js", () => ({
  GatewayClient: class MockGatewayClient {
    private readonly options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      mockState.clientOptions = options;
    }

    start(): void {
      if (!mockState.autoHello) {
        return;
      }
      const onHelloOk = this.options.onHelloOk;
      if (typeof onHelloOk === "function") {
        onHelloOk();
      }
    }

    async request(): Promise<void> {}

    async stopAndWait(): Promise<void> {}
  },
}));

vi.mock("../gateway/client-start-readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: vi.fn(async (client: { start: () => void }) => {
    client.start();
    return {
      ready: true,
      aborted: false,
      elapsedMs: 0,
      maxDriftMs: 0,
      checks: 1,
    };
  }),
}));

vi.mock("../gateway/method-scopes.js", () => ({
  APPROVALS_SCOPE: "operator.approvals",
  READ_SCOPE: "operator.read",
  WRITE_SCOPE: "operator.write",
}));

vi.mock("../../packages/gateway-protocol/src/client-info.js", () => ({
  GATEWAY_CLIENT_CAPS: { APPROVALS: "approvals" },
  GATEWAY_CLIENT_MODES: { CLI: "cli" },
  GATEWAY_CLIENT_NAMES: { CLI: "cli" },
}));

const { OpenClawChannelBridge } = await import("./channel-bridge.js");

describe("OpenClawChannelBridge startup", () => {
  beforeEach(() => {
    mockState.clientOptions = null;
    mockState.autoHello = true;
  });

  it("passes the resolved TLS fingerprint to the Gateway client", async () => {
    const bridge = new OpenClawChannelBridge({} as never, {
      claudeChannelMode: "off",
      verbose: false,
    });

    await bridge.start();

    expect(mockState.clientOptions?.tlsFingerprint).toBe("sha256:local");
    await bridge.close();
  });

  it("waits through retryable Gateway startup until hello succeeds", async () => {
    mockState.autoHello = false;
    const bridge = new OpenClawChannelBridge({} as never, {
      claudeChannelMode: "off",
      verbose: false,
    });

    const started = bridge.start();
    await vi.waitFor(() => {
      expect(mockState.clientOptions).not.toBeNull();
    });
    expect(mockState.clientOptions?.notifyOnStartupRetry).not.toBe(true);

    const onHelloOk = mockState.clientOptions?.onHelloOk;
    if (typeof onHelloOk !== "function") {
      throw new Error("Expected Gateway hello callback");
    }
    onHelloOk();

    await expect(started).resolves.toBeUndefined();
    await bridge.close();
  });
});

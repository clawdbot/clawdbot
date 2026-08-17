import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClientOptions } from "../gateway/client.js";
import { createNodeHostGatewayCandidateConnection } from "./gateway-candidate-connection.js";

const mocks = vi.hoisted(() => ({
  options: [] as GatewayClientOptions[],
  clients: [] as Array<{
    request: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    updateNodeManifest: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("../gateway/client.js", () => ({
  GatewayClient: function GatewayClient(options: GatewayClientOptions) {
    const client = {
      request: vi.fn(async () => ({ url: options.url })),
      start: vi.fn(),
      stop: vi.fn(),
      updateNodeManifest: vi.fn(),
    };
    mocks.options.push(options);
    mocks.clients.push(client);
    return client;
  },
}));

const candidates = [
  { host: "192.168.1.20", port: 18789, contextPath: "/openclaw-gw", tls: false },
  { host: "gateway.tailnet.example", port: 443, tls: true },
];

function createConnection(
  cloudflareAccessByCandidate?: Parameters<
    typeof createNodeHostGatewayCandidateConnection
  >[0]["cloudflareAccessByCandidate"],
) {
  const callbacks = {
    onEvent: vi.fn(),
    onHelloOk: vi.fn(),
    onConnectError: vi.fn(),
    onReconnectPaused: vi.fn(),
    onClose: vi.fn(),
    onWinningCandidate: vi.fn(),
  };
  return {
    callbacks,
    connection: createNodeHostGatewayCandidateConnection({
      candidates,
      clientOptions: {},
      cloudflareAccessByCandidate,
      ...callbacks,
    }),
  };
}

describe("gateway candidate connection", () => {
  beforeEach(() => {
    mocks.options.length = 0;
    mocks.clients.length = 0;
    vi.clearAllMocks();
  });

  it("rotates only before hello, fences stale callbacks, and forwards through the winner", async () => {
    const { callbacks, connection } = createConnection();
    connection.start();

    expect(mocks.options[0]?.url).toBe("ws://192.168.1.20:18789/openclaw-gw");
    expect(mocks.clients[0]?.start).toHaveBeenCalledOnce();
    mocks.options[0]?.onClose?.(1006, "transport unavailable", {
      phase: "pre-hello",
      socketOpened: false,
      transportValidated: false,
      connectRequestSent: false,
      transientPreHelloCleanClose: false,
    });
    await vi.waitFor(() => expect(mocks.clients).toHaveLength(2));

    expect(mocks.clients[0]?.stop).toHaveBeenCalledOnce();
    expect(mocks.options[1]?.url).toBe("wss://gateway.tailnet.example:443");
    expect(mocks.clients[1]?.start).toHaveBeenCalledOnce();

    mocks.options[0]?.onEvent?.({ type: "event", event: "stale" });
    mocks.options[0]?.onHelloOk?.({} as never);
    mocks.options[0]?.onClose?.(1006, "stale close", {
      phase: "pre-hello",
      socketOpened: false,
      transportValidated: false,
      connectRequestSent: false,
      transientPreHelloCleanClose: false,
    });
    expect(callbacks.onEvent).not.toHaveBeenCalled();
    expect(callbacks.onHelloOk).not.toHaveBeenCalled();
    expect(callbacks.onWinningCandidate).not.toHaveBeenCalled();
    expect(mocks.clients).toHaveLength(2);

    const activeEvent = { type: "event", event: "active" } as const;
    mocks.options[1]?.onEvent?.(activeEvent);
    mocks.options[1]?.onHelloOk?.({} as never);
    mocks.options[1]?.onHelloOk?.({} as never);
    expect(callbacks.onEvent).toHaveBeenCalledWith(activeEvent);
    expect(callbacks.onWinningCandidate).toHaveBeenCalledOnce();
    expect(callbacks.onWinningCandidate).toHaveBeenCalledWith(candidates[1]);

    await connection.request("node.test", { active: true }, undefined);
    connection.updateNodeManifest({ caps: ["mcp"], commands: ["mcp.tools.call.v1"] });
    expect(mocks.clients[0]?.request).not.toHaveBeenCalled();
    expect(mocks.clients[1]?.request).toHaveBeenCalledWith(
      "node.test",
      { active: true },
      undefined,
    );
    expect(mocks.clients[1]?.updateNodeManifest).toHaveBeenCalledWith({
      caps: ["mcp"],
      commands: ["mcp.tools.call.v1"],
    });
  });

  it("does not rotate after the connect request was sent", async () => {
    createConnection();

    mocks.options[0]?.onClose?.(1008, "connect failed", {
      phase: "pre-hello",
      socketOpened: true,
      transportValidated: true,
      connectRequestSent: true,
      transientPreHelloCleanClose: false,
    });
    await Promise.resolve();

    expect(mocks.clients).toHaveLength(1);
  });

  it("promotes a candidate after hello instead of replaying setup auth on another endpoint", async () => {
    const { callbacks } = createConnection();

    mocks.options[0]?.onHelloOk?.({} as never);
    mocks.options[0]?.onClose?.(1006, "later reconnect transport failure", {
      phase: "pre-hello",
      socketOpened: false,
      transportValidated: false,
      connectRequestSent: false,
      transientPreHelloCleanClose: false,
    });
    await Promise.resolve();

    expect(callbacks.onWinningCandidate).toHaveBeenCalledWith(candidates[0]);
    expect(mocks.clients).toHaveLength(1);
  });

  it("carries a pre-hello manifest update into the next candidate", async () => {
    const { connection } = createConnection();
    const manifest = { caps: ["mcp"], commands: ["mcp.tools.call.v1"] };

    connection.updateNodeManifest(manifest);
    mocks.options[0]?.onClose?.(1006, "transport unavailable", {
      phase: "pre-hello",
      socketOpened: false,
      transportValidated: false,
      connectRequestSent: false,
      transientPreHelloCleanClose: false,
    });
    await vi.waitFor(() => expect(mocks.clients).toHaveLength(2));

    expect(mocks.clients[1]?.updateNodeManifest).toHaveBeenCalledWith(manifest);
  });

  it("does not create the queued candidate after stop", async () => {
    const { connection } = createConnection();

    mocks.options[0]?.onClose?.(1006, "transport unavailable", {
      phase: "pre-hello",
      socketOpened: false,
      transportValidated: false,
      connectRequestSent: false,
      transientPreHelloCleanClose: false,
    });
    connection.stop();
    await Promise.resolve();

    expect(mocks.clients).toHaveLength(1);
  });

  it("never carries origin-bound Access credentials to another candidate host", async () => {
    const credentials = { clientId: "cf-pinned-id", clientSecret: "cf-pinned-secret" };
    createConnection(new Map([[candidates[0]!, credentials]]));

    expect(mocks.options[0]?.cloudflareAccess).toEqual(credentials);
    mocks.options[0]?.onClose?.(1006, "transport unavailable", {
      phase: "pre-hello",
      socketOpened: false,
      transportValidated: false,
      connectRequestSent: false,
      transientPreHelloCleanClose: false,
    });
    await vi.waitFor(() => expect(mocks.clients).toHaveLength(2));

    expect(mocks.options[1]?.url).toBe("wss://gateway.tailnet.example:443");
    expect(mocks.options[1]?.cloudflareAccess).toBeUndefined();
  });
});

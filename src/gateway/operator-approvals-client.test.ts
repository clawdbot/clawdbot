import { beforeEach, describe, expect, it, vi } from "vitest";

const clientState = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  startMode: "hello" as "hello" | "close",
  close: { code: 1008, reason: "pairing required" },
  requestSpy: vi.fn(),
  stopSpy: vi.fn(),
  stopAndWaitSpy: vi.fn(async () => undefined),
}));

class MockGatewayClient {
  private readonly opts: Record<string, unknown>;

  constructor(opts: Record<string, unknown>) {
    this.opts = opts;
    clientState.options = opts;
  }

  start(): void {
    void Promise.resolve()
      .then(async () => {
        if (clientState.startMode === "close") {
          const onClose = this.opts.onClose;
          if (typeof onClose === "function") {
            onClose(clientState.close.code, clientState.close.reason);
          }
          return;
        }
        const onHelloOk = this.opts.onHelloOk;
        if (typeof onHelloOk === "function") {
          await onHelloOk();
        }
      })
      .catch(() => {});
  }

  async request(method: string, params: unknown): Promise<unknown> {
    return await clientState.requestSpy(method, params);
  }

  stop(): void {
    clientState.stopSpy();
  }

  async stopAndWait(): Promise<void> {
    await clientState.stopAndWaitSpy();
  }
}

vi.mock("./client-bootstrap.js", () => ({
  resolveGatewayClientBootstrap: vi.fn(async () => ({
    url: "ws://127.0.0.1:18789",
    auth: { token: "secret", password: undefined },
  })),
}));

vi.mock("./client.js", () => ({
  GatewayClient: MockGatewayClient,
}));

const { withOperatorApprovalsGatewayClient } = await import("./operator-approvals-client.js");

describe("withOperatorApprovalsGatewayClient", () => {
  beforeEach(() => {
    clientState.options = null;
    clientState.startMode = "hello";
    clientState.close = { code: 1008, reason: "pairing required" };
    clientState.requestSpy.mockReset().mockResolvedValue(undefined);
    clientState.stopSpy.mockReset();
    clientState.stopAndWaitSpy.mockReset().mockResolvedValue(undefined);
  });

  it("waits for hello before running the callback and stops cleanly", async () => {
    await withOperatorApprovalsGatewayClient(
      {
        config: {} as never,
        clientDisplayName: "Matrix approval (@owner:example.org)",
      },
      async (client) => {
        await client.request("exec.approval.resolve", {
          id: "req-123",
          decision: "allow-once",
        });
      },
    );

    expect(clientState.options?.scopes).toEqual(["operator.approvals"]);
    expect(clientState.requestSpy).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "req-123",
      decision: "allow-once",
    });
    expect(clientState.stopAndWaitSpy).toHaveBeenCalledTimes(1);
  });

  it("surfaces close failures before hello", async () => {
    clientState.startMode = "close";

    await expect(
      withOperatorApprovalsGatewayClient(
        {
          config: {} as never,
          clientDisplayName: "Matrix approval (@owner:example.org)",
        },
        async () => undefined,
      ),
    ).rejects.toThrow("gateway closed (1008): pairing required");
  });

  it("falls back to stop when stopAndWait rejects", async () => {
    clientState.stopAndWaitSpy.mockRejectedValueOnce(new Error("close failed"));

    await withOperatorApprovalsGatewayClient(
      {
        config: {} as never,
        clientDisplayName: "Matrix approval (@owner:example.org)",
      },
      async () => undefined,
    );

    expect(clientState.stopAndWaitSpy).toHaveBeenCalledTimes(1);
    expect(clientState.stopSpy).toHaveBeenCalledTimes(1);
  });
});

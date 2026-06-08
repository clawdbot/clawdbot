// Operator approvals client tests cover connect lifecycle, request framing,
// scope-upgrade errors, and graceful shutdown behavior for approval operations.
import { beforeEach, describe, expect, it, vi } from "vitest";

const clientState = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  startMode: "hello" as "hello" | "close",
  close: { code: 1008, reason: "pairing required" },
  requestSpy: vi.fn(),
  stopSpy: vi.fn(),
  stopAndWaitSpy: vi.fn(async () => undefined),
}));

const bootstrapState = vi.hoisted(() => ({
  url: "ws://127.0.0.1:18789",
  urlSource: "local loopback",
  auth: { token: "secret" as string | undefined, password: undefined as string | undefined },
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
    url: bootstrapState.url,
    urlSource: bootstrapState.urlSource,
    auth: bootstrapState.auth,
  })),
}));

vi.mock("./client.js", () => ({
  GatewayClient: MockGatewayClient,
}));

const { withOperatorApprovalsGatewayClient } = await import("./operator-approvals-client.js");

const DEFAULT_APPROVAL_CLIENT_DISPLAY_NAME = "Matrix approval (@owner:example.org)";

async function runOperatorApprovalsGatewayClient(
  params: { gatewayUrl?: string } = {},
  callback: Parameters<typeof withOperatorApprovalsGatewayClient>[1] = async () => undefined,
) {
  await withOperatorApprovalsGatewayClient(
    {
      config: {} as never,
      clientDisplayName: DEFAULT_APPROVAL_CLIENT_DISPLAY_NAME,
      ...params,
    },
    callback,
  );
}

function expectRuntimeTokenApprovalClient(): void {
  expect(typeof clientState.options?.approvalRuntimeToken).toBe("string");
  expect(clientState.options?.deviceIdentity).toBeNull();
}

describe("withOperatorApprovalsGatewayClient", () => {
  beforeEach(() => {
    clientState.options = null;
    clientState.startMode = "hello";
    clientState.close = { code: 1008, reason: "pairing required" };
    clientState.requestSpy.mockReset().mockResolvedValue(undefined);
    clientState.stopSpy.mockReset();
    clientState.stopAndWaitSpy.mockReset().mockResolvedValue(undefined);
    bootstrapState.url = "ws://127.0.0.1:18789";
    bootstrapState.urlSource = "local loopback";
    bootstrapState.auth = { token: "secret", password: undefined };
  });

  it("waits for hello before running the callback and stops cleanly", async () => {
    await runOperatorApprovalsGatewayClient({}, async (client) => {
      await client.request("exec.approval.resolve", {
        id: "req-123",
        decision: "allow-once",
      });
    });

    expect(clientState.options?.scopes).toEqual(["operator.approvals"]);
    expect(typeof clientState.options?.approvalRuntimeToken).toBe("string");
    expect(clientState.options?.deviceIdentity).toBeNull();
    expect(clientState.requestSpy).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "req-123",
      decision: "allow-once",
    });
    expect(clientState.stopAndWaitSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps device identity and omits approval runtime token for remote shared-auth approval clients", async () => {
    bootstrapState.url = "wss://gateway.example/ws";
    bootstrapState.urlSource = "config gateway.remote.url";

    await runOperatorApprovalsGatewayClient();

    expect(clientState.options).not.toHaveProperty("deviceIdentity", null);
    expect(clientState.options?.deviceIdentity).toBeUndefined();
    expect(clientState.options).not.toHaveProperty("approvalRuntimeToken");
  });

  it("keeps device identity for env loopback approval clients without runtime authority", async () => {
    bootstrapState.url = "ws://127.0.0.1:18789";
    bootstrapState.urlSource = "env OPENCLAW_GATEWAY_URL";

    await runOperatorApprovalsGatewayClient();

    expect(clientState.options?.deviceIdentity).toBeUndefined();
    expect(clientState.options).not.toHaveProperty("approvalRuntimeToken");
  });

  it.each([
    {
      name: "explicit loopback gateway URL overrides",
      url: "ws://127.0.0.1:18789",
      urlSource: "cli --url",
      gatewayUrl: "ws://127.0.0.1:18789",
    },
    {
      name: "remote explicit gateway URL overrides",
      url: "wss://gateway.example/ws",
      urlSource: "cli --url",
      gatewayUrl: "wss://gateway.example/ws",
    },
    {
      name: "configured remote loopback gateway URLs",
      url: "ws://127.0.0.1:18789",
      urlSource: "config gateway.remote.url",
    },
    {
      name: "env loopback gateway URL overrides",
      url: "ws://127.0.0.1:18789",
      urlSource: "env OPENCLAW_GATEWAY_URL",
    },
  ])("omits approval runtime token for $name", async ({ url, urlSource, gatewayUrl }) => {
    bootstrapState.url = url;
    bootstrapState.urlSource = urlSource;

    await runOperatorApprovalsGatewayClient(gatewayUrl ? { gatewayUrl } : {});
    expect(clientState.options).not.toHaveProperty("approvalRuntimeToken");
  });

  it("keeps approval runtime token for local fallback gateway URLs", async () => {
    bootstrapState.url = "ws://127.0.0.1:18789";
    bootstrapState.urlSource = "missing gateway.remote.url (fallback local)";

    await runOperatorApprovalsGatewayClient();

    expectRuntimeTokenApprovalClient();
  });

  it("omits stored device identity for local runtime-token approval clients without shared auth", async () => {
    bootstrapState.auth = { token: undefined, password: undefined };

    await runOperatorApprovalsGatewayClient();

    expectRuntimeTokenApprovalClient();
  });

  it("surfaces close failures before hello", async () => {
    clientState.startMode = "close";

    await expect(runOperatorApprovalsGatewayClient()).rejects.toThrow(
      "gateway closed (1008): pairing required",
    );
  });

  it("falls back to stop when stopAndWait rejects", async () => {
    clientState.stopAndWaitSpy.mockRejectedValueOnce(new Error("close failed"));

    await runOperatorApprovalsGatewayClient();

    expect(clientState.stopAndWaitSpy).toHaveBeenCalledTimes(1);
    expect(clientState.stopSpy).toHaveBeenCalledTimes(1);
  });
});

// Matrix tests cover client plugin behavior.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockMatrixClient,
  expectExplicitMatrixClientConfig,
  expectOneOffSharedMatrixClient,
  matrixClientResolverMocks,
  primeMatrixClientResolverMocks,
  setAcquiredMatrixClient,
} from "../client-resolver.test-helpers.js";

const resolveMatrixRoomIdMock = vi.fn();

const {
  getMatrixRuntimeMock,
  acquireSharedMatrixClientMock,
  sharedLeaseReleaseMock,
  resolveMatrixAuthContextMock,
} = matrixClientResolverMocks;

const TEST_CFG = {};

vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => getMatrixRuntimeMock(),
}));

vi.mock("../client.js", () => ({
  acquireSharedMatrixClient: acquireSharedMatrixClientMock,
  resolveMatrixAuthContext: resolveMatrixAuthContextMock,
}));

vi.mock("../send.js", () => ({
  resolveMatrixRoomId: (...args: unknown[]) => resolveMatrixRoomIdMock(...args),
}));

let withResolvedActionClient: typeof import("./client.js").withResolvedActionClient;
let withResolvedRoomAction: typeof import("./client.js").withResolvedRoomAction;
let withStartedActionClient: typeof import("./client.js").withStartedActionClient;

describe("action client helpers", () => {
  beforeAll(async () => {
    ({ withResolvedActionClient, withResolvedRoomAction, withStartedActionClient } =
      await import("./client.js"));
  });

  beforeEach(() => {
    primeMatrixClientResolverMocks();
    resolveMatrixRoomIdMock
      .mockReset()
      .mockImplementation(async (_client, roomId: string) => roomId);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("borrows and releases one-off action clients", async () => {
    const result = await withResolvedActionClient(
      { cfg: TEST_CFG, accountId: "default" },
      async () => "ok",
    );

    await expectOneOffSharedMatrixClient();
    expect(result).toBe("ok");
  });

  it("forwards the transient retirement signal to action work", async () => {
    const sharedClient = createMockMatrixClient();
    const lease = setAcquiredMatrixClient(sharedClient);

    await withResolvedActionClient(
      { cfg: TEST_CFG, accountId: "default" },
      async (_client, abortSignal) => {
        expect(abortSignal).toBe(lease.abortSignal);
      },
    );
  });

  it("skips preparation when readiness is disabled", async () => {
    await withResolvedActionClient(
      { cfg: TEST_CFG, accountId: "default", readiness: "none" },
      async () => {},
    );

    const lease = await acquireSharedMatrixClientMock.mock.results[0]?.value;
    expect(lease.client.prepareForOneOff).not.toHaveBeenCalled();
    expect(lease.client.start).not.toHaveBeenCalled();
    expect(sharedLeaseReleaseMock).toHaveBeenCalledWith({ mode: "stop" });
  });

  it("starts through the lease and persists started action clients", async () => {
    await withStartedActionClient({ cfg: TEST_CFG, accountId: "default" }, async () => {});

    await expectOneOffSharedMatrixClient({
      prepareForOneOffCalls: 0,
      startCalls: 1,
      releaseMode: "persist",
    });
  });

  it("uses the implicit resolved account id for shared acquisition", async () => {
    resolveMatrixAuthContextMock.mockReturnValue({
      cfg: TEST_CFG,
      env: process.env,
      accountId: "ops",
      resolved: {},
    });

    await withResolvedActionClient({ cfg: TEST_CFG }, async () => {});

    await expectOneOffSharedMatrixClient({ accountId: "ops" });
  });

  it("uses explicit cfg instead of loading runtime config", async () => {
    const explicitCfg = {
      channels: {
        matrix: {
          defaultAccount: "ops",
        },
      },
    };

    await withResolvedActionClient({ cfg: explicitCfg, accountId: "ops" }, async () => {});

    expectExplicitMatrixClientConfig({
      cfg: explicitCfg,
      accountId: "ops",
    });
  });

  it("releases shared action clients with the requested discard mode", async () => {
    const sharedClient = createMockMatrixClient();
    setAcquiredMatrixClient(sharedClient);

    await withResolvedActionClient(
      { cfg: TEST_CFG, accountId: "default" },
      async (client) => {
        expect(client).toBe(sharedClient);
      },
      "discard",
    );

    expect(sharedLeaseReleaseMock).toHaveBeenCalledWith({ mode: "discard" });
  });

  it("releases shared action clients when the wrapped call throws", async () => {
    const sharedClient = createMockMatrixClient();
    setAcquiredMatrixClient(sharedClient);

    await expect(
      withResolvedActionClient({ cfg: TEST_CFG, accountId: "default" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(sharedLeaseReleaseMock).toHaveBeenCalledWith({ mode: "stop" });
  });

  it("does not borrow an explicitly injected action client", async () => {
    const injected = createMockMatrixClient();

    await withResolvedActionClient({ client: injected }, async (client) => {
      expect(client).toBe(injected);
    });

    expect(acquireSharedMatrixClientMock).not.toHaveBeenCalled();
    expect(sharedLeaseReleaseMock).not.toHaveBeenCalled();
  });

  it("resolves room ids before running wrapped room actions", async () => {
    const sharedClient = createMockMatrixClient();
    const lease = setAcquiredMatrixClient(sharedClient);
    resolveMatrixRoomIdMock.mockResolvedValue("!room:example.org");

    const result = await withResolvedRoomAction(
      "room:#ops:example.org",
      { cfg: TEST_CFG, accountId: "default" },
      async (client, resolvedRoom, abortSignal) => {
        expect(client).toBe(sharedClient);
        expect(abortSignal).toBe(lease.abortSignal);
        return resolvedRoom;
      },
    );

    expect(resolveMatrixRoomIdMock).toHaveBeenCalledWith(sharedClient, "room:#ops:example.org");
    expect(result).toBe("!room:example.org");
    expect(sharedLeaseReleaseMock).toHaveBeenCalledWith({ mode: "stop" });
  });
});

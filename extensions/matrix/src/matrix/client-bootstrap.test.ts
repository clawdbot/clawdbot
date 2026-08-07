// Matrix tests cover client bootstrap plugin behavior.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockMatrixClient,
  matrixClientResolverMocks,
  primeMatrixClientResolverMocks,
  setAcquiredMatrixClient,
} from "./client-resolver.test-helpers.js";

const {
  getMatrixRuntimeMock,
  acquireSharedMatrixClientMock,
  sharedLeaseReleaseMock,
  isBunRuntimeMock,
  resolveMatrixAuthContextMock,
} = matrixClientResolverMocks;

const TEST_CFG = {};

vi.mock("../runtime.js", () => ({
  getMatrixRuntime: () => getMatrixRuntimeMock(),
}));

vi.mock("./client.js", () => ({
  acquireSharedMatrixClient: (...args: unknown[]) => acquireSharedMatrixClientMock(...args),
  isBunRuntime: () => isBunRuntimeMock(),
  resolveMatrixAuthContext: resolveMatrixAuthContextMock,
}));

let resolveRuntimeMatrixClientWithReadiness: typeof import("./client-bootstrap.js").resolveRuntimeMatrixClientWithReadiness;
let withResolvedRuntimeMatrixClient: typeof import("./client-bootstrap.js").withResolvedRuntimeMatrixClient;

describe("client bootstrap", () => {
  beforeAll(async () => {
    ({ resolveRuntimeMatrixClientWithReadiness, withResolvedRuntimeMatrixClient } =
      await import("./client-bootstrap.js"));
  });

  beforeEach(() => {
    primeMatrixClientResolverMocks({ resolved: {} });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("releases leased shared clients when readiness setup fails", async () => {
    const prepareForOneOff = vi.fn(async () => undefined);
    const sharedClient = Object.assign(createMockMatrixClient(), { prepareForOneOff });
    prepareForOneOff.mockRejectedValue(new Error("prepare failed"));
    setAcquiredMatrixClient(sharedClient);

    await expect(
      resolveRuntimeMatrixClientWithReadiness({
        cfg: TEST_CFG,
        accountId: "default",
        readiness: "prepared",
      }),
    ).rejects.toThrow("prepare failed");

    expect(sharedLeaseReleaseMock).toHaveBeenCalledWith({ mode: "stop" });
  });

  it("starts through the shared lease and releases when startup fails", async () => {
    const start = vi.fn(async () => undefined);
    const sharedClient = Object.assign(createMockMatrixClient(), { start });
    start.mockRejectedValue(new Error("start failed"));
    setAcquiredMatrixClient(sharedClient);

    await expect(
      withResolvedRuntimeMatrixClient(
        {
          cfg: TEST_CFG,
          accountId: "default",
          readiness: "started",
        },
        async () => "ok",
      ),
    ).rejects.toThrow("start failed");

    expect(sharedLeaseReleaseMock).toHaveBeenCalledWith({ mode: "stop" });
  });

  it("borrows every non-injected client from the shared owner", async () => {
    const sharedClient = createMockMatrixClient();
    setAcquiredMatrixClient(sharedClient);

    await withResolvedRuntimeMatrixClient(
      { cfg: TEST_CFG, accountId: "default", readiness: "none" },
      async (client) => {
        expect(client).toBe(sharedClient);
      },
      "persist",
    );

    expect(acquireSharedMatrixClientMock).toHaveBeenCalledWith({
      cfg: TEST_CFG,
      timeoutMs: undefined,
      accountId: "default",
      startClient: false,
      role: "transient",
    });
    expect(sharedLeaseReleaseMock).toHaveBeenCalledWith({ mode: "persist" });
  });

  it("passes the transient retirement signal to admitted work", async () => {
    const sharedClient = createMockMatrixClient();
    const lease = setAcquiredMatrixClient(sharedClient);

    await withResolvedRuntimeMatrixClient(
      { cfg: TEST_CFG, accountId: "default", readiness: "none" },
      async (client, abortSignal) => {
        expect(client).toBe(sharedClient);
        expect(abortSignal).toBe(lease.abortSignal);
      },
    );
  });

  it("does not borrow or stop an explicitly injected client", async () => {
    const start = vi.fn(async () => undefined);
    const injected = Object.assign(createMockMatrixClient(), { start });

    await withResolvedRuntimeMatrixClient(
      { client: injected, readiness: "started" },
      async (client) => {
        expect(client).toBe(injected);
      },
      "persist",
    );

    expect(start).toHaveBeenCalledTimes(1);
    expect(acquireSharedMatrixClientMock).not.toHaveBeenCalled();
    expect(sharedLeaseReleaseMock).not.toHaveBeenCalled();
  });
});

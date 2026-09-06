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

const {
  getMatrixRuntimeMock,
  acquireSharedMatrixClientMock,
  sharedLeaseReleaseMock,
  isBunRuntimeMock,
  resolveMatrixAuthContextMock,
} = matrixClientResolverMocks;

const TEST_CFG = {};

vi.mock("../client.js", () => ({
  acquireSharedMatrixClient: (...args: unknown[]) => acquireSharedMatrixClientMock(...args),
  isBunRuntime: () => isBunRuntimeMock(),
  resolveMatrixAuthContext: resolveMatrixAuthContextMock,
}));

vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => getMatrixRuntimeMock(),
}));

let withResolvedMatrixControlClient: typeof import("./client.js").withResolvedMatrixControlClient;
let withResolvedMatrixSendClient: typeof import("./client.js").withResolvedMatrixSendClient;

describe("matrix send client helpers", () => {
  beforeAll(async () => {
    ({ withResolvedMatrixControlClient, withResolvedMatrixSendClient } =
      await import("./client.js"));
  });

  beforeEach(() => {
    primeMatrixClientResolverMocks({ resolved: {} });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("starts and persists borrowed send clients", async () => {
    const result = await withResolvedMatrixSendClient(
      { cfg: TEST_CFG, accountId: "default" },
      async () => "ok",
    );

    await expectOneOffSharedMatrixClient({
      prepareForOneOffCalls: 0,
      startCalls: 1,
      releaseMode: "persist",
    });
    expect(result).toBe("ok");
  });

  it("forwards the transient retirement signal to send work", async () => {
    const sharedClient = createMockMatrixClient();
    const lease = setAcquiredMatrixClient(sharedClient);

    await withResolvedMatrixSendClient(
      { cfg: TEST_CFG, accountId: "default" },
      async (_client, abortSignal) => {
        expect(abortSignal).toBe(lease.abortSignal);
      },
    );
  });

  it("uses the effective account id when auth resolution is implicit", async () => {
    resolveMatrixAuthContextMock.mockReturnValue({
      cfg: TEST_CFG,
      env: process.env,
      accountId: "ops",
      resolved: {},
    });

    await withResolvedMatrixSendClient({ cfg: TEST_CFG }, async () => {});

    await expectOneOffSharedMatrixClient({
      accountId: "ops",
      prepareForOneOffCalls: 0,
      startCalls: 1,
      releaseMode: "persist",
    });
  });

  it("uses explicit cfg instead of loading runtime config", async () => {
    const explicitCfg = {
      channels: {
        matrix: {
          defaultAccount: "ops",
        },
      },
    };

    await withResolvedMatrixSendClient({ cfg: explicitCfg, accountId: "ops" }, async () => {});

    expectExplicitMatrixClientConfig({
      cfg: explicitCfg,
      accountId: "ops",
    });
  });

  it("persists borrowed send clients when wrapped sends fail", async () => {
    const sharedClient = createMockMatrixClient();
    setAcquiredMatrixClient(sharedClient);

    await expect(
      withResolvedMatrixSendClient({ cfg: TEST_CFG, accountId: "default" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(sharedLeaseReleaseMock).toHaveBeenCalledWith({ mode: "persist" });
  });

  it("keeps borrowed control clients unstarted and releases without persistence", async () => {
    const result = await withResolvedMatrixControlClient(
      { cfg: TEST_CFG, accountId: "default" },
      async () => "ok",
    );

    await expectOneOffSharedMatrixClient({
      prepareForOneOffCalls: 0,
      startCalls: 0,
      releaseMode: "stop",
    });
    expect(result).toBe("ok");
  });

  it("does not borrow or stop explicitly injected clients", async () => {
    const start = vi.fn(async () => undefined);
    const injected = Object.assign(createMockMatrixClient(), { start });

    await withResolvedMatrixSendClient({ client: injected }, async (client) => {
      expect(client).toBe(injected);
    });
    await withResolvedMatrixControlClient({ client: injected }, async (client) => {
      expect(client).toBe(injected);
    });

    expect(start).not.toHaveBeenCalled();
    expect(acquireSharedMatrixClientMock).not.toHaveBeenCalled();
    expect(sharedLeaseReleaseMock).not.toHaveBeenCalled();
  });
});

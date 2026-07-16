import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockMatrixClient,
  expectExplicitMatrixClientConfig,
  expectOneOffSharedMatrixClient,
  matrixClientResolverMocks,
  primeMatrixClientResolverMocks,
} from "../client-resolver.test-helpers.js";

const {
  getMatrixRuntimeMock,
  getActiveMatrixClientMock,
  acquireSharedMatrixClientMock,
  releaseSharedClientInstanceMock,
  isBunRuntimeMock,
  resolveMatrixAuthContextMock,
} = matrixClientResolverMocks;

vi.mock("../active-client.js", () => ({
  getActiveMatrixClient: (...args: unknown[]) => getActiveMatrixClientMock(...args),
}));

vi.mock("../client.js", () => ({
  acquireSharedMatrixClient: (...args: unknown[]) => acquireSharedMatrixClientMock(...args),
  isBunRuntime: () => isBunRuntimeMock(),
  resolveMatrixAuthContext: resolveMatrixAuthContextMock,
}));

vi.mock("../client/shared.js", () => ({
  releaseSharedClientInstance: (...args: unknown[]) => releaseSharedClientInstanceMock(...args),
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
    primeMatrixClientResolverMocks({
      resolved: {},
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stops one-off shared clients when no active monitor client is registered", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "18799");

    const result = await withResolvedMatrixSendClient({ accountId: "default" }, async () => "ok");

    await expectOneOffSharedMatrixClient({
      prepareForOneOffCalls: 0,
      startCalls: 1,
      releaseMode: "persist",
    });
    expect(result).toBe("ok");
  });

  it("reuses active monitor client when available", async () => {
    const activeClient = createMockMatrixClient();
    getActiveMatrixClientMock.mockReturnValue(activeClient);

    const result = await withResolvedMatrixSendClient({ accountId: "default" }, async (client) => {
      expect(client).toBe(activeClient);
      return "ok";
    });

    expect(result).toBe("ok");
    expect(acquireSharedMatrixClientMock).not.toHaveBeenCalled();
    expect(activeClient.start).toHaveBeenCalledTimes(1);
    expect(activeClient.stop).not.toHaveBeenCalled();
    expect(activeClient.stopAndPersist).not.toHaveBeenCalled();
  });

  it("uses the effective account id when auth resolution is implicit", async () => {
    resolveMatrixAuthContextMock.mockReturnValue({
      cfg: {},
      env: process.env,
      accountId: "ops",
      resolved: {},
    });
    await withResolvedMatrixSendClient({}, async () => {});

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

  it("stops shared matrix clients when wrapped sends fail", async () => {
    const sharedClient = createMockMatrixClient();
    acquireSharedMatrixClientMock.mockResolvedValue(sharedClient);

    await expect(
      withResolvedMatrixSendClient({ accountId: "default" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(releaseSharedClientInstanceMock).toHaveBeenCalledWith(sharedClient, "persist");
  });

  it("starts one-off clients before outbound sends so encrypted rooms can reuse live crypto state", async () => {
    const sharedClient = createMockMatrixClient();
    acquireSharedMatrixClientMock.mockResolvedValue(sharedClient);

    await withResolvedMatrixSendClient({ accountId: "default" }, async () => "ok");

    expect(sharedClient.start).toHaveBeenCalledTimes(1);
    expect(sharedClient.prepareForOneOff).not.toHaveBeenCalled();
  });

  it("keeps one-off control clients lightweight when no active monitor client is registered", async () => {
    const result = await withResolvedMatrixControlClient(
      { accountId: "default" },
      async () => "ok",
    );

    await expectOneOffSharedMatrixClient({
      prepareForOneOffCalls: 0,
      startCalls: 0,
      releaseMode: "stop",
    });
    expect(result).toBe("ok");
  });

  it("reuses active monitor clients for control operations without restarting them", async () => {
    const activeClient = createMockMatrixClient();
    getActiveMatrixClientMock.mockReturnValue(activeClient);

    const result = await withResolvedMatrixControlClient(
      { accountId: "default" },
      async (client) => {
        expect(client).toBe(activeClient);
        return "ok";
      },
    );

    expect(result).toBe("ok");
    expect(acquireSharedMatrixClientMock).not.toHaveBeenCalled();
    expect(activeClient.start).not.toHaveBeenCalled();
    expect(activeClient.stop).not.toHaveBeenCalled();
    expect(activeClient.stopAndPersist).not.toHaveBeenCalled();
  });
});

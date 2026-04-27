import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockMatrixClient,
  expectExplicitMatrixClientConfig,
  expectOneOffSharedMatrixClient,
  matrixClientResolverMocks,
  primeMatrixClientResolverMocks,
} from "../client-resolver.test-helpers.js";

const resolveMatrixRoomIdMock = vi.fn();

const {
  loadConfigMock,
  getMatrixRuntimeMock,
  getActiveMatrixClientMock,
  acquireSharedMatrixClientMock,
  releaseSharedClientInstanceMock,
  isBunRuntimeMock,
  resolveMatrixAuthContextMock,
} = matrixClientResolverMocks;

const TEST_CFG = {};

vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => getMatrixRuntimeMock(),
}));

vi.mock("../active-client.js", () => ({
  getActiveMatrixClient: getActiveMatrixClientMock,
}));

vi.mock("../client.js", () => ({
  acquireSharedMatrixClient: acquireSharedMatrixClientMock,
  isBunRuntime: () => isBunRuntimeMock(),
  resolveMatrixAuthContext: resolveMatrixAuthContextMock,
}));

vi.mock("../client/shared.js", () => ({
  releaseSharedClientInstance: (...args: unknown[]) => releaseSharedClientInstanceMock(...args),
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

  it("stops one-off shared clients when no active monitor client is registered", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "18799");

    const result = await withResolvedActionClient(
      { cfg: TEST_CFG, accountId: "default" },
      async () => "ok",
    );

    await expectOneOffSharedMatrixClient();
    expect(result).toBe("ok");
  });

  it("skips one-off room preparation when readiness is disabled", async () => {
    await withResolvedActionClient(
      { cfg: TEST_CFG, accountId: "default", readiness: "none" },
      async () => {},
    );

    const sharedClient = await acquireSharedMatrixClientMock.mock.results[0]?.value;
    expect(sharedClient.prepareForOneOff).not.toHaveBeenCalled();
    expect(sharedClient.start).not.toHaveBeenCalled();
    expect(releaseSharedClientInstanceMock).toHaveBeenCalledWith(sharedClient, "stop");
  });

  it("starts one-off clients when started readiness is required", async () => {
    await withStartedActionClient({ cfg: TEST_CFG, accountId: "default" }, async () => {});

    const sharedClient = await acquireSharedMatrixClientMock.mock.results[0]?.value;
    expect(sharedClient.start).toHaveBeenCalledTimes(1);
    expect(sharedClient.prepareForOneOff).not.toHaveBeenCalled();
    expect(releaseSharedClientInstanceMock).toHaveBeenCalledWith(sharedClient, "persist");
  });

  it("reuses active monitor client when available", async () => {
    const activeClient = createMockMatrixClient();
    getActiveMatrixClientMock.mockReturnValue(activeClient);

    const result = await withResolvedActionClient(
      { cfg: TEST_CFG, accountId: "default" },
      async (client) => {
        expect(client).toBe(activeClient);
        return "ok";
      },
    );

    expect(result).toBe("ok");
    expect(acquireSharedMatrixClientMock).not.toHaveBeenCalled();
    expect(activeClient.stop).not.toHaveBeenCalled();
  });

  it("starts active clients when started readiness is required", async () => {
    const activeClient = createMockMatrixClient();
    getActiveMatrixClientMock.mockReturnValue(activeClient);

    await withStartedActionClient({ cfg: TEST_CFG, accountId: "default" }, async (client) => {
      expect(client).toBe(activeClient);
    });

    expect(activeClient.start).toHaveBeenCalledTimes(1);
    expect(activeClient.prepareForOneOff).not.toHaveBeenCalled();
    expect(activeClient.stop).not.toHaveBeenCalled();
    expect(activeClient.stopAndPersist).not.toHaveBeenCalled();
  });

  it("uses the implicit resolved account id for active client lookup and storage", async () => {
    loadConfigMock.mockReturnValue({
      channels: {
        matrix: {
          accounts: {
            ops: {
              homeserver: "https://ops.example.org",
              userId: "@ops:example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    });
    resolveMatrixAuthContextMock.mockReturnValue({
      cfg: loadConfigMock(),
      env: process.env,
      accountId: "ops",
      resolved: {
        homeserver: "https://ops.example.org",
        userId: "@ops:example.org",
        accessToken: "ops-token",
        deviceId: "OPSDEVICE",
        encryption: true,
      },
    });
    await withResolvedActionClient({ cfg: loadConfigMock() as never }, async () => {});

    await expectOneOffSharedMatrixClient({
      cfg: loadConfigMock(),
      accountId: "ops",
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

    await withResolvedActionClient({ cfg: explicitCfg, accountId: "ops" }, async () => {});

    expectExplicitMatrixClientConfig({
      cfg: explicitCfg,
      accountId: "ops",
    });
  });

  it("stops shared action clients after wrapped calls succeed", async () => {
    const sharedClient = createMockMatrixClient();
    acquireSharedMatrixClientMock.mockResolvedValue(sharedClient);

    const result = await withResolvedActionClient(
      { cfg: TEST_CFG, accountId: "default" },
      async (client) => {
        expect(client).toBe(sharedClient);
        return "ok";
      },
    );

    expect(result).toBe("ok");
    expect(releaseSharedClientInstanceMock).toHaveBeenCalledWith(sharedClient, "stop");
  });

  it("can discard read-only shared action clients without persisting crypto state", async () => {
    const sharedClient = createMockMatrixClient();
    acquireSharedMatrixClientMock.mockResolvedValue(sharedClient);

    const result = await withResolvedActionClient(
      { cfg: TEST_CFG, accountId: "default" },
      async (client) => {
        expect(client).toBe(sharedClient);
        return "ok";
      },
      "discard",
    );

    expect(result).toBe("ok");
    expect(releaseSharedClientInstanceMock).toHaveBeenCalledWith(sharedClient, "discard");
  });

  it("stops shared action clients when the wrapped call throws", async () => {
    const sharedClient = createMockMatrixClient();
    acquireSharedMatrixClientMock.mockResolvedValue(sharedClient);

    await expect(
      withResolvedActionClient({ cfg: TEST_CFG, accountId: "default" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(releaseSharedClientInstanceMock).toHaveBeenCalledWith(sharedClient, "stop");
  });

  it("resolves room ids before running wrapped room actions", async () => {
    const sharedClient = createMockMatrixClient();
    acquireSharedMatrixClientMock.mockResolvedValue(sharedClient);
    resolveMatrixRoomIdMock.mockResolvedValue("!room:example.org");

    const result = await withResolvedRoomAction(
      "room:#ops:example.org",
      { cfg: TEST_CFG, accountId: "default" },
      async (client, resolvedRoom) => {
        expect(client).toBe(sharedClient);
        return resolvedRoom;
      },
    );

    expect(resolveMatrixRoomIdMock).toHaveBeenCalledWith(sharedClient, "room:#ops:example.org");
    expect(result).toBe("!room:example.org");
    expect(releaseSharedClientInstanceMock).toHaveBeenCalledWith(sharedClient, "stop");
  });
});

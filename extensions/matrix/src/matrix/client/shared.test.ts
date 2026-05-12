import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixAuth } from "./types.js";

const resolveMatrixAuthMock = vi.hoisted(() => vi.fn());
const resolveMatrixAuthContextMock = vi.hoisted(() => vi.fn());
const createMatrixClientMock = vi.hoisted(() => vi.fn());

const TEST_CFG = {};

vi.mock("./config.js", () => ({
  resolveMatrixAuth: resolveMatrixAuthMock,
  resolveMatrixAuthContext: resolveMatrixAuthContextMock,
}));

vi.mock("./create-client.js", () => ({
  createMatrixClient: createMatrixClientMock,
}));

let acquireSharedMatrixClient: typeof import("./shared.js").acquireSharedMatrixClient;
let releaseSharedClientInstance: typeof import("./shared.js").releaseSharedClientInstance;
let resolveSharedMatrixClient: typeof import("./shared.js").resolveSharedMatrixClient;
let stopSharedClient: typeof import("./shared.js").stopSharedClient;
let stopSharedClientForAccount: typeof import("./shared.js").stopSharedClientForAccount;
let stopSharedClientInstance: typeof import("./shared.js").stopSharedClientInstance;

function authFor(accountId: string): MatrixAuth {
  return {
    accountId,
    homeserver: "https://matrix.example.org",
    userId: `@${accountId}:example.org`,
    accessToken: `token-${accountId}`,
    password: "secret", // pragma: allowlist secret
    deviceId: `${accountId.toUpperCase()}-DEVICE`,
    deviceName: `${accountId} device`,
    initialSyncLimit: undefined,
    encryption: false,
  };
}

async function expectMatrixStartupAbort(promise: Promise<unknown>): Promise<void> {
  let rejection: unknown;
  try {
    await promise;
  } catch (error) {
    rejection = error;
  }

  expect(rejection).toBeInstanceOf(Error);
  const error = rejection as Error;
  expect(error.name).toBe("AbortError");
  expect(error.message).toBe("Matrix startup aborted");
}

function createMockClient(name: string) {
  const client = {
    name,
    start: vi.fn(async () => undefined),
    stop: vi.fn(() => undefined),
    getJoinedRooms: vi.fn(async () => [] as string[]),
    crypto: undefined,
  };
  return client;
}

function primeAccountClientMocks(params?: {
  mainAuth?: MatrixAuth;
  opsAuth?: MatrixAuth;
  mainClient?: ReturnType<typeof createMockClient>;
  opsClient?: ReturnType<typeof createMockClient>;
}) {
  const mainAuth = params?.mainAuth ?? authFor("main");
  const opsAuth = params?.opsAuth ?? authFor("ops");
  const mainClient = params?.mainClient ?? createMockClient("main");
  const opsClient = params?.opsClient ?? createMockClient("ops");

  resolveMatrixAuthMock.mockImplementation(async ({ accountId }: { accountId?: string }) =>
    accountId === "ops" ? opsAuth : mainAuth,
  );
  createMatrixClientMock.mockImplementation(async ({ accountId }: { accountId?: string }) => {
    if (accountId === "ops") {
      return opsClient;
    }
    return mainClient;
  });

  return { mainAuth, opsAuth, mainClient, opsClient };
}

function createPendingSharedStartup(mainAuth = authFor("main")) {
  let resolveStartup: (() => void) | undefined;
  const mainClient = {
    ...createMockClient("main"),
    start: vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          resolveStartup = resolve;
        }),
    ),
  };

  resolveMatrixAuthMock.mockResolvedValue(mainAuth);
  createMatrixClientMock.mockResolvedValue(mainClient);

  return { mainClient, resolveStartup: () => resolveStartup?.() };
}

describe("resolveSharedMatrixClient", () => {
  beforeAll(async () => {
    ({
      acquireSharedMatrixClient,
      releaseSharedClientInstance,
      resolveSharedMatrixClient,
      stopSharedClient,
      stopSharedClientForAccount,
      stopSharedClientInstance,
    } = await import("./shared.js"));
  });

  beforeEach(() => {
    resolveMatrixAuthMock.mockReset();
    resolveMatrixAuthContextMock.mockReset();
    createMatrixClientMock.mockReset();
    resolveMatrixAuthContextMock.mockImplementation(
      ({ accountId }: { accountId?: string | null } = {}) => ({
        cfg: TEST_CFG,
        env: undefined,
        accountId: accountId ?? "default",
        resolved: {},
      }),
    );
  });

  afterEach(() => {
    stopSharedClient();
    vi.clearAllMocks();
  });

  it("keeps account clients isolated when resolves are interleaved", async () => {
    const { mainClient, opsClient } = primeAccountClientMocks();

    const firstMain = await resolveSharedMatrixClient({
      cfg: TEST_CFG,
      accountId: "main",
      startClient: false,
    });
    const firstPoe = await resolveSharedMatrixClient({
      cfg: TEST_CFG,
      accountId: "ops",
      startClient: false,
    });
    const secondMain = await resolveSharedMatrixClient({ cfg: TEST_CFG, accountId: "main" });

    expect(firstMain).toBe(mainClient);
    expect(firstPoe).toBe(opsClient);
    expect(secondMain).toBe(mainClient);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(2);
    expect(mainClient.start).toHaveBeenCalledTimes(1);
    expect(opsClient.start).toHaveBeenCalledTimes(0);
  });

  it("stops only the targeted account client", async () => {
    const { mainAuth, mainClient, opsClient } = primeAccountClientMocks();

    await resolveSharedMatrixClient({ cfg: TEST_CFG, accountId: "main", startClient: false });
    await resolveSharedMatrixClient({ cfg: TEST_CFG, accountId: "ops", startClient: false });

    stopSharedClientForAccount(mainAuth);

    expect(mainClient.stop).toHaveBeenCalledTimes(1);
    expect(opsClient.stop).toHaveBeenCalledTimes(0);

    stopSharedClient();

    expect(opsClient.stop).toHaveBeenCalledTimes(1);
  });

  it("drops stopped shared clients by instance so the next resolve recreates them", async () => {
    const mainAuth = authFor("main");
    const firstMainClient = createMockClient("main-first");
    const secondMainClient = createMockClient("main-second");

    resolveMatrixAuthMock.mockResolvedValue(mainAuth);
    createMatrixClientMock
      .mockResolvedValueOnce(firstMainClient)
      .mockResolvedValueOnce(secondMainClient);

    const first = await resolveSharedMatrixClient({
      cfg: TEST_CFG,
      accountId: "main",
      startClient: false,
    });
    stopSharedClientInstance(first as unknown as import("../sdk.js").MatrixClient);
    const second = await resolveSharedMatrixClient({
      cfg: TEST_CFG,
      accountId: "main",
      startClient: false,
    });

    expect(first).toBe(firstMainClient);
    expect(second).toBe(secondMainClient);
    expect(firstMainClient.stop).toHaveBeenCalledTimes(1);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(2);
  });

  it("reuses the effective implicit account instead of keying it as default", async () => {
    const poeAuth = authFor("ops");
    const poeClient = createMockClient("ops");

    resolveMatrixAuthContextMock.mockReturnValue({
      cfg: TEST_CFG,
      env: undefined,
      accountId: "ops",
      resolved: {},
    });
    resolveMatrixAuthMock.mockResolvedValue(poeAuth);
    createMatrixClientMock.mockResolvedValue(poeClient);

    const first = await resolveSharedMatrixClient({ cfg: TEST_CFG, startClient: false });
    const second = await resolveSharedMatrixClient({ cfg: TEST_CFG, startClient: false });

    expect(first).toBe(poeClient);
    expect(second).toBe(poeClient);
    expect(resolveMatrixAuthMock).toHaveBeenCalledWith({
      cfg: TEST_CFG,
      env: undefined,
      accountId: "ops",
    });
    expect(createMatrixClientMock).toHaveBeenCalledTimes(1);
    expect(createMatrixClientMock).toHaveBeenCalledWith({
      accessToken: "token-ops",
      accountId: "ops",
      allowPrivateNetwork: undefined,
      deviceId: "OPS-DEVICE",
      dispatcherPolicy: undefined,
      encryption: false,
      homeserver: "https://matrix.example.org",
      initialSyncLimit: undefined,
      localTimeoutMs: undefined,
      password: "secret",
      ssrfPolicy: undefined,
      userId: "@ops:example.org",
    });
  });

  it("honors startClient false even when the caller acquires a shared lease", async () => {
    const mainAuth = authFor("main");
    const mainClient = createMockClient("main");

    resolveMatrixAuthMock.mockResolvedValue(mainAuth);
    createMatrixClientMock.mockResolvedValue(mainClient);

    const client = await acquireSharedMatrixClient({
      cfg: TEST_CFG,
      accountId: "main",
      startClient: false,
    });

    expect(client).toBe(mainClient);
    expect(mainClient.start).not.toHaveBeenCalled();
  });

  it("keeps shared clients alive until the last one-off lease releases", async () => {
    const mainAuth = authFor("main");
    const mainClient = {
      ...createMockClient("main"),
      stopAndPersist: vi.fn(async () => undefined),
    };

    resolveMatrixAuthMock.mockResolvedValue(mainAuth);
    createMatrixClientMock.mockResolvedValue(mainClient);

    const first = await acquireSharedMatrixClient({
      cfg: TEST_CFG,
      accountId: "main",
      startClient: false,
    });
    const second = await acquireSharedMatrixClient({
      cfg: TEST_CFG,
      accountId: "main",
      startClient: false,
    });

    expect(first).toBe(mainClient);
    expect(second).toBe(mainClient);

    expect(
      await releaseSharedClientInstance(mainClient as unknown as import("../sdk.js").MatrixClient),
    ).toBe(false);
    expect(mainClient.stop).not.toHaveBeenCalled();

    expect(
      await releaseSharedClientInstance(mainClient as unknown as import("../sdk.js").MatrixClient),
    ).toBe(true);
    expect(mainClient.stop).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched explicit account ids when auth is already resolved", async () => {
    await expect(
      resolveSharedMatrixClient({
        auth: authFor("ops"),
        accountId: "main",
        startClient: false,
      }),
    ).rejects.toThrow("Matrix shared client account mismatch");
  });

  it("lets a later waiter abort while shared startup continues for the owner", async () => {
    const { mainClient, resolveStartup } = createPendingSharedStartup();

    const ownerPromise = resolveSharedMatrixClient({ cfg: TEST_CFG, accountId: "main" });
    await vi.waitFor(() => {
      expect(mainClient.start).toHaveBeenCalledTimes(1);
    });

    const abortController = new AbortController();
    const canceledWaiter = resolveSharedMatrixClient({
      cfg: TEST_CFG,
      accountId: "main",
      abortSignal: abortController.signal,
    });
    abortController.abort();

    await expectMatrixStartupAbort(canceledWaiter);

    resolveStartup();
    await expect(ownerPromise).resolves.toBe(mainClient);
  });

  it("keeps the shared startup lock while an aborted waiter exits early", async () => {
    const { mainClient, resolveStartup } = createPendingSharedStartup();

    const ownerPromise = resolveSharedMatrixClient({ cfg: TEST_CFG, accountId: "main" });
    await vi.waitFor(() => {
      expect(mainClient.start).toHaveBeenCalledTimes(1);
    });

    const abortController = new AbortController();
    const abortedWaiter = resolveSharedMatrixClient({
      cfg: TEST_CFG,
      accountId: "main",
      abortSignal: abortController.signal,
    });
    abortController.abort();
    await expectMatrixStartupAbort(abortedWaiter);

    const followerPromise = resolveSharedMatrixClient({ cfg: TEST_CFG, accountId: "main" });
    expect(mainClient.start).toHaveBeenCalledTimes(1);

    resolveStartup();
    await expect(ownerPromise).resolves.toBe(mainClient);
    await expect(followerPromise).resolves.toBe(mainClient);
    expect(mainClient.start).toHaveBeenCalledTimes(1);
  });

  it("recreates the shared client when dispatcherPolicy changes", async () => {
    const firstAuth = {
      ...authFor("main"),
      dispatcherPolicy: {
        mode: "explicit-proxy" as const,
        proxyUrl: "http://127.0.0.1:7890",
      },
    };
    const secondAuth = {
      ...authFor("main"),
      dispatcherPolicy: {
        mode: "explicit-proxy" as const,
        proxyUrl: "http://127.0.0.1:7891",
      },
    };
    const firstClient = createMockClient("main-first");
    const secondClient = createMockClient("main-second");

    resolveMatrixAuthMock.mockResolvedValueOnce(firstAuth).mockResolvedValueOnce(secondAuth);
    createMatrixClientMock.mockResolvedValueOnce(firstClient).mockResolvedValueOnce(secondClient);

    const first = await resolveSharedMatrixClient({
      cfg: TEST_CFG,
      accountId: "main",
      startClient: false,
    });
    const second = await resolveSharedMatrixClient({
      cfg: TEST_CFG,
      accountId: "main",
      startClient: false,
    });

    expect(first).toBe(firstClient);
    expect(second).toBe(secondClient);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(2);
  });
});

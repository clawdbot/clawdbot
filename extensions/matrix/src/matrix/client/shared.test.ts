// Matrix tests cover shared plugin behavior.
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
let stopSharedClientForAccount: typeof import("./shared.js").stopSharedClientForAccount;

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

function createDeferred<T = void>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createMockClient(name: string, callOrder: string[] = []) {
  return {
    name,
    start: vi.fn(async (_params?: { abortSignal?: AbortSignal }) => {
      callOrder.push("start");
    }),
    quiesceSync: vi.fn(async () => {
      callOrder.push("quiesce");
    }),
    stop: vi.fn(() => {
      callOrder.push("stop");
    }),
    stopAndPersist: vi.fn(async () => {
      callOrder.push("persist");
    }),
    stopWithoutPersist: vi.fn(() => {
      callOrder.push("discard");
    }),
    drainPendingDecryptions: vi.fn(async (reason: string) => {
      callOrder.push(
        reason === "matrix monitor sync quiesce"
          ? "drain-quiesce"
          : reason === "matrix shared client final shutdown"
            ? "drain-final"
            : "drain-poison",
      );
    }),
    getJoinedRooms: vi.fn(async () => [] as string[]),
    crypto: undefined,
  };
}

function createMonitorRetirement(callOrder: string[]) {
  return {
    closeTaskAdmission: vi.fn(() => callOrder.push("close-admission")),
    detachListeners: vi.fn(() => callOrder.push("detach-listeners")),
    waitForTasks: vi.fn(async () => {
      callOrder.push("wait-tasks");
    }),
    cleanup: vi.fn(async () => {
      callOrder.push("monitor-cleanup");
    }),
  };
}

async function expectMatrixStartupAbort(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "AbortError",
    message: "Matrix startup aborted",
  });
}

describe("shared Matrix client generations", () => {
  beforeAll(async () => {
    ({ acquireSharedMatrixClient, stopSharedClientForAccount } = await import("./shared.js"));
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

  afterEach(async () => {
    await Promise.allSettled([
      stopSharedClientForAccount(authFor("main")),
      stopSharedClientForAccount(authFor("ops")),
    ]);
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("keeps colliding delimiter-shaped auth tuples isolated", async () => {
    const firstAuth = {
      ...authFor("main"),
      homeserver: "https://matrix.example.org/base|@alice",
      userId: "@bob:example.org",
      accessToken: "shared-token",
      encryption: true,
    } satisfies MatrixAuth;
    const secondAuth = {
      ...authFor("main"),
      homeserver: "https://matrix.example.org/base",
      // Historical Matrix user IDs may contain both characters in the localpart.
      userId: "@alice|@bob:example.org",
      accessToken: "shared-token",
      encryption: true,
    } satisfies MatrixAuth;
    const firstCrypto = { prepare: vi.fn(async () => undefined) };
    const secondCrypto = { prepare: vi.fn(async () => undefined) };
    const firstClient = { ...createMockClient("first"), crypto: firstCrypto };
    const secondClient = { ...createMockClient("second"), crypto: secondCrypto };

    createMatrixClientMock.mockResolvedValueOnce(firstClient).mockResolvedValueOnce(secondClient);

    const firstLease = await acquireSharedMatrixClient({ auth: firstAuth });
    const repeatedFirstLease = await acquireSharedMatrixClient({ auth: firstAuth });
    const secondLease = await acquireSharedMatrixClient({ auth: secondAuth });

    expect(firstLease.client).toBe(firstClient);
    expect(repeatedFirstLease.client).toBe(firstClient);
    expect(secondLease.client).toBe(secondClient);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(2);
    expect(firstCrypto.prepare).toHaveBeenCalledTimes(1);
    expect(secondCrypto.prepare).toHaveBeenCalledTimes(1);

    await firstLease.release();
    expect(firstClient.stopAndPersist).not.toHaveBeenCalled();
    await repeatedFirstLease.release();
    expect(firstClient.stopAndPersist).toHaveBeenCalledTimes(1);
    expect(secondClient.stopAndPersist).not.toHaveBeenCalled();

    await secondLease.release();
    expect(secondClient.stopAndPersist).toHaveBeenCalledTimes(1);
  });

  it("keeps account generations isolated", async () => {
    const mainClient = createMockClient("main");
    const opsClient = createMockClient("ops");
    resolveMatrixAuthMock.mockImplementation(async ({ accountId }: { accountId?: string }) =>
      accountId === "ops" ? authFor("ops") : authFor("main"),
    );
    createMatrixClientMock.mockImplementation(async ({ accountId }: { accountId?: string }) =>
      accountId === "ops" ? opsClient : mainClient,
    );

    const main = await acquireSharedMatrixClient({
      cfg: TEST_CFG,
      accountId: "main",
      startClient: false,
    });
    const ops = await acquireSharedMatrixClient({
      cfg: TEST_CFG,
      accountId: "ops",
      startClient: false,
    });
    const secondMain = await acquireSharedMatrixClient({
      cfg: TEST_CFG,
      accountId: "main",
      startClient: false,
    });

    expect(main.client).toBe(mainClient);
    expect(ops.client).toBe(opsClient);
    expect(secondMain.client).toBe(mainClient);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(2);

    await Promise.all([main.release(), secondMain.release(), ops.release()]);
  });

  it("retires only the requested account through the owner", async () => {
    const mainAuth = authFor("main");
    const opsAuth = authFor("ops");
    const mainClient = createMockClient("main");
    const opsClient = createMockClient("ops");
    createMatrixClientMock.mockResolvedValueOnce(mainClient).mockResolvedValueOnce(opsClient);

    await acquireSharedMatrixClient({ auth: mainAuth, startClient: false });
    const ops = await acquireSharedMatrixClient({ auth: opsAuth, startClient: false });

    await stopSharedClientForAccount(mainAuth);

    expect(mainClient.stopAndPersist).toHaveBeenCalledTimes(1);
    expect(mainClient.stopWithoutPersist).not.toHaveBeenCalled();
    expect(opsClient.stopWithoutPersist).not.toHaveBeenCalled();
    await ops.release();
  });

  it("runs registered monitor cleanup during forced account retirement", async () => {
    const auth = authFor("main");
    const client = createMockClient("main");
    const waitForTasks = createDeferred();
    createMatrixClientMock.mockResolvedValue(client);
    const monitor = await acquireSharedMatrixClient({
      auth,
      role: "monitor",
      startClient: false,
    });
    const retirement = createMonitorRetirement([]);
    retirement.waitForTasks.mockReturnValue(waitForTasks.promise);
    monitor.registerMonitorRetirement(retirement);

    const forcedRetirement = stopSharedClientForAccount(auth);
    await vi.waitFor(() => {
      expect(retirement.waitForTasks).toHaveBeenCalledTimes(1);
    });
    const lateRelease = monitor.release({ mode: "persist" });
    expect(monitor.release({ mode: "discard" })).toBe(lateRelease);
    let lateReleaseSettled = false;
    void lateRelease.then(() => {
      lateReleaseSettled = true;
    });
    await Promise.resolve();
    expect(lateReleaseSettled).toBe(false);

    waitForTasks.resolve();
    await Promise.all([forcedRetirement, lateRelease]);

    expect(retirement.closeTaskAdmission).toHaveBeenCalledTimes(1);
    expect(retirement.detachListeners).toHaveBeenCalledTimes(1);
    expect(retirement.waitForTasks).toHaveBeenCalledTimes(1);
    expect(retirement.cleanup).toHaveBeenCalledTimes(1);
    expect(client.quiesceSync).toHaveBeenCalledTimes(1);
    expect(client.stopAndPersist).toHaveBeenCalledTimes(1);
  });

  it("runs every monitor cleanup once during forced account retirement", async () => {
    const client = createMockClient("main");
    createMatrixClientMock.mockResolvedValue(client);
    const auth = authFor("main");
    const first = await acquireSharedMatrixClient({
      auth,
      role: "monitor",
      startClient: false,
    });
    const second = await acquireSharedMatrixClient({
      auth,
      role: "monitor",
      startClient: false,
    });
    const firstRetirement = createMonitorRetirement([]);
    const secondRetirement = createMonitorRetirement([]);
    first.registerMonitorRetirement(firstRetirement);
    second.registerMonitorRetirement(secondRetirement);

    await stopSharedClientForAccount(auth);
    await Promise.all([first.release(), second.release()]);

    for (const retirement of [firstRetirement, secondRetirement]) {
      expect(retirement.closeTaskAdmission).toHaveBeenCalledTimes(1);
      expect(retirement.detachListeners).toHaveBeenCalledTimes(1);
      expect(retirement.waitForTasks).toHaveBeenCalledTimes(1);
      expect(retirement.cleanup).toHaveBeenCalledTimes(1);
    }
    expect(client.quiesceSync).toHaveBeenCalledTimes(1);
    expect(client.stopAndPersist).toHaveBeenCalledTimes(1);
    expect(client.stopWithoutPersist).not.toHaveBeenCalled();
  });

  it("reuses one generation for monitor and transient leases when transient releases first", async () => {
    const callOrder: string[] = [];
    const client = createMockClient("main", callOrder);
    createMatrixClientMock.mockResolvedValue(client);
    const auth = authFor("main");
    const monitor = await acquireSharedMatrixClient({
      auth,
      role: "monitor",
      startClient: false,
    });
    const transient = await acquireSharedMatrixClient({
      auth,
      role: "transient",
      startClient: false,
    });

    expect(transient.abortSignal.aborted).toBe(false);
    await transient.release({ mode: "stop" });
    expect(transient.abortSignal.aborted).toBe(false);
    expect(callOrder).toEqual([]);

    monitor.registerMonitorRetirement(createMonitorRetirement(callOrder));
    await monitor.release({ mode: "persist" });

    expect(callOrder).toEqual([
      "quiesce",
      "drain-quiesce",
      "close-admission",
      "detach-listeners",
      "wait-tasks",
      "monitor-cleanup",
      "drain-final",
      "persist",
    ]);
  });

  it("signals cooperative transient work and persists after it drains", async () => {
    const callOrder: string[] = [];
    const client = createMockClient("main", callOrder);
    createMatrixClientMock.mockResolvedValue(client);
    const auth = authFor("main");
    const monitor = await acquireSharedMatrixClient({
      auth,
      role: "monitor",
      startClient: false,
    });
    const transient = await acquireSharedMatrixClient({
      auth,
      role: "transient",
      startClient: false,
    });
    transient.abortSignal.addEventListener(
      "abort",
      () => {
        callOrder.push("transient-cancel");
        void transient.release();
      },
      { once: true },
    );

    monitor.registerMonitorRetirement(createMonitorRetirement(callOrder));
    await monitor.release({ mode: "persist" });

    expect(transient.abortSignal.aborted).toBe(true);
    expect(callOrder).toEqual([
      "transient-cancel",
      "quiesce",
      "drain-quiesce",
      "close-admission",
      "detach-listeners",
      "wait-tasks",
      "monitor-cleanup",
      "drain-final",
      "persist",
    ]);
    expect(client.stopWithoutPersist).not.toHaveBeenCalled();
  });

  it("bounds non-cooperative transient drain and makes late release harmless", async () => {
    vi.useFakeTimers();
    const callOrder: string[] = [];
    const client = createMockClient("main", callOrder);
    createMatrixClientMock.mockResolvedValue(client);
    const auth = authFor("main");
    const monitor = await acquireSharedMatrixClient({
      auth,
      role: "monitor",
      startClient: false,
    });
    const transient = await acquireSharedMatrixClient({
      auth,
      role: "transient",
      startClient: false,
    });

    monitor.registerMonitorRetirement(createMonitorRetirement(callOrder));
    const retirement = monitor.release({ mode: "persist" });
    const retirementError = retirement.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(client.stopWithoutPersist).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(retirementError).resolves.toMatchObject({
      message: "Matrix transient leases did not drain within 5000ms",
    });
    expect(transient.abortSignal.aborted).toBe(true);
    expect(client.stopWithoutPersist).toHaveBeenCalledTimes(1);
    expect(client.stopAndPersist).not.toHaveBeenCalled();

    const firstLateRelease = transient.release({ mode: "persist" });
    const secondLateRelease = transient.release({ mode: "persist" });
    expect(secondLateRelease).toBe(firstLateRelease);
    await firstLateRelease;
    expect(client.stopWithoutPersist).toHaveBeenCalledTimes(1);
    expect(client.stopAndPersist).not.toHaveBeenCalled();
  });

  it("quiesces and cleans up the monitor before waiting for an existing transient lease", async () => {
    const callOrder: string[] = [];
    const client = createMockClient("main", callOrder);
    createMatrixClientMock.mockResolvedValue(client);
    const auth = authFor("main");
    const monitor = await acquireSharedMatrixClient({
      auth,
      role: "monitor",
      startClient: false,
    });
    const transient = await acquireSharedMatrixClient({
      auth,
      role: "transient",
      startClient: false,
    });

    monitor.registerMonitorRetirement(createMonitorRetirement(callOrder));
    const monitorRelease = monitor.release({ mode: "persist" });
    await vi.waitFor(() => {
      expect(callOrder).toContain("monitor-cleanup");
    });
    expect(callOrder).not.toContain("persist");

    await transient.release({ mode: "stop" });
    await monitorRelease;

    expect(callOrder).toEqual([
      "quiesce",
      "drain-quiesce",
      "close-admission",
      "detach-listeners",
      "wait-tasks",
      "monitor-cleanup",
      "drain-final",
      "persist",
    ]);
  });

  it("keeps shared sync open until the final monitor lease is released", async () => {
    const callOrder: string[] = [];
    const client = createMockClient("main", callOrder);
    createMatrixClientMock.mockResolvedValue(client);
    const auth = authFor("main");
    const first = await acquireSharedMatrixClient({
      auth,
      role: "monitor",
      startClient: false,
    });
    const final = await acquireSharedMatrixClient({
      auth,
      role: "monitor",
      startClient: false,
    });
    const firstRetirement = createMonitorRetirement(callOrder);
    first.registerMonitorRetirement(firstRetirement);
    final.registerMonitorRetirement(createMonitorRetirement(callOrder));

    const firstRelease = first.release({ mode: "persist" });
    expect(first.release({ mode: "discard" })).toBe(firstRelease);
    await firstRelease;

    expect(callOrder).toEqual([
      "close-admission",
      "detach-listeners",
      "wait-tasks",
      "monitor-cleanup",
    ]);
    expect(client.quiesceSync).not.toHaveBeenCalled();
    expect(client.stopAndPersist).not.toHaveBeenCalled();
    expect(client.stopWithoutPersist).not.toHaveBeenCalled();

    await final.release({ mode: "persist" });

    expect(callOrder).toEqual([
      "close-admission",
      "detach-listeners",
      "wait-tasks",
      "monitor-cleanup",
      "quiesce",
      "drain-quiesce",
      "close-admission",
      "detach-listeners",
      "wait-tasks",
      "monitor-cleanup",
      "drain-final",
      "persist",
    ]);
    expect(client.quiesceSync).toHaveBeenCalledTimes(1);
    expect(client.stopAndPersist).toHaveBeenCalledTimes(1);
  });

  it("uses the same quiesce-before-persist path for a transient-only started generation", async () => {
    const callOrder: string[] = [];
    const client = createMockClient("main", callOrder);
    createMatrixClientMock.mockResolvedValue(client);

    const transient = await acquireSharedMatrixClient({
      auth: authFor("main"),
      role: "transient",
    });
    await transient.release({ mode: "persist" });

    expect(callOrder).toEqual(["start", "quiesce", "drain-quiesce", "drain-final", "persist"]);
  });

  it("memoizes one release promise for duplicate release calls", async () => {
    const client = createMockClient("main");
    const persist = createDeferred();
    client.stopAndPersist.mockReturnValue(persist.promise);
    createMatrixClientMock.mockResolvedValue(client);
    const lease = await acquireSharedMatrixClient({
      auth: authFor("main"),
      startClient: false,
    });

    const first = lease.release({ mode: "persist" });
    const second = lease.release({ mode: "persist" });

    expect(second).toBe(first);
    persist.resolve();
    await first;
    await lease.release({ mode: "persist" });
    expect(client.stopAndPersist).toHaveBeenCalledTimes(1);
  });

  it("waits abortably instead of admitting a new lease while a generation retires", async () => {
    const firstClient = createMockClient("first");
    const replacementClient = createMockClient("replacement");
    const persist = createDeferred();
    firstClient.stopAndPersist.mockReturnValue(persist.promise);
    createMatrixClientMock
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(replacementClient);
    const auth = authFor("main");
    const lease = await acquireSharedMatrixClient({ auth, startClient: false });
    const release = lease.release({ mode: "persist" });
    await vi.waitFor(() => {
      expect(firstClient.stopAndPersist).toHaveBeenCalledTimes(1);
    });

    const abortController = new AbortController();
    const blockedAcquire = acquireSharedMatrixClient({
      auth,
      abortSignal: abortController.signal,
    });
    abortController.abort();
    await expectMatrixStartupAbort(blockedAcquire);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(1);

    persist.resolve();
    await release;
    const replacement = await acquireSharedMatrixClient({ auth, startClient: false });
    expect(replacement.client).toBe(replacementClient);
    await replacement.release();
  });

  it("poisons a timed-out generation, discards final state, and never reopens it automatically", async () => {
    const cause = new Error("Matrix classic sync did not reach STOPPED within 5000ms");
    const callOrder: string[] = [];
    const client = createMockClient("main", callOrder);
    client.quiesceSync.mockImplementation(async () => {
      callOrder.push("quiesce");
      throw cause;
    });
    createMatrixClientMock.mockResolvedValue(client);
    const auth = authFor("main");
    const monitor = await acquireSharedMatrixClient({
      auth,
      role: "monitor",
      startClient: false,
    });
    const transient = await acquireSharedMatrixClient({
      auth,
      role: "transient",
      startClient: false,
    });

    monitor.registerMonitorRetirement(createMonitorRetirement(callOrder));
    const release = monitor.release({ mode: "persist" });
    const releaseError = release.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => {
      expect(callOrder).toContain("monitor-cleanup");
    });
    await expect(acquireSharedMatrixClient({ auth })).rejects.toBe(cause);

    await expect(transient.release()).rejects.toBe(cause);
    expect(await releaseError).toBe(cause);
    expect(client.stopWithoutPersist).toHaveBeenCalledTimes(1);
    expect(client.stopAndPersist).not.toHaveBeenCalled();
    await expect(acquireSharedMatrixClient({ auth })).rejects.toBe(cause);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(1);
  });

  it("preserves an earlier stop requirement when the final lease requests discard", async () => {
    const cause = new Error("best-effort persistence failed");
    const persist = createDeferred();
    const firstClient = createMockClient("first");
    const replacementClient = createMockClient("replacement");
    firstClient.stopAndPersist.mockReturnValue(persist.promise);
    createMatrixClientMock
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(replacementClient);
    const auth = authFor("main");
    const first = await acquireSharedMatrixClient({ auth, startClient: false });
    const final = await acquireSharedMatrixClient({ auth, startClient: false });

    await first.release({ mode: "stop" });
    expect(firstClient.stopAndPersist).not.toHaveBeenCalled();
    const release = final.release({ mode: "discard" });
    await vi.waitFor(() => {
      expect(firstClient.stopAndPersist).toHaveBeenCalledTimes(1);
    });
    const replacementPromise = acquireSharedMatrixClient({ auth, startClient: false });
    expect(createMatrixClientMock).toHaveBeenCalledTimes(1);

    persist.reject(cause);
    await release;
    expect(firstClient.stopWithoutPersist).toHaveBeenCalledTimes(1);

    const replacement = await replacementPromise;
    expect(replacement.client).toBe(replacementClient);
    await replacement.release({ mode: "discard" });
  });

  it("discards without attempting persistence", async () => {
    const client = createMockClient("main");
    createMatrixClientMock.mockResolvedValue(client);
    const lease = await acquireSharedMatrixClient({
      auth: authFor("main"),
      startClient: false,
    });

    await lease.release({ mode: "discard" });

    expect(client.stopAndPersist).not.toHaveBeenCalled();
    expect(client.stopWithoutPersist).toHaveBeenCalledTimes(1);
  });

  it("preserves and propagates an earlier persist requirement when final lease discards", async () => {
    const cause = new Error("crypto persist failed");
    const firstClient = createMockClient("first");
    const replacementClient = createMockClient("replacement");
    firstClient.stopAndPersist.mockRejectedValue(cause);
    createMatrixClientMock
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(replacementClient);
    const auth = authFor("main");
    const first = await acquireSharedMatrixClient({ auth, startClient: false });
    const final = await acquireSharedMatrixClient({ auth, startClient: false });

    await first.release({ mode: "persist" });
    expect(firstClient.stopAndPersist).not.toHaveBeenCalled();
    await expect(final.release({ mode: "discard" })).rejects.toBe(cause);
    expect(firstClient.stopWithoutPersist).not.toHaveBeenCalled();

    const replacement = await acquireSharedMatrixClient({ auth, startClient: false });
    expect(replacement.client).toBe(replacementClient);
    await replacement.release();
  });

  it("discards and replaces a generation when the final decryption drain fails", async () => {
    const cause = new Error("final decryption drain timed out");
    const firstClient = createMockClient("first");
    const replacementClient = createMockClient("replacement");
    firstClient.drainPendingDecryptions
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(cause);
    createMatrixClientMock
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(replacementClient);
    const auth = authFor("main");
    const lease = await acquireSharedMatrixClient({ auth, startClient: false });

    await expect(lease.release({ mode: "persist" })).rejects.toBe(cause);
    expect(firstClient.stopWithoutPersist).toHaveBeenCalledTimes(1);
    expect(firstClient.stopAndPersist).not.toHaveBeenCalled();
    await expect(stopSharedClientForAccount(auth)).resolves.toBeUndefined();

    const replacement = await acquireSharedMatrixClient({ auth, startClient: false });
    expect(replacement.client).toBe(replacementClient);
    await replacement.release({ mode: "discard" });
  });

  it("aborts a first starter and waiter during forced retirement without late reuse", async () => {
    const start = createDeferred();
    const firstClient = createMockClient("first");
    const replacementClient = createMockClient("replacement");
    let startupSignal: AbortSignal | undefined;
    firstClient.start.mockImplementation(({ abortSignal } = {}) => {
      startupSignal = abortSignal;
      return start.promise;
    });
    createMatrixClientMock
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(replacementClient);
    const auth = authFor("main");
    const owner = await acquireSharedMatrixClient({ auth, startClient: false });
    const waiter = await acquireSharedMatrixClient({ auth, startClient: false });
    const callerAbort = new AbortController();

    const ownerStart = owner.start(callerAbort.signal);
    await vi.waitFor(() => {
      expect(firstClient.start).toHaveBeenCalledTimes(1);
    });
    const waiterStart = waiter.start();
    const ownerAbort = expectMatrixStartupAbort(ownerStart);
    const waiterAbort = expectMatrixStartupAbort(waiterStart);

    await Promise.all([stopSharedClientForAccount(auth), ownerAbort, waiterAbort]);
    expect(callerAbort.signal.aborted).toBe(false);
    expect(startupSignal?.aborted).toBe(true);
    expect(owner.abortSignal.aborted).toBe(true);
    expect(waiter.abortSignal.aborted).toBe(true);

    start.resolve();
    await Promise.resolve();
    const replacement = await acquireSharedMatrixClient({ auth, startClient: false });
    expect(replacement.client).toBe(replacementClient);
    await replacement.release({ mode: "discard" });
  });

  it("does not let one aborted startup waiter remove another lease", async () => {
    const client = createMockClient("main");
    const start = createDeferred();
    client.start.mockReturnValue(start.promise);
    createMatrixClientMock.mockResolvedValue(client);
    const auth = authFor("main");
    const owner = await acquireSharedMatrixClient({
      auth,
      startClient: false,
    });
    const ownerStart = owner.start();
    const abortController = new AbortController();
    const waiter = acquireSharedMatrixClient({
      auth,
      abortSignal: abortController.signal,
    });
    abortController.abort();
    await expectMatrixStartupAbort(waiter);

    start.resolve();
    await ownerStart;
    await owner.release();
    expect(client.start).toHaveBeenCalledTimes(1);
  });
});

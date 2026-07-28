// Copilot tests cover runtime plugin behavior.
import { normalize, resolve, sep } from "node:path";
import type { CopilotClient, CopilotClientOptions } from "@github/copilot-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientCreateOptions, PoolKey } from "./runtime.js";
import { createCopilotClientPool } from "./runtime.js";

interface FakeClient {
  readonly id: number;
  readonly copilotHome: string;
  readonly start: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
  readonly createSession: ReturnType<typeof vi.fn>;
  readonly disconnect: ReturnType<typeof vi.fn>;
}

interface FakeFactoryOptions {
  readonly create?: (
    opts: CopilotClientOptions,
    id: number,
  ) => CopilotClient | Promise<CopilotClient>;
  readonly stop?: (client: FakeClient) => Promise<Error[]> | Error[];
}

function createDeferred<T>() {
  let resolveValue: ((value: T | PromiseLike<T>) => void) | undefined;
  let rejectValue: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolveValue = resolvePromise;
    rejectValue = rejectPromise;
  });
  return {
    promise,
    resolve(value: T) {
      resolveValue?.(value);
    },
    reject(reason: unknown) {
      rejectValue?.(reason);
    },
  };
}

function normalizeHomeForTest(copilotHome: string): string {
  let normalizedHome = resolve(copilotHome);
  normalizedHome = normalize(normalizedHome);
  if (normalizedHome.endsWith(sep) && normalizedHome.length > 1) {
    normalizedHome = normalizedHome.slice(0, -1);
  }
  if (process.platform === "win32") {
    normalizedHome = normalizedHome.toLowerCase();
  }
  return normalizedHome;
}

function makeKey(overrides: Partial<PoolKey> = {}): PoolKey {
  return {
    agentId: overrides.agentId ?? "agent-1",
    copilotHome: overrides.copilotHome ?? "copilot-home",
    authMode: overrides.authMode ?? "useLoggedInUser",
    authProfileId: overrides.authProfileId,
    authProfileVersion: overrides.authProfileVersion,
  };
}

function makeOptions(overrides: Partial<ClientCreateOptions> = {}): ClientCreateOptions {
  return {
    copilotHome: overrides.copilotHome ?? "copilot-home",
    useLoggedInUser: overrides.useLoggedInUser ?? true,
    gitHubToken: overrides.gitHubToken,
  };
}

function makeFake(options: FakeFactoryOptions = {}) {
  const stops: number[] = [];
  const ctorCalls: CopilotClientOptions[] = [];
  const instances: FakeClient[] = [];
  let nextId = 0;

  const fake = async (clientOptions: CopilotClientOptions) => {
    ctorCalls.push(clientOptions);
    const id = ++nextId;
    if (options.create) {
      return options.create(clientOptions, id);
    }

    const client: FakeClient = {
      id,
      copilotHome: clientOptions.baseDirectory ?? "",
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => {
        stops.push(id);
        if (options.stop) {
          return options.stop(client);
        }
        return [];
      }),
      createSession: vi.fn(async () => ({})),
      disconnect: vi.fn(),
    };
    instances.push(client);
    return client as unknown as CopilotClient;
  };

  return { fake, stops, ctorCalls, instances };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createCopilotClientPool", () => {
  it("same key reuses client", async () => {
    const sdk = makeFake();
    const pool = createCopilotClientPool({ sdkFactory: sdk.fake });
    const key = makeKey();
    const options = makeOptions();

    const first = await pool.acquire(key, options);
    const second = await pool.acquire(key, options);

    expect(first.client).toBe(second.client);
    expect(first.key).toEqual(second.key);
    expect(sdk.ctorCalls.length).toBe(1);
  });

  it("keeps hardened empty-mode clients separate from normal clients", async () => {
    const sdk = makeFake();
    const pool = createCopilotClientPool({ sdkFactory: sdk.fake });
    const key = makeKey();

    const normal = await pool.acquire(key, makeOptions());
    const isolated = await pool.acquire(key, { ...makeOptions(), mode: "empty" });

    expect(normal.client).not.toBe(isolated.client);
    expect(normal.key.clientMode).toBeUndefined();
    expect(isolated.key.clientMode).toBe("empty");
    expect(sdk.ctorCalls.map((options) => options.mode)).toEqual([undefined, "empty"]);
  });

  it("different agentId same copilotHome creates distinct clients", async () => {
    const sdk = makeFake();
    const pool = createCopilotClientPool({ sdkFactory: sdk.fake });
    const options = makeOptions();

    const first = await pool.acquire(makeKey({ agentId: "agent-a" }), options);
    const second = await pool.acquire(makeKey({ agentId: "agent-b" }), options);

    expect(first.client).not.toBe(second.client);
    expect(sdk.ctorCalls.length).toBe(2);
  });

  it("different authProfileVersion creates distinct clients", async () => {
    const sdk = makeFake();
    const pool = createCopilotClientPool({ sdkFactory: sdk.fake });
    const options = makeOptions({ gitHubToken: "token-a", useLoggedInUser: false });

    const first = await pool.acquire(
      makeKey({ authMode: "gitHubToken", authProfileId: "profile", authProfileVersion: "v1" }),
      options,
    );
    const second = await pool.acquire(
      makeKey({ authMode: "gitHubToken", authProfileId: "profile", authProfileVersion: "v2" }),
      options,
    );

    expect(first.client).not.toBe(second.client);
    expect(sdk.ctorCalls.length).toBe(2);
  });

  it("release decrements; non-zero refcount keeps client alive", async () => {
    const sdk = makeFake();
    const pool = createCopilotClientPool({ idleTtlMs: 100, sdkFactory: sdk.fake });
    const key = makeKey();
    const options = makeOptions();

    const first = await pool.acquire(key, options);
    const second = await pool.acquire(key, options);
    await pool.release(first);

    expect(first.client).toBe(second.client);
    expect(sdk.stops).toEqual([]);
    expect(pool.size()).toBe(1);
  });

  it("release to zero schedules idle teardown; teardown fires after idleTtlMs and calls stop() exactly once", async () => {
    vi.useFakeTimers();
    const sdk = makeFake();
    const pool = createCopilotClientPool({ idleTtlMs: 50, sdkFactory: sdk.fake });
    const handle = await pool.acquire(makeKey(), makeOptions());

    await pool.release(handle);
    await vi.advanceTimersByTimeAsync(49);
    expect(sdk.stops).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(sdk.stops).toEqual([1]);
    expect(pool.size()).toBe(0);
    expect(sdk.instances[0]?.start.mock.calls.length).toBe(0);

    await vi.advanceTimersByTimeAsync(50);
    expect(sdk.stops).toEqual([1]);
  });

  it("acquire during idle window cancels teardown and reuses", async () => {
    vi.useFakeTimers();
    const sdk = makeFake();
    const pool = createCopilotClientPool({ idleTtlMs: 50, sdkFactory: sdk.fake });
    const key = makeKey();
    const options = makeOptions();

    const first = await pool.acquire(key, options);
    await pool.release(first);
    await vi.advanceTimersByTimeAsync(25);

    const second = await pool.acquire(key, options);

    expect(second.client).toBe(first.client);
    expect(sdk.ctorCalls.length).toBe(1);
    expect(sdk.stops).toEqual([]);

    await vi.advanceTimersByTimeAsync(50);
    expect(sdk.stops).toEqual([]);

    await pool.release(second);
    await vi.advanceTimersByTimeAsync(50);
    expect(sdk.stops).toEqual([1]);
  });

  it("acquire during stopping awaits stop(), then creates fresh client", async () => {
    vi.useFakeTimers();
    const stopDeferred = createDeferred<Error[]>();
    const sdk = makeFake({
      stop: async () => stopDeferred.promise,
    });
    const pool = createCopilotClientPool({ idleTtlMs: 10, sdkFactory: sdk.fake });
    const key = makeKey();
    const options = makeOptions();

    const first = await pool.acquire(key, options);
    await pool.release(first);
    await vi.advanceTimersByTimeAsync(10);

    let settled = false;
    const secondPromise = pool.acquire(key, options).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(sdk.stops).toEqual([1]);

    stopDeferred.resolve([]);
    const second = await secondPromise;

    expect(settled).toBe(true);
    expect(second.client).not.toBe(first.client);
    expect(sdk.ctorCalls.length).toBe(2);
  });

  it("concurrent acquire dedupes", async () => {
    const clientDeferred = createDeferred<CopilotClient>();
    const sdkFactory = vi.fn(async () => clientDeferred.promise);
    const pool = createCopilotClientPool({ sdkFactory });
    const key = makeKey();
    const options = makeOptions();

    const firstPromise = pool.acquire(key, options);
    const secondPromise = pool.acquire(key, options);
    await Promise.resolve();

    expect(sdkFactory.mock.calls.length).toBe(1);

    const client = {
      id: 1,
      copilotHome: "copilot-home",
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => []),
      createSession: vi.fn(async () => ({})),
      disconnect: vi.fn(),
    } as unknown as CopilotClient;
    clientDeferred.resolve(client);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.client).toBe(second.client);
    expect(sdkFactory.mock.calls.length).toBe(1);
  });

  it("constructor failure is not cached", async () => {
    let attempt = 0;
    const sdkFactory = async (clientOptions: CopilotClientOptions) => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error(`constructor failed for ${String(clientOptions.baseDirectory)}`);
      }
      return {
        id: attempt,
        copilotHome: clientOptions.baseDirectory,
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => []),
        createSession: vi.fn(async () => ({})),
        disconnect: vi.fn(),
      } as unknown as CopilotClient;
    };
    const pool = createCopilotClientPool({ sdkFactory });

    await expect(pool.acquire(makeKey(), makeOptions())).rejects.toThrow("constructor failed for");

    const second = await pool.acquire(makeKey(), makeOptions());

    expect(attempt).toBe(2);
    expect(second.key.agentId).toBe("agent-1");
  });

  it("double release is a no-op", async () => {
    vi.useFakeTimers();
    const sdk = makeFake();
    const pool = createCopilotClientPool({ idleTtlMs: 100, sdkFactory: sdk.fake });
    const handle = await pool.acquire(makeKey(), makeOptions());

    await pool.release(handle);
    await pool.release(handle);
    await vi.advanceTimersByTimeAsync(99);

    expect(sdk.stops).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(sdk.stops).toEqual([1]);
  });

  it("dispose stops all clients exactly once, aggregates errors, clears the map", async () => {
    const sdk = makeFake({
      stop: (client) => [new Error(`stop-${client.id}-a`), new Error(`stop-${client.id}-b`)],
    });
    const pool = createCopilotClientPool({ idleTtlMs: 1000, sdkFactory: sdk.fake });

    const first = await pool.acquire(
      makeKey({ agentId: "agent-a", copilotHome: "home-a" }),
      makeOptions({ copilotHome: "home-a" }),
    );
    const second = await pool.acquire(
      makeKey({ agentId: "agent-b", copilotHome: "home-b" }),
      makeOptions({ copilotHome: "home-b" }),
    );
    await pool.acquire(
      makeKey({ agentId: "agent-c", copilotHome: "home-c" }),
      makeOptions({ copilotHome: "home-c" }),
    );
    await pool.release(second);

    const errors = await pool.dispose();

    expect(errors.map((error) => error.message)).toEqual([
      "stop-1-a",
      "stop-1-b",
      "stop-2-a",
      "stop-2-b",
      "stop-3-a",
      "stop-3-b",
    ]);
    expect(sdk.stops).toEqual([1, 2, 3]);
    expect(pool.size()).toBe(0);

    const secondDispose = await pool.dispose();
    expect(secondDispose).toEqual([]);
    expect(sdk.stops).toEqual([1, 2, 3]);
    await pool.release(first);
  });

  it("dispose during in-flight acquire", async () => {
    const clientDeferred = createDeferred<CopilotClient>();
    const stopped: number[] = [];
    const sdkFactory = async () => {
      const client = {
        id: 1,
        copilotHome: "copilot-home",
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => {
          stopped.push(1);
          return [];
        }),
        createSession: vi.fn(async () => ({})),
        disconnect: vi.fn(),
      } as unknown as CopilotClient;
      await clientDeferred.promise;
      return client;
    };
    const pool = createCopilotClientPool({ sdkFactory });

    const acquirePromise = pool.acquire(makeKey(), makeOptions());
    const disposePromise = pool.dispose();
    const client = {
      id: 1,
      copilotHome: "copilot-home",
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => []),
      createSession: vi.fn(async () => ({})),
      disconnect: vi.fn(),
    } as unknown as CopilotClient;
    clientDeferred.resolve(client);

    await expect(acquirePromise).rejects.toThrow("[copilot-pool] pool disposed");
    expect(await disposePromise).toEqual([]);
    expect(stopped).toEqual([1]);
    await expect(pool.acquire(makeKey(), makeOptions())).rejects.toThrow(
      "[copilot-pool] pool disposed",
    );
  });

  it("concurrent dispose waits for the in-flight shutdown and does not duplicate errors", async () => {
    const stopDeferred = createDeferred<Error[]>();
    const sdk = makeFake({
      stop: async () => stopDeferred.promise,
    });
    const pool = createCopilotClientPool({ sdkFactory: sdk.fake });

    await pool.acquire(makeKey(), makeOptions());

    const firstDisposePromise = pool.dispose();
    const secondDisposePromise = pool.dispose();
    await Promise.resolve();

    expect(sdk.stops).toEqual([1]);

    stopDeferred.resolve([new Error("stop failed")]);
    const firstErrors = await firstDisposePromise;
    const secondErrors = await secondDisposePromise;

    expect(firstErrors.map((error) => error.message)).toEqual(["stop failed"]);
    expect(secondErrors).toEqual([]);
  });

  it("normalizes non-Error stop failures during dispose", async () => {
    const sdk = makeFake({
      stop: () => {
        throw toLintErrorObject("stop-string", "Non-Error thrown");
      },
    });
    const pool = createCopilotClientPool({ sdkFactory: sdk.fake });

    await pool.acquire(makeKey(), makeOptions());

    const errors = await pool.dispose();

    expect(errors.map((error) => error.message)).toEqual(["stop-string"]);
  });

  it("treats Windows copilotHome paths as case-insensitive when keying the pool", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });

    try {
      const sdk = makeFake();
      const pool = createCopilotClientPool({ sdkFactory: sdk.fake });
      const firstHome = "C:/Users/Tester/CopilotHome/";
      const secondHome = "c:/users/tester/copilothome";

      const first = await pool.acquire(
        makeKey({ copilotHome: firstHome }),
        makeOptions({ copilotHome: firstHome }),
      );
      const second = await pool.acquire(
        makeKey({ copilotHome: secondHome }),
        makeOptions({ copilotHome: secondHome }),
      );

      const normalizedHome = normalizeHomeForTest(firstHome);
      expect(first.client).toBe(second.client);
      expect(first.key.copilotHome).toBe(normalizedHome);
      expect(second.key.copilotHome).toBe(normalizedHome);
      expect(String(sdk.ctorCalls[0]?.baseDirectory)).toBe(normalizedHome);
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  });

  it("path normalization", async () => {
    const sdk = makeFake();
    const pool = createCopilotClientPool({ sdkFactory: sdk.fake });
    const firstHome =
      process.platform === "win32" ? "C:\\Users\\Tester\\CopilotHome\\" : "copilot-home/";
    const secondHome =
      process.platform === "win32" ? "c:\\users\\tester\\copilothome" : "copilot-home";

    const first = await pool.acquire(
      makeKey({ copilotHome: firstHome }),
      makeOptions({ copilotHome: firstHome }),
    );
    const second = await pool.acquire(
      makeKey({ copilotHome: secondHome }),
      makeOptions({ copilotHome: secondHome }),
    );

    const normalizedHome = normalizeHomeForTest(firstHome);
    expect(first.client).toBe(second.client);
    expect(first.key.copilotHome).toBe(normalizedHome);
    expect(second.key.copilotHome).toBe(normalizedHome);
    expect(sdk.ctorCalls.length).toBe(1);
    expect(String(sdk.ctorCalls[0]?.baseDirectory)).toBe(normalizedHome);
  });
});

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}

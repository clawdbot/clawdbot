import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

type HealthHook = () => void | Promise<void>;
let drainHealthCleanup: (() => Promise<void>) | undefined;
let healthImport: Promise<unknown> | undefined;

afterEach(async () => {
  try {
    // A timed-out import still runs. Join it before resetting the mock registry;
    // collectHealthFixture fences the canceled test before it can inject faults.
    await healthImport;
    // A red health cleanup can skip the remaining owner hook. Drain it only
    // after recording the failure, so this regression cannot leak its HOME.
    await drainHealthCleanup?.();
  } finally {
    drainHealthCleanup = undefined;
    healthImport = undefined;
    vi.restoreAllMocks();
    vi.doUnmock("vitest");
    vi.doUnmock("./server.js");
    vi.doUnmock("./server.e2e-ws-harness.js");
    vi.doUnmock("./server-restart-sentinel.js");
    vi.resetModules();
  }
});

async function collectHealthFixture(signal: AbortSignal) {
  vi.resetModules();
  const setupHooks: HealthHook[] = [];
  const cleanupHooks: HealthHook[] = [];
  const bodies = new Map<string, HealthHook>();
  const ws = new EventEmitter();
  const close = vi.fn(async () => {});
  const harness = { close, openClient: async () => ({ ws }) };
  const start = vi.fn(async () => harness);
  const prepare = vi.fn(async () => {});
  const vitest = await vi.importActual<typeof import("vitest")>("vitest");
  vi.doMock("vitest", () => ({
    ...vitest,
    beforeAll: (hook: HealthHook) => setupHooks.push(hook),
    afterAll: (hook: HealthHook) => cleanupHooks.push(hook),
    beforeEach: vi.fn(),
    afterEach: vi.fn(),
    describe: (_name: string, body: () => void) => body(),
    test: (name: string, optionsOrBody: { timeout: number } | HealthHook, body?: HealthHook) => {
      const run = typeof optionsOrBody === "function" ? optionsOrBody : body;
      if (!run) {
        throw new Error(`Missing health test body: ${name}`);
      }
      bodies.set(name, run);
    },
  }));
  // Keep installGatewayTestHooks and its real environment lifecycle intact.
  // Only server construction is controlled; the normal suite proves health RPCs.
  vi.doMock("./server.js", () => ({ resetPreparedModelCatalogForTest: prepare }));
  vi.doMock("./server.e2e-ws-harness.js", () => ({ startGatewayServerHarness: start }));
  const cleanup = async () => {
    // Vitest's default stack order stops this phase on the first rejection.
    while (cleanupHooks.length) {
      await cleanupHooks.pop()!();
    }
  };
  drainHealthCleanup = async () => {
    const errors: unknown[] = [];
    while (cleanupHooks.length) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "Health fixture recovery cleanup failed");
    }
  };
  healthImport = import("./server.health.test.js");
  await healthImport;
  signal.throwIfAborted();
  return {
    bodies,
    close,
    harness,
    start,
    prepare,
    ws,
    cleanup,
    setup: async () => {
      for (const hook of setupHooks) {
        await hook();
      }
    },
  };
}

test.for(["HOME acquisition", "shared reset"])(
  "health teardown preserves a %s failure without dereferencing a fixture",
  async (phase, { signal }) => {
    const fixture = await collectHealthFixture(signal);
    const homeBefore = process.env.HOME;
    const failure = new Error(`injected shared ${phase} failure`);
    if (phase === "HOME acquisition") {
      vi.spyOn(fs, "mkdtemp").mockRejectedValueOnce(failure);
    } else {
      fixture.prepare.mockRejectedValueOnce(failure);
    }
    await expect(fixture.setup()).rejects.toBe(failure);
    expect(fixture.start).not.toHaveBeenCalled();
    const partialHome = process.env.HOME!;
    if (phase === "shared reset") {
      expect(partialHome).not.toBe(homeBefore);
      expect(existsSync(partialHome)).toBe(true);
    }
    await expect(fixture.cleanup()).resolves.toBeUndefined();
    expect(process.env.HOME).toBe(homeBefore);
    if (phase === "shared reset") {
      expect(existsSync(partialHome)).toBe(false);
    }
  },
);

test("health teardown preserves rejected startup and removes its partial fixture state", async ({
  signal,
}) => {
  const fixture = await collectHealthFixture(signal);
  const failure = new Error("injected startup failure before harness publication");
  let partialState: string | undefined;
  fixture.start.mockImplementation(async () => {
    partialState = path.join(process.env.HOME!, "partial-health-startup");
    await fs.mkdir(partialState);
    throw failure;
  });
  await expect(fixture.setup()).rejects.toBe(failure);
  expect(existsSync(partialState!)).toBe(true);
  await expect(fixture.cleanup()).resolves.toBeUndefined();
  expect(existsSync(partialState!)).toBe(false);
  expect(fixture.close).not.toHaveBeenCalled();
});

test("health cleanup retains its environment until pending startup settles and the server closes", async ({
  signal,
}) => {
  const fixture = await collectHealthFixture(signal);
  const started = createDeferred();
  const releaseStartup = createDeferred<typeof fixture.harness>();
  const releaseClose = createDeferred();
  fixture.start.mockImplementation(() => {
    started.resolve();
    return releaseStartup.promise;
  });
  fixture.close.mockImplementation(() => releaseClose.promise);
  const setup = fixture.setup();
  let cleanup: Promise<unknown> | undefined;
  try {
    await Promise.race([started.promise, setup]);
    expect(fixture.start).toHaveBeenCalledOnce();
    const home = process.env.HOME!;
    let cleanupSettled = false;
    // Drive the schedule after a beforeAll timeout: its async body is still
    // running when Vitest enters afterAll. No wall-clock timeout is needed.
    cleanup = fixture.cleanup().then(
      () => {
        cleanupSettled = true;
      },
      (error: unknown) => {
        cleanupSettled = true;
        return error;
      },
    );
    await setImmediate();
    expect.soft(cleanupSettled).toBe(false);
    expect.soft(process.env.HOME === home).toBe(true);
    expect.soft(existsSync(home)).toBe(true);
    releaseStartup.resolve(fixture.harness);
    await setup;
    await setImmediate();
    expect.soft(fixture.close).toHaveBeenCalledOnce();
    expect.soft(cleanupSettled).toBe(false);
    expect.soft(process.env.HOME === home).toBe(true);
    expect.soft(existsSync(home)).toBe(true);
    releaseClose.resolve();
    expect.soft(await cleanup).toBeUndefined();
    expect.soft(existsSync(home)).toBe(false);
  } finally {
    releaseStartup.resolve(fixture.harness);
    releaseClose.resolve();
    await Promise.allSettled([setup, cleanup]);
  }
});

test("health teardown awaits the shutdown test's original close promise without closing twice", async ({
  signal,
}) => {
  const fixture = await collectHealthFixture(signal);
  const closing = createDeferred();
  const releaseClose = createDeferred();
  fixture.close.mockImplementation(() => {
    closing.resolve();
    fixture.ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "event",
          event: "shutdown",
          payload: { reason: "gateway stopping" },
        }),
      ),
    );
    return releaseClose.promise;
  });
  await fixture.setup();
  const home = process.env.HOME!;
  const shutdown = fixture.bodies.get("shutdown event is broadcast on close");
  expect(shutdown).toBeTypeOf("function");
  const body = Promise.resolve(shutdown!());
  let cleanup: Promise<void> | undefined;
  try {
    await Promise.race([closing.promise, body]);
    let cleanupSettled = false;
    cleanup = fixture.cleanup().then(() => {
      cleanupSettled = true;
    });
    await setImmediate();
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(cleanupSettled).toBe(false);
    expect(process.env.HOME === home).toBe(true);
    expect(existsSync(home)).toBe(true);
    releaseClose.resolve();
    await Promise.all([body, cleanup]);
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(existsSync(home)).toBe(false);
  } finally {
    releaseClose.resolve();
    await Promise.allSettled([body, cleanup]);
  }
});

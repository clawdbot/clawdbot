import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { captureEnv } from "../test-utils/env.js";

// Run the actual fixture hooks with controlled setup/teardown overlap instead
// of waiting for the runner's 180s timeout. Consumer test bodies stay uncalled.
const hooks = vi.hoisted(() => ({
  setup: [] as Array<() => unknown>,
  cleanup: [] as Array<() => unknown>,
}));
vi.mock("vitest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vitest")>()),
  beforeAll: (fn: () => unknown) => hooks.setup.push(fn),
  afterAll: (fn: () => unknown) => hooks.cleanup.push(fn),
  beforeEach: () => {},
  afterEach: () => {},
  test: Object.assign(() => {}, { each: () => () => {} }),
}));

const listeners = vi.hoisted(() => new Set<import("node:net").Server>());
// The fixture owns a disposable server, not Gateway business logic. Keep its
// real port, socket, harness and environment lifetime; fork tests cover RPC boot.
vi.mock("./server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server.js")>()),
  resetPreparedModelCatalogForTest: async () => {},
  startGatewayServer: async (port: number) => {
    const { createServer } = await import("node:net");
    const listener = createServer();
    listeners.add(listener);
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(port, "127.0.0.1", resolve);
    });
    return {
      startupSettled: Promise.resolve(),
      getTailscaleIngressEndpoint: () => undefined,
      close: async () => {
        if (listener.listening) {
          await new Promise<void>((resolve, reject) => {
            listener.close((error) => (error ? reject(error) : resolve()));
          });
        }
      },
    } satisfies import("./server.js").GatewayServer;
  },
}));

const { afterEach, beforeEach, expect, test } =
  await vi.importActual<typeof import("vitest")>("vitest");
await import("./server.sessions.create.test.js");
const consumerHooks = { setup: hooks.setup.splice(0), cleanup: hooks.cleanup.splice(0) };
const sessions = await import("./test/server-sessions.test-helpers.js");
const serverHarness = await import("./server.e2e-ws-harness.js");
const gatewayHelpers = await import("./test-helpers.server.js");
const startHarness = serverHarness.startGatewayServerHarness;
let env: ReturnType<typeof captureEnv>;
beforeEach(() => {
  env = captureEnv([
    "HOME",
    "USERPROFILE",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_AGENT_DIR",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
    "OPENCLAW_SKIP_GMAIL_WATCHER",
    "OPENCLAW_SKIP_CANVAS_HOST",
    "OPENCLAW_SKIP_CHANNELS",
    "OPENCLAW_SKIP_PROVIDERS",
    "OPENCLAW_SKIP_CRON",
    "OPENCLAW_TEST_MINIMAL_GATEWAY",
    "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
    "OPENCLAW_BUNDLED_PLUGINS_DIR",
  ]);
});
afterEach(async () => {
  // Preserve cleanup even on the unfixed side of these regressions.
  for (const listener of listeners) {
    if (listener.listening) {
      await new Promise<void>((resolve) => {
        listener.close(() => resolve());
      });
    }
  }
  listeners.clear();
  vi.restoreAllMocks();
  env.restore();
});

async function setup(fixture: typeof hooks) {
  for (const hook of fixture.setup) {
    await hook();
  }
}

async function cleanup(fixture: typeof hooks) {
  for (const hook of fixture.cleanup.toReversed()) {
    await hook();
  }
}

// Red runs still release resources if the broken consumer aborts teardown.
async function emergencyCleanup(fixture: typeof hooks) {
  for (const hook of fixture.cleanup.toReversed()) {
    await Promise.resolve()
      .then(hook)
      .catch(() => {});
  }
}

test("shared setup failure skips consumer acquisition without adding an invalid-path error", async () => {
  const failure = new Error("injected shared setup failure");
  const start = vi.spyOn(serverHarness, "startGatewayServerHarness").mockRejectedValue(failure);
  try {
    await expect(setup(consumerHooks)).rejects.toBe(failure);
    await expect(cleanup(consumerHooks)).resolves.toBeUndefined();
  } finally {
    await emergencyCleanup(consumerHooks);
    start.mockRestore();
  }
});

test("partial session setup closes its acquired server before removing its environment", async () => {
  sessions.setupGatewaySessionsTestHarness();
  const fixture = { setup: hooks.setup.splice(0), cleanup: hooks.cleanup.splice(0) };
  const failure = new Error("injected session directory acquisition failure");
  const mkdtemp = fs.mkdtemp.bind(fs);
  const mkdtempSync = fsSync.mkdtempSync.bind(fsSync);
  const asyncTemp = vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix, options) => {
    if (prefix.includes("openclaw-sessions-")) {
      throw failure;
    }
    return await mkdtemp(prefix, options);
  });
  const syncTemp = vi.spyOn(fsSync, "mkdtempSync").mockImplementation((prefix, options) => {
    if (prefix.includes("openclaw-sessions-")) {
      throw failure;
    }
    return mkdtempSync(prefix, options);
  });
  let acquired: Awaited<ReturnType<typeof startHarness>> | undefined;
  let closeCalls = 0;
  const start = vi
    .spyOn(serverHarness, "startGatewayServerHarness")
    .mockImplementation(async () => {
      acquired = await startHarness();
      const home = process.env.HOME!;
      const closeHarness = acquired.close;
      acquired.close = async () => {
        closeCalls++;
        expect(process.env.HOME).toBe(home);
        expect(fsSync.existsSync(home)).toBe(true);
        await closeHarness();
      };
      return acquired;
    });
  try {
    await expect(setup(fixture)).rejects.toBe(failure);
    await cleanup(fixture);
    expect(closeCalls).toBe(1);
  } finally {
    if (acquired) {
      await acquired.server.close();
    }
    await emergencyCleanup(fixture);
    start.mockRestore();
    asyncTemp.mockRestore();
    syncTemp.mockRestore();
  }
});

test("teardown joins delayed server acquisition before cleaning session directories and environment", async () => {
  sessions.setupGatewaySessionsTestHarness();
  const fixture = { setup: hooks.setup.splice(0), cleanup: hooks.cleanup.splice(0) };
  const acquired = createDeferredCore();
  const release = createDeferredCore();
  let server: Awaited<ReturnType<typeof startHarness>> | undefined;
  let closeCalls = 0;
  const roots = new Set<string>();
  const mkdtemp = fs.mkdtemp.bind(fs);
  const mkdtempSync = fsSync.mkdtempSync.bind(fsSync);
  const asyncTemp = vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix, options) => {
    const dir = await mkdtemp(prefix, options);
    if (typeof dir === "string" && path.basename(dir).startsWith("openclaw-sessions-")) {
      roots.add(dir);
    }
    return dir;
  });
  const syncTemp = vi.spyOn(fsSync, "mkdtempSync").mockImplementation((prefix, options) => {
    const dir = mkdtempSync(prefix, options);
    if (typeof dir === "string" && path.basename(dir).startsWith("openclaw-sessions-")) {
      roots.add(dir);
    }
    return dir;
  });
  const start = vi
    .spyOn(serverHarness, "startGatewayServerHarness")
    .mockImplementation(async () => {
      server = await startHarness();
      const closeServer = server.close;
      server.close = async () => {
        closeCalls++;
        await closeServer();
      };
      acquired.resolve();
      await release.promise;
      return server;
    });
  const pendingSetup = setup(fixture);
  let pendingCleanup: Promise<void> | undefined;
  try {
    await Promise.race([acquired.promise, pendingSetup]);
    pendingCleanup = cleanup(fixture);
    release.resolve();
    await Promise.all([pendingSetup, pendingCleanup]);
    expect(closeCalls).toBe(1);
    expect([...listeners].every((listener) => !listener.listening)).toBe(true);
    expect(roots.size).toBe(1);
    expect([...roots].every((root) => !fsSync.existsSync(root))).toBe(true);
  } finally {
    release.resolve();
    await Promise.allSettled([pendingSetup, pendingCleanup]);
    await server?.close();
    await emergencyCleanup(fixture);
    for (const root of roots) {
      await fs.rm(root, { recursive: true, force: true });
    }
    start.mockRestore();
    asyncTemp.mockRestore();
    syncTemp.mockRestore();
  }
});

test("teardown leaves delayed template initialization alive until its writes settle", async () => {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const mkdir = fs.mkdir.bind(fs);
  const rm = fs.rm.bind(fs);
  const rmSync = fsSync.rmSync.bind(fsSync);
  let templateRoot: string | undefined;
  let initializing = true;
  let removedDuringInitialization = false;
  const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation(async (dir, options) => {
    if (
      String(dir).includes("openclaw-session-git-template-") &&
      path.basename(String(dir)) === "workspace"
    ) {
      templateRoot = path.dirname(String(dir));
      entered.resolve();
      await release.promise;
    }
    return await mkdir(dir, options);
  });
  const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (dir, options) => {
    if (String(dir) === templateRoot && initializing) {
      removedDuringInitialization = true;
    }
    return await rm(dir, options);
  });
  const rmSyncSpy = vi.spyOn(fsSync, "rmSync").mockImplementation((dir, options) => {
    if (String(dir) === templateRoot && initializing) {
      removedDuringInitialization = true;
    }
    rmSync(dir, options);
  });
  const pendingSetup = setup(consumerHooks).finally(() => {
    initializing = false;
  });
  let pendingCleanup: Promise<void> | undefined;
  try {
    await Promise.race([entered.promise, pendingSetup]);
    pendingCleanup = cleanup(consumerHooks);
    release.resolve();
    await Promise.allSettled([pendingSetup, pendingCleanup]);
    expect(removedDuringInitialization).toBe(false);
    await expect(pendingSetup).resolves.toBeUndefined();
    await expect(pendingCleanup).resolves.toBeUndefined();
    expect(templateRoot).toBeDefined();
    expect(fsSync.existsSync(templateRoot!)).toBe(false);
  } finally {
    release.resolve();
    await Promise.allSettled([pendingSetup, pendingCleanup]);
    mkdirSpy.mockRestore();
    rmSpy.mockRestore();
    rmSyncSpy.mockRestore();
    await emergencyCleanup(consumerHooks);
    if (templateRoot) {
      await fs.rm(templateRoot, { recursive: true, force: true });
    }
  }
});

test("teardown joins pending home acquisition before restoring the environment", async () => {
  gatewayHelpers.installGatewayTestHooks({ scope: "suite" });
  const fixture = { setup: hooks.setup.splice(0), cleanup: hooks.cleanup.splice(0) };
  const homeBefore = process.env.HOME;
  const acquired = createDeferredCore();
  const release = createDeferredCore();
  const mkdtemp = fs.mkdtemp.bind(fs);
  let home: string | undefined;
  const temp = vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix, options) => {
    const dir = await mkdtemp(prefix, options);
    if (prefix.includes("openclaw-gateway-home-")) {
      home = dir;
      acquired.resolve();
      await release.promise;
    }
    return dir;
  });
  const pendingSetup = setup(fixture);
  let pendingCleanup: Promise<void> | undefined;
  try {
    await Promise.race([acquired.promise, pendingSetup]);
    pendingCleanup = cleanup(fixture);
    release.resolve();
    await Promise.all([pendingSetup, pendingCleanup]);
    expect(process.env.HOME).toBe(homeBefore);
    expect(fsSync.existsSync(home!)).toBe(false);
  } finally {
    release.resolve();
    await Promise.allSettled([pendingSetup, pendingCleanup]);
    temp.mockRestore();
    await emergencyCleanup(fixture);
    if (home) {
      await fs.rm(home, { recursive: true, force: true });
    }
  }
});

test("a server cleanup error does not skip session directory or environment cleanup", async () => {
  const fixtureApi = sessions.setupGatewaySessionsTestHarness();
  const fixture = { setup: hooks.setup.splice(0), cleanup: hooks.cleanup.splice(0) };
  const homeBefore = process.env.HOME;
  const failure = new Error("injected server cleanup failure");
  let restoreClose: (() => void) | undefined;
  try {
    await setup(fixture);
    const home = process.env.HOME!;
    const { dir } = await fixtureApi.createSessionStoreDir();
    const server = fixtureApi.getHarness();
    const closeServer = server.close;
    const close = vi.spyOn(server, "close").mockImplementation(async () => {
      await closeServer();
      throw failure;
    });
    restoreClose = () => close.mockRestore();
    await expect(cleanup(fixture)).rejects.toBe(failure);
    expect(fsSync.existsSync(dir)).toBe(false);
    expect(fsSync.existsSync(home)).toBe(false);
    expect(process.env.HOME).toBe(homeBefore);
  } finally {
    restoreClose?.();
    await emergencyCleanup(fixture);
  }
});

test("skipped environment setup does not release an enclosing suite's home", async () => {
  gatewayHelpers.installGatewayTestHooks({ scope: "suite" });
  const parent = { setup: hooks.setup.splice(0), cleanup: hooks.cleanup.splice(0) };
  gatewayHelpers.installGatewayTestHooks({ scope: "suite" });
  const skipped = { setup: hooks.setup.splice(0), cleanup: hooks.cleanup.splice(0) };
  try {
    await setup(parent);
    const home = process.env.HOME!;
    await cleanup(skipped);
    expect(process.env.HOME).toBe(home);
    expect(fsSync.existsSync(home)).toBe(true);
  } finally {
    await emergencyCleanup(parent);
  }
});

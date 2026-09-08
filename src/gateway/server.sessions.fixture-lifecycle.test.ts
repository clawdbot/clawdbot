import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { captureEnv } from "../test-utils/env.js";
import { runGatewayFixtureFork } from "./server.fixture-lifetime.test-support.js";

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
  const databases: ReturnType<typeof openOpenClawAgentDatabase>[] = [];
  try {
    await setup(fixture);
    const home = process.env.HOME!;
    const { dir } = await fixtureApi.createSessionStoreDir();
    for (const databasePath of [
      path.join(dir, "openclaw-agent.sqlite"),
      resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    ]) {
      databases.push(openOpenClawAgentDatabase({ agentId: "main", path: databasePath }));
    }
    const server = fixtureApi.getHarness();
    const closeServer = server.close;
    const close = vi.spyOn(server, "close").mockImplementation(async () => {
      await closeServer();
      throw failure;
    });
    restoreClose = () => close.mockRestore();
    await expect(cleanup(fixture)).rejects.toBe(failure);
    expect(databases.map(({ db }) => db.isOpen)).toEqual([false, false]);
    expect(fsSync.existsSync(dir)).toBe(false);
    expect(fsSync.existsSync(home)).toBe(false);
    expect(process.env.HOME).toBe(homeBefore);
  } finally {
    restoreClose?.();
    for (const database of databases) {
      closeOpenClawAgentDatabaseByPath(database.path);
    }
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

function retainedGatewayFixtureSource(repoRoot: string, root: string): string {
  const source = (file: string) => JSON.stringify(path.join(repoRoot, file));
  return `
import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
const hooks = vi.hoisted(() => ({ setup: [], cleanup: [], reset: [], afterEach: [] }));
vi.mock("vitest", async (importOriginal) => ({
  ...(await importOriginal()),
  beforeAll: (fn) => hooks.setup.push(fn),
  afterAll: (fn) => hooks.cleanup.push(fn),
  beforeEach: (fn) => hooks.reset.push(fn),
  afterEach: (fn) => hooks.afterEach.push(fn),
}));
const { test } = await vi.importActual("vitest");
fs.writeFileSync(${JSON.stringify(path.join(root, "worker.pid"))}, String(process.pid));
const sessions = await import(${source("src/gateway/test/server-sessions.test-helpers.ts")});
const gatewayHelpers = await import(${source("src/gateway/test-helpers.server.ts")});
const kernelModule = await import(${source("src/gateway/server-kernel.ts")});
const { createDeferredCore } = await import(${source("src/shared/deferred.ts")});
const takeHooks = () => Object.fromEntries(
  Object.entries(hooks).map(([name, callbacks]) => [name, callbacks.splice(0)]),
);
async function runHooks(callbacks) {
  for (const callback of callbacks) await callback();
}
const fault = new Error("synthetic received-connection cleanup failure");
function containsFault(error) {
  return error === fault || (error instanceof Error && (
    containsFault(error.cause) ||
    (error instanceof AggregateError && error.errors.some(containsFault))
  ));
}
async function observeFailure(run) {
  try {
    await run();
    return { rejected: false, faultPreserved: false };
  } catch (error) {
    return { rejected: true, faultPreserved: containsFault(error) };
  }
}

test("observes retained Gateway owners through fixture teardown", async () => {
  let kernel;
  const createKernel = kernelModule.createGatewayKernel;
  const factory = vi.spyOn(kernelModule, "createGatewayKernel").mockImplementation(async (...args) => {
    kernel = await createKernel(...args);
    return kernel;
  });
  const fixtureApi = sessions.setupGatewaySessionsTestHarness();
  const fixture = takeHooks();
  await runHooks(fixture.setup);
  await runHooks(fixture.reset);
  const harness = fixtureApi.getHarness();
  await harness.server.startupSettled;
  if (!kernel) throw new Error("expected the real Gateway kernel");
  const { dir } = await fixtureApi.createSessionStoreDir();
  const { ws } = await harness.openClient();
  const home = process.env.HOME;
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!home || !stateDir) throw new Error("expected isolated Gateway fixture selectors");
  // A changed synthetic selector makes the harness's earlier token snapshot observable.
  process.env.OPENCLAW_GATEWAY_TOKEN = "synthetic-retained-gateway-token";
  const selectors = new Map([
    "HOME", "USERPROFILE", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_AGENT_DIR", "OPENCLAW_GATEWAY_TOKEN",
  ].map(key => [key, process.env[key]]));
  const markers = { home: path.join(home, "owned.txt"), state: path.join(stateDir, "owned.txt"),
    sessions: path.join(dir, "owned.txt") };
  for (const file of Object.values(markers)) fs.writeFileSync(file, "owned");
  const readState = () => ({
    ...Object.fromEntries(Object.entries(markers).map(([name, file]) => {
      try { return [name, fs.readFileSync(file, "utf8") === "owned"]; }
      catch { return [name, false]; }
    })),
    selectorsIntact: [...selectors].every(([key, value]) => process.env[key] === value),
  });
  const releaseProducer = createDeferredCore();
  let phase = "before-cleanup";
  const producer = releaseProducer.promise.then(() => {
    const observation = { ...readState(), phase, writeSucceeded: false };
    try {
      fs.writeFileSync(path.join(dir, "late-producer.txt"), "joined");
      observation.writeSucceeded = true;
    } catch { /* The outer assertion reports a lost producer input, not a cleanup substitute. */ }
    return observation;
  });
  let stopCalls = 0;
  // This independent producer belongs to the generic owner, not the connection scope.
  kernel.registerGatewayLifetimeSidecars([{ stop: async () => {
    stopCalls++;
    releaseProducer.resolve();
    await producer;
  } }]);
  let connectionCleanupFinished = false;
  const trackCleanup = kernel.connectionWork.trackCleanup.bind(kernel.connectionWork);
  vi.spyOn(kernel.connectionWork, "trackCleanup").mockImplementationOnce(run =>
    trackCleanup(async () => {
      await run();
      connectionCleanupFinished = true;
      throw fault;
    }),
  );
  try {
    const close = await observeFailure(() => harness.close());
    const afterClose = readState();
    const afterEach = await observeFailure(() => runHooks(fixture.afterEach));
    let successorCaseStarted = false;
    const caseReset = await observeFailure(async () => {
      await runHooks(fixture.reset);
      successorCaseStarted = true;
    });
    const afterCaseReset = readState();
    const cleanup = await observeFailure(() => runHooks(fixture.cleanup.toReversed()));
    const repeatedCleanup = await observeFailure(() => runHooks(fixture.cleanup.toReversed()));
    const afterCleanup = readState();
    let harnessRetained = false;
    try { harnessRetained = fixtureApi.getHarness() === harness; } catch { /* Observe release. */ }
    phase = "after-cleanup";
    releaseProducer.resolve();
    const producerObservation = await producer;
    // Retained ownership must outlive the module that originally acquired the Gateway.
    vi.resetModules();
    const freshHelpers = await import(${source("src/gateway/test-helpers.server.ts")});
    freshHelpers.installGatewayTestHooks({ scope: "suite" });
    const successor = takeHooks();
    let successorSuiteStarted = false;
    const suiteSetup = await observeFailure(async () => {
      await runHooks(successor.setup);
      successorSuiteStarted = true;
    });
    fs.writeFileSync(${JSON.stringify(path.join(root, "journal.json"))}, JSON.stringify({
      close, afterEach, caseReset, cleanup, repeatedCleanup, suiteSetup,
      afterClose, afterCaseReset, afterCleanup, afterModuleReset: readState(),
      producer: producerObservation, connectionCleanupFinished, stopCalls,
      harnessRetained, successorCaseStarted, successorSuiteStarted,
    }));
  } finally {
    releaseProducer.resolve();
    await producer;
    ws.terminate();
    factory.mockRestore();
    // No unpoison/reset escape hatch: native Vitest owns this disposable fork's exit.
  }
});
`;
}

test("retains fixture state and fences successors after a required Gateway close failure", (context) =>
  runGatewayFixtureFork(context, retainedGatewayFixtureSource, (journal, text) => {
    const retained = { home: true, state: true, sessions: true, selectorsIntact: true };
    expect(journal, text).toMatchObject({
      close: { rejected: true, faultPreserved: true },
      caseReset: { rejected: true },
      cleanup: { rejected: true, faultPreserved: true },
      repeatedCleanup: { rejected: true, faultPreserved: true },
      suiteSetup: { rejected: true },
      connectionCleanupFinished: true,
      stopCalls: 0,
      harnessRetained: true,
      successorCaseStarted: false,
      successorSuiteStarted: false,
      afterClose: retained,
      afterCaseReset: retained,
      afterCleanup: retained,
      afterModuleReset: retained,
      producer: { ...retained, phase: "after-cleanup", writeSucceeded: true },
    });
  }));

import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { expect, type TestContext } from "vitest";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { runVitestShutdownCommand } from "../../test/helpers/vitest-shutdown-command.js";
import { hasErrnoCode } from "../infra/errno.js";

export function runGatewayFixtureFork(
  context: Pick<TestContext, "signal" | "onTestFinished">,
  source: (repoRoot: string, root: string) => string,
  assertJournal: (journal: unknown, text: string) => void,
): Promise<void> {
  const run = Promise.resolve().then(async () => {
    context.signal.throwIfAborted();
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gateway-close-fork-")));
    let joined = false;
    try {
      // Failed child claims belong here, never to the outer worker's resource namespace.
      createVitestResourceOwner(root);
      const require = createRequire(import.meta.url);
      const vitestPackageDir = path.dirname(require.resolve("vitest/package.json"));
      await fs.symlink(
        path.join(repoRoot, "node_modules"),
        path.join(root, "node_modules"),
        "junction",
      );
      await fs.mkdir(path.join(root, "home"));
      await fs.mkdir(path.join(root, "tmp"));
      await fs.writeFile(path.join(root, "fixture.test.ts"), source(repoRoot, root));
      await fs.writeFile(
        path.join(root, "vitest.config.ts"),
        `
import { defineConfig } from "vitest/config";
import { sharedVitestConfig } from ${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.shared.config.ts"))};
export default defineConfig({
  envDir: false,
  cacheDir: ${JSON.stringify(path.join(root, ".vite"))},
  plugins: sharedVitestConfig.plugins,
  resolve: sharedVitestConfig.resolve,
  test: {
    pool: "forks", isolate: true, maxWorkers: 1, fileParallelism: false,
    include: ["fixture.test.ts"],
    testTimeout: sharedVitestConfig.test.testTimeout,
    hookTimeout: sharedVitestConfig.test.hookTimeout,
    deps: sharedVitestConfig.test.deps,
    server: sharedVitestConfig.test.server,
  },
});
`,
      );
      const reportFile = path.join(root, "report.json");
      let child: ChildProcess | undefined;
      const output = await runVitestShutdownCommand({
        args: [
          path.join(vitestPackageDir, "vitest.mjs"),
          "run",
          "--root",
          root,
          "--config",
          path.join(root, "vitest.config.ts"),
          "--configLoader",
          "runner",
          "--reporter=verbose",
          "--reporter=json",
          `--outputFile=${reportFile}`,
        ],
        cwd: repoRoot,
        signal: context.signal,
        timeoutMs: 90_000,
        maxBytes: 4 * 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: path.join(root, "home"),
          USERPROFILE: path.join(root, "home"),
          OPENCLAW_HOME: path.join(root, "home"),
          OPENCLAW_STATE_DIR: path.join(root, "home/.openclaw"),
          OPENCLAW_CONFIG_PATH: path.join(root, "home/.openclaw/openclaw.json"),
          TMPDIR: path.join(root, "tmp"),
          TMP: path.join(root, "tmp"),
          TEMP: path.join(root, "tmp"),
          CI: "1",
          NO_COLOR: "1",
        },
        onReady(owned) {
          child = owned;
        },
      });
      const diagnostics = `${output.stdout}\n${output.stderr}`;
      expect(child?.signalCode, diagnostics).toBeNull();
      expect(child?.killed, diagnostics).toBe(false);
      const pid = Number(await fs.readFile(path.join(root, "worker.pid"), "utf8"));
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      let workerStopped = false;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (!hasErrnoCode(error, "ESRCH")) {
          throw error;
        }
        workerStopped = true;
      }
      expect(workerStopped, "native fixture worker must exit before root release").toBe(true);
      joined = true;
      expect(output.code, diagnostics).toBe(0);
      expect(JSON.parse(await fs.readFile(reportFile, "utf8")), diagnostics).toMatchObject({
        numPassedTests: 1,
        numFailedTests: 0,
        success: true,
      });
      const journal = await fs.readFile(path.join(root, "journal.json"), "utf8");
      assertJournal(JSON.parse(journal), journal);
    } finally {
      if (joined) {
        await fs.rm(root, { recursive: true, force: true });
      } else {
        console.warn(`Retained unjoined native Gateway fixture: ${root}`);
      }
    }
  });
  context.onTestFinished(() => run);
  return run;
}

export type GatewayStartupFixtureCase = {
  id: string;
  missingTls: boolean;
  failCleanup: boolean;
  requiredJoin: boolean;
};

export function gatewayStartupFixtureSource(
  repoRoot: string,
  root: string,
  scenario: GatewayStartupFixtureCase,
): string {
  const source = (file: string) => JSON.stringify(path.join(repoRoot, file));
  return `
import fs from "node:fs";
import net from "node:net";
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
const { test, expect } = await vi.importActual("vitest");
fs.writeFileSync(${JSON.stringify(path.join(root, "worker.pid"))}, String(process.pid));
const gateway = await import(${source("src/gateway/test-helpers.server.ts")});
const lifetimeModule = await import(${source("src/gateway/gateway-fixture-lifetime.test-support.ts")});
const lifecycleModule = await import(${source("src/gateway/server-lifecycle.ts")});
const kernelModule = await import(${source("src/gateway/server-kernel.ts")});
const listenModule = await import(${source("src/gateway/server/http-listen.ts")});
const metadataModule = await import(${source("src/plugins/plugin-metadata-lifecycle.ts")});
const scenario = ${JSON.stringify(scenario)};
const takeHooks = () => Object.fromEntries(
  Object.entries(hooks).map(([name, callbacks]) => [name, callbacks.splice(0)]),
);
async function runHooks(callbacks) {
  for (const callback of callbacks) await callback();
}
function containsError(error, expected) {
  return expected !== undefined && (error === expected || (error instanceof Error && (
    containsError(error.cause, expected) ||
    (error instanceof AggregateError && error.errors.some(item => containsError(item, expected)))
  )));
}
function listenOwned(server) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { server.off("error", failed); server.off("listening", ready); };
    const failed = error => { cleanup(); reject(error); };
    const ready = () => { cleanup(); resolve(); };
    server.once("error", failed);
    server.once("listening", ready);
    try { server.listen(0, "127.0.0.1"); } catch (error) { failed(error); }
  });
}
function closeOwned(server) {
  return server.listening ? new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }) : Promise.resolve();
}

test("observes startup cleanup ownership through fixture teardown", async () => {
  const originals = [];
  const own = promise => { originals.push(promise); return promise; };
  const restorers = [];
  const blocker = net.createServer();
  const probe = net.createServer();
  const fault = new Error("synthetic startup probe cleanup failure");
  const nativeCloses = [];
  const nativeListens = [];
  let acquisition, kernelStart, lifecycle, journal, tlsError;
  let metadataRetains = 0, metadataReleases = 0, lowerStops = 0;
  const homeBefore = process.env.HOME;
  const stopProbe = vi.fn(() => own(scenario.failCleanup ? Promise.reject(fault) : closeOwned(probe)));
  const sidecar = { stop: scenario.requiredJoin ? async () => { lowerStops++; } : stopProbe };
  try {
    gateway.installGatewayTestHooks({ scope: "suite" });
    const fixture = takeHooks();
    await own(runHooks(fixture.setup));
    await own(runHooks(fixture.reset));
    const home = process.env.HOME;
    const state = process.env.OPENCLAW_STATE_DIR;
    if (!home || !state) throw new Error("expected isolated Gateway fixture selectors");
    const markers = { home: path.join(home, "owned.txt"), state: path.join(state, "owned.txt") };
    for (const file of Object.values(markers)) fs.writeFileSync(file, "owned");
    const opened = await Promise.allSettled([own(listenOwned(blocker)), own(listenOwned(probe))]);
    expect(opened.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("expected owned TCP blocker");
    const retain = metadataModule.retainGatewayPluginMetadata;
    const metadataSpy = vi.spyOn(metadataModule, "retainGatewayPluginMetadata").mockImplementation(() => {
      const release = retain();
      metadataRetains++;
      return () => { release(); metadataReleases++; };
    });
    restorers.push(() => metadataSpy.mockRestore());
    const prepare = lifecycleModule.prepareGatewayLifecycle;
    const factory = vi.spyOn(lifecycleModule, "prepareGatewayLifecycle").mockImplementation((...args) => {
      const preparing = own(prepare(...args));
      return own(preparing.then(async runtime => {
        lifecycle = runtime;
        tlsError = runtime.gatewayTls.error;
        runtime.registerGatewayLifetimeSidecars([sidecar]);
        const close = runtime.closeOnStartupFailure;
        const closeSpy = vi.spyOn(runtime, "closeOnStartupFailure").mockImplementation(() => {
          const closing = own(close());
          nativeCloses.push(closing);
          return closing;
        });
        restorers.push(() => closeSpy.mockRestore());
        if (scenario.requiredJoin) {
          const cleanup = own(runtime.connectionWork.trackCleanup(stopProbe));
          await Promise.allSettled([cleanup]);
        }
        return runtime;
      }));
    });
    restorers.push(() => factory.mockRestore());
    const createKernel = kernelModule.createGatewayKernel;
    const kernelSpy = vi.spyOn(kernelModule, "createGatewayKernel").mockImplementation((...args) => {
      kernelStart = own(createKernel(...args));
      return kernelStart;
    });
    restorers.push(() => kernelSpy.mockRestore());
    const listen = listenModule.listenGatewayHttpServer;
    const listenSpy = vi.spyOn(listenModule, "listenGatewayHttpServer").mockImplementation((params) => {
      // The owned blocker cannot leave; retry policy has its own listener tests.
      const listening = own(listen({ ...params, retryEaddrinuse: false }));
      nativeListens.push(listening);
      return listening;
    });
    restorers.push(() => listenSpy.mockRestore());
    if (scenario.missingTls) {
      const config = await import(${source("src/config/config.ts")});
      const snapshot = await config.readConfigFileSnapshot();
      const dir = path.dirname(snapshot.path);
      await own(config.writeConfigFile({ gateway: { tls: {
        enabled: true, autoGenerate: false,
        certPath: path.join(dir, "synthetic-missing-cert.pem"),
        keyPath: path.join(dir, "synthetic-missing-key.pem"),
      } } }));
    }
    acquisition = own(gateway.startTestGatewayServer(address.port, {
      bind: "loopback", auth: { mode: "none" }, controlUiEnabled: false,
    }));
    const [acquired] = await Promise.allSettled([acquisition]);
    expect(acquired.status).toBe("rejected");
    const failure = acquired.reason;
    const [closed] = await Promise.allSettled(nativeCloses);
    const [kernelResult] = await Promise.allSettled([kernelStart]);
    const listenResults = await Promise.allSettled(nativeListens);
    const startupError = scenario.missingTls
      ? failure?.cause
      : listenResults[0]?.status === "rejected" ? listenResults[0].reason : undefined;
    const containsStartup = error => scenario.missingTls
      ? error instanceof Error && (error.message === tlsError || containsStartup(error.cause) ||
          (error instanceof AggregateError && error.errors.some(containsStartup)))
      : containsError(error, startupError);
    const cleanupError = closed?.status === "rejected" ? closed.reason : undefined;
    const nativeStartupMatches = scenario.missingTls
      ? startupError?.message === tlsError && tlsError?.includes("cert/key missing")
      : listenResults[0]?.status === "rejected" && startupError === listenResults[0].reason;
    process.env.OPENCLAW_GATEWAY_TOKEN = "synthetic-retained-startup-token";
    const selectors = new Map([
      "HOME", "USERPROFILE", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_AGENT_DIR", "OPENCLAW_GATEWAY_TOKEN",
    ].map(key => [key, process.env[key]]));
    const readState = () => ({
      ...Object.fromEntries(Object.entries(markers).map(([name, file]) => {
        try { return [name, fs.readFileSync(file, "utf8") === "owned"]; }
        catch { return [name, false]; }
      })),
      selectorsIntact: [...selectors].every(([key, value]) => process.env[key] === value),
    });
    const observe = async run => {
      const [result] = await Promise.allSettled([own(Promise.resolve().then(run))]);
      return {
        rejected: result.status === "rejected",
        startupPreserved: result.status === "rejected" && containsStartup(result.reason),
        cleanupPreserved: result.status === "rejected" && containsError(result.reason, cleanupError),
      };
    };
    const beforeCleanup = readState();
    const fixtureRelease = await observe(() => lifetimeModule.gatewayFixtureLifetime.assertReleased());
    // Expected owner refusals are asserted by the outer test, not unhandled suite-hook failures.
    const afterEach = await observe(() => runHooks(fixture.afterEach));
    const cleanup = await observe(() => runHooks(fixture.cleanup.toReversed()));
    const afterCleanup = readState();
    const homeRestored = process.env.HOME === homeBefore;
    gateway.installGatewayTestHooks({ scope: "suite" });
    const successor = takeHooks();
    let successorStarted = false;
    const successorSetup = await observe(async () => {
      await runHooks(successor.setup);
      successorStarted = true;
    });
    if (successorStarted) await own(runHooks(successor.cleanup.toReversed()));
    journal = {
      combinedFailure: failure instanceof AggregateError && containsStartup(failure) && containsError(failure, cleanupError),
      nativeStartupMatches: Boolean(nativeStartupMatches),
      startupCode: startupError?.cause?.code,
      startupCausePreserved: failure instanceof AggregateError && failure.cause === startupError && failure.errors.includes(startupError),
      cleanupIdentityPreserved: failure instanceof AggregateError && failure.errors.includes(cleanupError),
      cleanupFaultPreserved: containsError(cleanupError, fault),
      nativeCloseCalls: nativeCloses.length, nativeCloseStatus: closed?.status,
      kernelReturned: kernelResult.status === "fulfilled", listenCalls: nativeListens.length,
      probeListening: probe.listening, blockerListening: blocker.listening,
      stopCalls: stopProbe.mock.calls.length, lowerStops, metadataRetains, metadataReleases,
      nativeOwnerRetained: lifecycle.runtimeState.gatewayLifetimeSidecars.includes(sidecar),
      fixtureRelease, afterEach, cleanup, successorSetup, successorStarted, homeRestored,
      beforeCleanup, afterCleanup, afterSuccessor: readState(),
    };
  } finally {
    const [acquired] = await Promise.allSettled(acquisition ? [acquisition] : []);
    if (acquired?.status === "fulfilled") {
      own(acquired.value.close({ reason: "unexpected successful fixture startup" }));
    }
    await Promise.allSettled(originals);
    const listenersClosed = await Promise.allSettled([closeOwned(blocker), closeOwned(probe)]);
    for (const restore of restorers.toReversed()) restore();
    if (journal) {
      journal.finally = {
        originalsJoined: true,
        nativeCloseCalls: nativeCloses.length,
        listenerResults: listenersClosed.map(result => result.status),
        probeListening: probe.listening, blockerListening: blocker.listening,
      };
      fs.writeFileSync(${JSON.stringify(path.join(root, "journal.json"))}, JSON.stringify(journal));
    }
    // Only owned listeners close here. Native cleanup is never retried or unpoisoned.
  }
});
`;
}

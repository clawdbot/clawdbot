// Exercise the harness through native Vitest forks, including its real hook ordering.
import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { expect, it, type TestContext } from "vitest";
import type { JsonTestResults } from "vitest/node";
import { hasErrnoCode } from "../../../src/infra/errno.ts";
import { runVitestShutdownCommand } from "../../../test/helpers/vitest-shutdown-command.ts";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const helperPath = path.join(repoRoot, "ui/src/e2e/control-ui-e2e-suite.test-support.ts");

type FixtureMode =
  | "tracked-close-success"
  | "tracked-close-failure"
  | "concurrent-close"
  | "close-failure"
  | "late-context"
  | "late-setup"
  | "scenario-timeout"
  | "scenario-noncooperative"
  | "scenario-late-close"
  | "scenario-close-failure"
  | "resources-success"
  | "resources-close-failure"
  | "resources-late-setup"
  | "resources-browser-failure";

type FixtureJournal = {
  closeCalls: number;
  arrived: boolean;
  published: boolean;
  browserAcquired: boolean;
  browserClosed: boolean;
  serverAcquired: boolean;
  serverClosed: boolean;
  events: string[];
  nativeAbortObserved: boolean;
};

function fixtureSource(mode: FixtureMode, root: string): string {
  const stateImport =
    mode.startsWith("scenario-") || mode.startsWith("resources-")
      ? `import { createOpenClawTestState } from ${JSON.stringify(path.join(repoRoot, "src/test-utils/openclaw-test-state.ts"))};`
      : "";
  return `
import fs from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterAll, expect, it, vi } from "vitest";
${stateImport}
const state = vi.hoisted(() => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  return { closeCalls: 0, arrived: false, published: false, gate, release,
    browserAcquired: false, browserClosed: false, serverAcquired: false, serverClosed: false,
    events: [], nativeAbortObserved: false,
    closeFault: new Error("synthetic context close failure") };
});
vi.mock("playwright", () => ({ chromium: { launch: async () => {
  if (${JSON.stringify(mode)} === "resources-browser-failure") throw new Error("synthetic browser startup failure");
  state.browserAcquired = true;
  return {
    newContext: async () => {
      if (${JSON.stringify(mode)} === "late-context") await new Promise(resolve => setTimeout(resolve, 40));
      state.arrived = true;
      const rejectClosedPage = async () => { throw new Error("synthetic page closed"); };
      const closedPage = {
        evaluate: rejectClosedPage,
        screenshot: rejectClosedPage,
        isClosed: () => true,
        url: () => "about:blank",
      };
      return {
        setDefaultTimeout() {},
        pages: () => [],
        newPage: async () => closedPage,
        close: () => {
          state.closeCalls++;
          record();
          if (["close-failure", "tracked-close-failure"].includes(${JSON.stringify(mode)})) return Promise.reject(state.closeFault);
          return ${JSON.stringify(mode)} === "concurrent-close" && state.closeCalls === 1
            ? state.gate : Promise.resolve();
        }
      };
    },
    close: async () => { state.browserClosed = true; record(); },
  };
} } }));
import { createControlUiE2eSuite } from ${JSON.stringify(helperPath)};
const record = () => fs.writeFileSync(${JSON.stringify(path.join(root, "journal.json"))}, JSON.stringify({
  closeCalls: state.closeCalls, arrived: state.arrived, published: state.published,
  browserAcquired: state.browserAcquired, browserClosed: state.browserClosed,
  serverAcquired: state.serverAcquired, serverClosed: state.serverClosed,
  events: state.events, nativeAbortObserved: state.nativeAbortObserved,
}));
fs.writeFileSync(${JSON.stringify(path.join(root, "worker.pid"))}, String(process.pid));
record();
let sharedFixture;
const suite = createControlUiE2eSuite({ name: "owned context fixture",
  trackBrowserContexts: ${mode.startsWith("tracked-")},
  ...(${JSON.stringify(mode)}.startsWith("resources-") ? {
    resources: {
      retainedState: () => sharedFixture?.root,
      run: async (signal) => {
        sharedFixture = await createOpenClawTestState({ label: "native-shared-resource" });
        fs.writeFileSync(${JSON.stringify(path.join(root, "retained-root.txt"))}, sharedFixture.root);
        state.events.push("resource acquired"); record();
        if (${JSON.stringify(mode)} === "resources-late-setup") {
          await new Promise(resolve => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", resolve, { once: true });
          });
          signal.throwIfAborted();
        }
      },
      close: async () => {
        state.events.push("resource closed"); record();
        if (${JSON.stringify(mode)} === "resources-close-failure") throw new Error("synthetic shared resource close failure");
      },
      release: async () => {
        await sharedFixture.cleanup();
        state.events.push("released"); record();
      },
    },
  } : {}),
  startServerBeforeBrowser: ${mode === "late-setup"},
  startServer: async () => {
    if (${JSON.stringify(mode)} === "late-setup") await new Promise(resolve => setTimeout(resolve, 75));
    state.serverAcquired = true;
    return { baseUrl: "http://fixture.invalid/", close: async () => { state.serverClosed = true; record(); } };
  },
});
suite.define(() => {
  if (${JSON.stringify(mode)}.startsWith("resources-")) {
    it.for(["first", "second"])("uses shared resources: %s", async (name, context) => {
      await suite.runScenario(context, { run: async () => {
        expect(process.env.OPENCLAW_STATE_DIR).toBe(sharedFixture.stateDir);
        state.events.push(name); record();
      } });
    });
  } else if (${JSON.stringify(mode)}.startsWith("tracked-")) {
    it("first ordinary case acquires a context", async () => {
      await suite.newBrowserContext({});
    });
    it("next ordinary case starts only after context cleanup", async () => {
      fs.writeFileSync(${JSON.stringify(path.join(root, "successor.txt"))}, "started");
      await suite.newBrowserContext({});
    });
  } else if (${JSON.stringify(mode)} === "concurrent-close") {
    it("joins the first context close", async () => {
      const context = await suite.newBrowserContext({});
      const first = suite.closeBrowserContext(context);
      let secondSettled = false;
      const second = suite.closeBrowserContext(context).then(() => { secondSettled = true; });
      try {
        await nextTurn();
        expect.soft(secondSettled).toBe(false);
        expect.soft(state.closeCalls).toBe(1);
      } finally {
        state.release();
        await Promise.all([first, second]);
      }
    });
  } else if (${JSON.stringify(mode)} === "close-failure") {
    it("preserves the body and finalization failures", async () => {
      const bodyFault = new Error("synthetic page body failure");
      await expect(suite.withPage({}, async () => { throw bodyFault; })).rejects.toMatchObject({
        errors: [bodyFault, state.closeFault],
      });
    });
  } else if (${JSON.stringify(mode)} === "late-context") {
    it.fails("times out during context acquisition", async () => {
      await suite.newBrowserContext({});
      state.published = true;
    }, 5);
  } else if (${JSON.stringify(mode)} === "late-setup") {
    it("never starts after setup timed out", () => { state.published = true; record(); });
  } else {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    let fixture;
    it.fails("first usage-style attempt times out or fails cleanup", async (context) => {
      await suite.runScenario(context, {
        retainedState: () => fixture?.root,
        run: async (signal) => {
          fixture = await createOpenClawTestState({ label: "native-scenario" });
          fs.writeFileSync(${JSON.stringify(path.join(root, "retained-root.txt"))}, fixture.root);
          state.events.push("acquired"); record();
          if (${JSON.stringify(mode)} === "scenario-noncooperative") await new Promise(() => {});
          if (["scenario-close-failure", "scenario-late-close"].includes(${JSON.stringify(mode)})) return;
          await new Promise(resolve => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", resolve, { once: true });
          });
          state.nativeAbortObserved = signal.aborted; record();
          signal.throwIfAborted();
        },
        close: async () => {
          state.events.push("gateway closed"); record();
          if (${JSON.stringify(mode)} === "scenario-late-close") await state.gate;
          if (${JSON.stringify(mode)} === "scenario-close-failure") throw new Error("synthetic gateway close failure");
        },
        release: async () => {
          await fixture?.cleanup();
          state.events.push("released"); record();
        },
      });
    }, 50);
    it("next usage-style attempt starts only after the original cleanup", () => {
      fs.writeFileSync(${JSON.stringify(path.join(root, "successor.txt"))}, "started");
      expect(state.events).toEqual(["acquired", "gateway closed", "released"]);
      expect(state.nativeAbortObserved).toBe(true);
      expect(process.env.OPENCLAW_STATE_DIR).toBe(previousStateDir);
    });
  }
});
if (${JSON.stringify(mode)} === "scenario-late-close") {
  afterAll(async () => {
    state.release();
    await nextTurn();
    state.events.push("late close settled"); record();
  });
}
`;
}

async function runFixture(mode: FixtureMode, signal: AbortSignal) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ui-lifetime-fork-")));
  const hookTimeout = mode === "late-setup" || mode === "resources-late-setup" ? 50 : 500;
  let completed = false;
  try {
    const vitestPackageDir = path.dirname(require.resolve("vitest/package.json"));
    await fs.symlink(
      path.join(repoRoot, "node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    await fs.mkdir(path.join(root, "home"));
    await fs.mkdir(path.join(root, "tmp"));
    await fs.writeFile(path.join(root, "fixture.test.ts"), fixtureSource(mode, root));
    await fs.writeFile(
      path.join(root, "vitest.config.ts"),
      `
import { defineConfig } from "vitest/config";
import { sharedVitestConfig } from ${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.shared.config.ts"))};
export default defineConfig({
  cacheDir: ${JSON.stringify(path.join(root, ".vite"))},
  resolve: sharedVitestConfig.resolve,
  test: { pool: "forks", isolate: true, maxWorkers: 1, fileParallelism: false,
    testTimeout: 1000, hookTimeout: ${hookTimeout},
    provide: {
      controlUiE2eChromium: { available: true, executablePath: "/synthetic/chromium" },
      controlUiE2eCleanup: { timeoutMs: ${hookTimeout}, pool: "forks", isolate: true },
    },
  },
});
`,
    );
    const report = path.join(root, "report.json");
    let child!: ChildProcess;
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
        `--outputFile=${report}`,
      ],
      cwd: repoRoot,
      signal,
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
    expect(child.signalCode, `${output.stdout}\n${output.stderr}`).toBeNull();
    expect(child.killed).toBe(false);
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
    expect(workerStopped, "native fixture worker must be joined before removing its files").toBe(
      true,
    );
    completed = true;
    const nativeReport = JSON.parse(await fs.readFile(report, "utf8")) as JsonTestResults;
    let retainedExists = false;
    if (mode === "resources-browser-failure") {
      await expect(fs.stat(path.join(root, "retained-root.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } else if (mode.startsWith("scenario-") || mode.startsWith("resources-")) {
      const retainedRoot = await fs.readFile(path.join(root, "retained-root.txt"), "utf8");
      expect(path.relative(root, retainedRoot).startsWith("..")).toBe(false);
      retainedExists = await fs.stat(retainedRoot).then(
        () => true,
        () => false,
      );
    }
    return {
      code: child.exitCode,
      output: `${output.stdout}\n${output.stderr}`,
      report: nativeReport,
      journal: JSON.parse(
        await fs.readFile(path.join(root, "journal.json"), "utf8"),
      ) as FixtureJournal,
      retainedExists,
      successorStarted: await fs.stat(path.join(root, "successor.txt")).then(
        () => true,
        () => false,
      ),
    };
  } finally {
    if (completed) {
      await fs.rm(root, { recursive: true, force: true });
    } else {
      console.warn(`Retained unjoined native UI fixture: ${root}`);
    }
  }
}

function runJoinedShutdownTest(context: TestContext, body: () => Promise<void>) {
  // Register before the body starts: native timeout does not join its callback.
  const run = Promise.resolve().then(() => {
    context.signal.throwIfAborted();
    return body();
  });
  context.onTestFinished(() => run);
  return run;
}

it.for(["concurrent-close", "close-failure", "late-context"] as const)(
  "preserves native browser resource ownership: %s",
  (mode, context) =>
    runJoinedShutdownTest(context, async () => {
      const result = await runFixture(mode, context.signal);
      expect(result.code, result.output).toBe(mode === "close-failure" ? 1 : 0);
      expect(result.report?.numPassedTests, result.output).toBe(1);
      expect(result.report?.numFailedTests, result.output).toBe(0);
      expect(result.journal).toMatchObject({
        closeCalls: 1,
        arrived: true,
        published: false,
        browserClosed: true,
        serverClosed: true,
      });
      if (mode === "close-failure") {
        expect(result.output).toContain("synthetic context close failure");
      }
    }),
);

it("joins late suite setup before closing its acquired server", (context) =>
  runJoinedShutdownTest(context, async () => {
    const result = await runFixture("late-setup", context.signal);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("Hook timed out");
    expect(result.journal).toMatchObject({
      serverAcquired: true,
      serverClosed: true,
      browserAcquired: false,
      published: false,
    });
  }));

it("joins a native test timeout before the next state-owning attempt", (context) =>
  runJoinedShutdownTest(context, async () => {
    const result = await runFixture("scenario-timeout", context.signal);
    expect(result.code, result.output).toBe(0);
    expect(result.report?.numPassedTests, result.output).toBe(2);
    expect(result.report?.numFailedTests, result.output).toBe(0);
    expect(result.journal.events).toEqual(["acquired", "gateway closed", "released"]);
    expect(result.retainedExists).toBe(false);
    expect(result.successorStarted).toBe(true);
  }));

it.for(["scenario-noncooperative", "scenario-late-close", "scenario-close-failure"] as const)(
  "ends only the unsafe native fork and retains its state: %s",
  (mode, context) =>
    runJoinedShutdownTest(context, async () => {
      const result = await runFixture(mode, context.signal);
      expect(result.code, result.output).toBe(1);
      expect(result.report.numFailedTests, result.output).toBeGreaterThan(0);
      expect(result.output).toContain("retiring owned fork");
      expect(result.output).toContain(
        mode === "scenario-close-failure"
          ? "synthetic gateway close failure"
          : "scenario cleanup did not settle within 500ms",
      );
      expect(result.retainedExists).toBe(true);
      expect(result.successorStarted).toBe(false);
      expect(result.journal.events).not.toContain("released");
      if (mode === "scenario-late-close") {
        expect(result.journal.events).toContain("late close settled");
      }
    }),
);

it("does not clean up suite resources whose acquisition never started", (context) =>
  runJoinedShutdownTest(context, async () => {
    const result = await runFixture("resources-browser-failure", context.signal);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("synthetic browser startup failure");
    expect(result.journal.events).toEqual([]);
    expect(result.retainedExists).toBe(false);
  }));

it.for(["resources-success", "resources-close-failure", "resources-late-setup"] as const)(
  "owns shared state through native suite cleanup: %s",
  (mode, context) =>
    runJoinedShutdownTest(context, async () => {
      const result = await runFixture(mode, context.signal);
      const success = mode === "resources-success";
      expect(result.code, result.output).toBe(success ? 0 : 1);
      expect(result.report.success, result.output).toBe(success);
      expect(result.retainedExists).toBe(!success);
      if (mode === "resources-late-setup") {
        expect(result.output).toContain("Hook timed out");
        expect(result.journal.events).toEqual(["resource acquired", "resource closed"]);
      } else {
        expect(result.report.numPassedTests, result.output).toBe(2);
        expect(result.journal.events).toEqual([
          "resource acquired",
          "first",
          "second",
          "resource closed",
          ...(success ? ["released"] : []),
        ]);
      }
      if (mode === "resources-close-failure") {
        expect(result.output).toContain("synthetic shared resource close failure");
      }
    }),
);

it.for(["tracked-close-success", "tracked-close-failure"] as const)(
  "fences ordinary cases after failed per-test cleanup: %s",
  (mode, context) =>
    runJoinedShutdownTest(context, async () => {
      const result = await runFixture(mode, context.signal);
      const success = mode === "tracked-close-success";
      expect(result.code, result.output).toBe(success ? 0 : 1);
      expect(result.successorStarted, result.output).toBe(success);
      expect(result.journal).toMatchObject({
        closeCalls: success ? 2 : 1,
        browserClosed: success,
        serverClosed: success,
      });
      if (!success) {
        expect(result.output).toContain("synthetic context close failure");
        expect(result.output).toContain("retiring owned fork");
      }
    }),
);

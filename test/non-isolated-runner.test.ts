// Regression coverage for the non-isolated runner's cross-file cleanup. Keep
// every producer/observer pair in one child run: the contract is file-to-file
// cleanup, not five independent Vitest process boots.
import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, it } from "vitest";
import type { JsonTestResults } from "vitest/node";
import type { VitestReportCapture } from "../scripts/lib/vitest-report-capture.mts";
import { runVitestShutdownCommand } from "./helpers/vitest-shutdown-command.ts";
import { testApiLifecycleFixtureFiles } from "./non-isolated-runner.test-api-fixtures.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Drop parent Vitest state so the child run resolves its own config, and
    // drop GITHUB_ACTIONS so the child's reporter cannot annotate the parent.
    if (
      key.startsWith("VITEST") ||
      key.startsWith("OPENCLAW_VITEST") ||
      key === "GITHUB_ACTIONS" ||
      key === "FORCE_COLOR"
    ) {
      continue;
    }
    env[key] = value;
  }
  env.NO_COLOR = "1";
  delete env.OPENCLAW_SKIP_CHANNELS;
  delete env.OPENCLAW_SKIP_CRON;
  return env;
}

function documentFocusFixtureFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const shadowDepth of [0, 1, 2]) {
    for (const detachEarly of [false, true]) {
      const prefix = `10-focus-${shadowDepth}-${detachEarly}`;
      files[`${prefix}-a-producer.test.ts`] = `
/* @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
let wrapper: HTMLDivElement;
afterEach(() => {
  if (${detachEarly}) wrapper.remove();
});
it("establishes native focus before file cleanup", () => {
  wrapper = document.createElement("div");
  document.body.append(wrapper);
  let parent: Element | ShadowRoot = wrapper;
  for (let depth = 0; depth < ${shadowDepth}; depth++) {
    const host = document.createElement("div");
    parent.append(host);
    parent = host.attachShadow({ mode: "open" });
  }
  const button = document.createElement("button");
  parent.append(button);
  button.focus();
  expect(document.activeElement).toBe(wrapper.firstElementChild);
  document.body.className = "file-owned";
  document.body.style.display = "none";
  document.body.tabIndex = 7;
  const style = document.createElement("style");
  style.id = "${prefix}";
  document.head.append(style);
});
`;
      files[`${prefix}-b-observer.test.ts`] = `
/* @vitest-environment jsdom */
import { expect, it } from "vitest";
it("starts with an empty, attribute-free body and native default focus", () => {
  expect(document.body.childNodes).toHaveLength(0);
  expect(document.body.getAttributeNames()).toEqual([]);
  expect(document.activeElement).toBe(document.body);
  const style = document.getElementById("${prefix}");
  expect(style).not.toBeNull();
  style?.remove();
});
`;
    }
  }
  return files;
}

function fixtureFiles(): Record<string, string> {
  const sourcePath = (name: string) => JSON.stringify(path.join(repoRoot, "src", name));
  const payloadImports = `import { createRequire } from "node:module";
import { queryObjects } from "node:v8";
const { ManualPayload, AutoPayload } = createRequire(import.meta.url)("./mock-payloads.cjs");`;

  return {
    "runner.ts": `export { default } from ${JSON.stringify(path.join(repoRoot, "test", "non-isolated-runner.ts"))};\n`,
    "01-dep.ts": 'export function flavor(): string {\n  return "real";\n}\n',
    "01-mid.ts": `import { flavor } from "./01-dep.js";
export function describeFlavor(): string {
  return \`flavor:\${flavor()}\`;
}
`,
    // Evaluate the real importer graph, then fail collection. The following
    // file must still apply its mock after onAfterRunFiles cleanup.
    "01-a-crash.test.ts": `import "./01-mid.js";
import { expect } from "vitest";
expect(Object.hasOwn(globalThis, Symbol.for("openclaw.secretRedactionRegistryTestApi"))).toBe(true);
await import(${sourcePath("logging/diagnostic-run-activity.ts")});
throw new Error("synthetic collect failure");
`,
    "01-b-mock.test.ts": `import { expect, it, vi } from "vitest";
vi.mock("./01-dep.js", () => ({ flavor: () => "mocked" }));
const { describeFlavor } = await import("./01-mid.js");
it("applies mocks after a sibling collection failure", () => {
  expect(Object.hasOwn(globalThis, Symbol.for("openclaw.secretRedactionRegistryTestApi"))).toBe(false);
  expect(Object.hasOwn(globalThis, Symbol.for("openclaw.diagnosticRunActivityTestApi"))).toBe(false);
  expect(describeFlavor()).toBe("flavor:mocked");
});
`,
    "02-a-gateway-env.test.ts": `import ${sourcePath("gateway/test-helpers.mocks.ts")};
import { expect, it } from "vitest";
it("seeds gateway helper env", () => {
  expect(process.env.OPENCLAW_SKIP_CHANNELS).toBe("1");
  expect(process.env.OPENCLAW_SKIP_CRON).toBe("1");
});
`,
    "02-b-gateway-env.test.ts": `import { expect, it } from "vitest";
it("restores gateway helper env", () => {
  expect(process.env.OPENCLAW_SKIP_CHANNELS).toBeUndefined();
  expect(process.env.OPENCLAW_SKIP_CRON).toBeUndefined();
});
`,
    "02-c-agent-env.test.ts": `import { setTestEnvValue } from ${sourcePath("test-utils/env.ts")};
import { expect, it, vi } from "vitest";
it("leaves agent selectors for file-completion env unstub", () => {
  expect(process.env.HOME).toBe(process.env.OPENCLAW_TEST_HOME);
  expect(process.env.OPENCLAW_TEST_HOME).toBeTruthy();
  for (const key of ["OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"]) {
    setTestEnvValue(key, \`/tmp/inherited-\${key}\`);
    vi.stubEnv(key, undefined);
    expect(process.env[key]).toBeUndefined();
  }
});
`,
    "02-d-agent-env.test.ts": `import { expect, it } from "vitest";
it("clears restored agent selectors before the next file", () => {
  expect(process.env.HOME).toBe(process.env.OPENCLAW_TEST_HOME);
  expect(process.env.OPENCLAW_AGENT_DIR).toBeUndefined();
  expect(process.env.PI_CODING_AGENT_DIR).toBeUndefined();
});
`,
    "03-a-runtime-store.test.ts": `import { createPluginRuntimeStore } from ${sourcePath("plugin-sdk/runtime-store.ts")};
import { expect, it } from "vitest";
const store = createPluginRuntimeStore({ pluginId: "fixture", errorMessage: "missing" });
it("seeds a named runtime slot", () => {
  store.setRuntime({ source: "first-file" });
  expect(store.getRuntime()).toEqual({ source: "first-file" });
});
`,
    "03-b-runtime-store.test.ts": `import { createPluginRuntimeStore } from ${sourcePath("plugin-sdk/runtime-store.ts")};
import { expect, it } from "vitest";
const store = createPluginRuntimeStore({ pluginId: "fixture", errorMessage: "missing" });
it("clears named runtime slots", () => {
  expect(store.tryGetRuntime()).toBeNull();
});
`,
    "04-a-session-suspension.test.ts": `import { fenceSessionSuspensionWritesForGatewayShutdown } from ${sourcePath("agents/session-suspension.ts")};
import { expect, it } from "vitest";
const testApi = (globalThis as Record<PropertyKey, { isSessionSuspensionWriteCleanupActiveForTest(): boolean }>)[Symbol.for("openclaw.sessionSuspensionTestApi")];
it("seeds the session suspension shutdown fence", () => {
  fenceSessionSuspensionWritesForGatewayShutdown();
  expect(testApi?.isSessionSuspensionWriteCleanupActiveForTest()).toBe(true);
});
`,
    "04-b-session-suspension.test.ts": `import ${sourcePath("agents/session-suspension.ts")};
import { expect, it } from "vitest";
const testApi = (globalThis as Record<PropertyKey, { isSessionSuspensionWriteCleanupActiveForTest(): boolean }>)[Symbol.for("openclaw.sessionSuspensionTestApi")];
it("clears the session suspension shutdown fence", () => {
  expect(testApi?.isSessionSuspensionWriteCleanupActiveForTest()).toBe(false);
});
`,
    "04-c-gateway-admission.test.ts": `import { beginGatewayRootWorkAdmissionWhenOpen, captureGatewayRootWorkAdmissionContinuationScope, getActiveGatewayRootWorkCount, tryBeginGatewayRootWorkAdmission, tryBeginGatewaySuspendAdmission } from ${sourcePath("process/gateway-work-admission.ts")};
import { expect, it } from "vitest";
it("seeds file-owned gateway admission and a suspended waiter", async () => {
  const admission = tryBeginGatewayRootWorkAdmission();
  if (!admission) throw new Error("expected gateway root admission");
  const continuation = await admission.run(async () => captureGatewayRootWorkAdmissionContinuationScope());
  expect(continuation).not.toBeNull();
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  if (!suspension?.commit()) throw new Error("expected prepared suspension");
  const pending = beginGatewayRootWorkAdmissionWhenOpen();
  void pending.catch(() => {});
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("fixture.gatewayAdmission")] = { continuation, pending };
  expect(getActiveGatewayRootWorkCount()).toBe(1);
});
`,
    "04-d-gateway-admission.test.ts": `import { getActiveGatewayRootWorkCount, isGatewayRestartDraining, tryBeginGatewayRootWorkAdmission, type GatewayRootWorkAdmissionContinuationScope } from ${sourcePath("process/gateway-work-admission.ts")};
import { expect, it } from "vitest";
it("retires gateway admission before the next file", async () => {
  const state = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for("fixture.gatewayAdmission");
  const prior = state[key] as { continuation: GatewayRootWorkAdmissionContinuationScope; pending: Promise<unknown> } | undefined;
  delete state[key];
  expect(getActiveGatewayRootWorkCount()).toBe(0);
  expect(isGatewayRestartDraining()).toBe(false);
  if (!prior?.continuation) throw new Error("expected prior gateway continuation");
  await expect(prior.pending).rejects.toThrow("Gateway is draining");
  await expect(prior.continuation.run(async () => true)).rejects.toThrow("no longer active");
  const admission = tryBeginGatewayRootWorkAdmission();
  expect(admission).not.toBeNull();
  admission?.release();
});
`,
    "05-a-agent-run.test.ts": `import { getActiveGatewayRootWorkCount, markGatewayRestartDraining, tryBeginGatewayRootWorkAdmission } from ${sourcePath("process/gateway-work-admission.ts")};
import { getAgentRunContext, registerAgentRunContext } from ${sourcePath("infra/agent-run-registry.ts")};
import { emitAgentEvent, onAgentEvent } from ${sourcePath("infra/agent-events.ts")};
import { listActiveSessionsForShutdown, noteActiveSessionForShutdown } from ${sourcePath("gateway/active-sessions-shutdown-tracker.ts")};
import { expect, it } from "vitest";
it("seeds process-global run contexts", () => {
  expect(tryBeginGatewayRootWorkAdmission()).not.toBeNull();
  expect(getActiveGatewayRootWorkCount()).toBe(1);
  markGatewayRestartDraining();
  noteActiveSessionForShutdown({ cfg: {}, sessionKey: "session-a", sessionId: "session-a", storePath: "/tmp/fixture.sqlite", agentId: "main" });
  expect(listActiveSessionsForShutdown()).toHaveLength(1);
  registerAgentRunContext("unrelated-run-a", { sessionKey: "session-a" });
  registerAgentRunContext("unrelated-run-b", { sessionKey: "session-b" });
  registerAgentRunContext("reused-run", { sessionKey: "reused-session" });
  let sequence;
  const unsubscribe = onAgentEvent((event) => { sequence = event.seq; });
  emitAgentEvent({ runId: "reused-run", stream: "assistant", data: {} });
  unsubscribe();
  expect(getAgentRunContext("unrelated-run-a")).toBeDefined();
  expect(getAgentRunContext("unrelated-run-b")).toBeDefined();
  expect(sequence).toBe(1);
});
`,
    "05-b-agent-run.test.ts": `import { getActiveGatewayRootWorkCount, tryBeginGatewayRootWorkAdmission } from ${sourcePath("process/gateway-work-admission.ts")};
import { clearAgentRunContext, getAgentRunContext, registerAgentRunContext, sweepStaleRunContexts } from ${sourcePath("infra/agent-run-registry.ts")};
import { emitAgentEvent, onAgentEvent } from ${sourcePath("infra/agent-events.ts")};
import { listActiveSessionsForShutdown } from ${sourcePath("gateway/active-sessions-shutdown-tracker.ts")};
import { expect, it } from "vitest";
it("clears agent run registry state", () => {
  expect(getActiveGatewayRootWorkCount()).toBe(0);
  const admission = tryBeginGatewayRootWorkAdmission();
  expect(admission).not.toBeNull();
  admission?.release();
  expect(listActiveSessionsForShutdown()).toEqual([]);
  registerAgentRunContext("reused-run", { sessionKey: "reused-session" });
  let sequence;
  const unsubscribe = onAgentEvent((event) => { sequence = event.seq; });
  emitAgentEvent({ runId: "reused-run", stream: "assistant", data: {} });
  unsubscribe();
  expect(sequence).toBe(1);
  clearAgentRunContext("reused-run");
  registerAgentRunContext("target-run", { sessionKey: "target-session" });
  expect(sweepStaleRunContexts(-1)).toBe(1);
  expect(getAgentRunContext("target-run")).toBeUndefined();
});
`,
    "06-a-console-routing.test.ts": `import { enableConsoleCapture, routeLogsToStderr } from ${sourcePath("logging/console.ts")};
import { loggingState } from ${sourcePath("logging/state.ts")};
import { expect, it } from "vitest";
it("latches console capture and stderr routing", () => {
  const native = console.error;
  const warningListeners = process.listeners("warning");
  routeLogsToStderr();
  enableConsoleCapture();
  expect(loggingState.forceConsoleToStderr).toBe(true);
  expect(loggingState.consolePatched).toBe(true);
  expect(console.error).not.toBe(native);
  expect(process.listeners("warning")).toEqual(warningListeners);
});
`,
    // Production never unwinds those latches: a stdio MCP server or a `--json`
    // one-shot owns the console until the process exits. The next file must still
    // see its own console.error spy, not the previous file's stderr forwarder.
    "06-b-console-routing.test.ts": `import { enableConsoleCapture } from ${sourcePath("logging/console.ts")};
import { loggingState } from ${sourcePath("logging/state.ts")};
import { expect, it, vi } from "vitest";
it("starts from unrouted, unpatched console state", () => {
  const warningListeners = process.listeners("warning");
  expect(loggingState.forceConsoleToStderr).toBe(false);
  expect(loggingState.consolePatched).toBe(false);
  expect(loggingState.rawConsole).toBeNull();
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  enableConsoleCapture();
  expect(process.listeners("warning")).toEqual(warningListeners);
  console.error("routed line");
  expect(spy.mock.calls).toEqual([["routed line"]]);
  spy.mockRestore();
});
`,
    // Native require keeps only the constructors stable across module resets.
    // Plain factory closures avoid vi.fn's separate process-lifetime mock set.
    // Each census collects and traverses the heap, so check presence and release
    // across files without also scanning before allocation.
    "mock-payloads.cjs": `class ManualPayload { value = "manual"; }
class AutoPayload extends Date {}
module.exports = { ManualPayload, AutoPayload };
`,
    "07-manual-dep.ts": `export function flavor() { return "real"; }
export const untouched = "original";
`,
    "07-a-manual-payload.test.ts": `import { expect, it, vi } from "vitest";
${payloadImports}
vi.mock("./07-manual-dep.js", () => {
  const payload = new ManualPayload();
  return { flavor: () => payload.value };
});
it("creates a file-owned manual mock payload", async () => {
  const { flavor } = await import("./07-manual-dep.js");
  expect(flavor()).toBe("manual");
  expect(queryObjects(ManualPayload)).toBe(1);
});
`,
    "07-b-manual-release.test.ts": `import { expect, it } from "vitest";
${payloadImports}
it("releases the previous file manual mock payload", async () => {
  expect(queryObjects(ManualPayload)).toBe(0);
  const { flavor, untouched } = await import("./07-manual-dep.js");
  expect(flavor()).toBe("real");
  expect(untouched).toBe("original");
});
`,
    "07-c-manual-remock.test.ts": `import { expect, it, vi } from "vitest";
vi.mock("./07-manual-dep.js", async (importOriginal) => ({
  ...await importOriginal(),
  flavor: () => "remocked",
}));
it("uses a fresh partial mock after a real import", async () => {
  const { flavor, untouched } = await import("./07-manual-dep.js");
  expect(flavor()).toBe("remocked");
  expect(untouched).toBe("original");
  vi.resetModules();
  expect((await import("./07-manual-dep.js")).flavor()).toBe("remocked");
});
`,
    "07-d-manual-real.test.ts": `import { expect, it } from "vitest";
import { flavor, untouched } from "./07-manual-dep.js";
it("restores real imports after the partial mock", () => {
  expect(flavor()).toBe("real");
  expect(untouched).toBe("original");
});
`,
    "08-auto-dep.ts": `import { createRequire } from "node:module";
const { AutoPayload } = createRequire(import.meta.url)("./mock-payloads.cjs");
export const payload = new AutoPayload(1234);
`,
    "08-a-auto-payload.test.ts": `import { expect, it, vi } from "vitest";
${payloadImports}
vi.mock("./08-auto-dep.js");
it("creates a file-owned automock payload", async () => {
  const { payload } = await import("./08-auto-dep.js");
  expect(payload.getTime()).toBe(1234);
  expect(queryObjects(AutoPayload)).toBe(1);
});
`,
    "08-b-auto-release.test.ts": `import { expect, it } from "vitest";
${payloadImports}
it("releases the previous file automock payload", async () => {
  expect(queryObjects(AutoPayload)).toBe(0);
  const { payload } = await import("./08-auto-dep.js");
  expect(payload.getTime()).toBe(1234);
});
`,
    "09-redirect-dep.ts": 'export const flavor = "real";\n',
    "__mocks__/09-redirect-dep.ts": 'export const flavor = "redirected";\n',
    "09-a-redirect.test.ts": `import { expect, it, vi } from "vitest";
vi.mock("./09-redirect-dep.js");
import { flavor } from "./09-redirect-dep.js";
it("loads the redirected mock", () => {
  expect(flavor).toBe("redirected");
});
`,
    "09-b-redirect-real.test.ts": `import { expect, it } from "vitest";
import { flavor } from "./09-redirect-dep.js";
it("restores the real module after a redirect", () => {
  expect(flavor).toBe("real");
});
`,
    "09-c-redirect-remock.test.ts": `import { expect, it, vi } from "vitest";
vi.mock("./09-redirect-dep.js");
import { flavor } from "./09-redirect-dep.js";
it("reloads the redirected mock after a real import", () => {
  expect(flavor).toBe("redirected");
});
`,
    ...testApiLifecycleFixtureFiles(repoRoot),
    ...documentFocusFixtureFiles(),
  };
}

type ChildCompletion = Pick<ChildProcess, "exitCode" | "signalCode" | "killed"> & {
  code: number;
  output: string;
};

async function assertCompletion(
  child: ChildCompletion,
  expected: { root: string; pid: number | undefined; files: string[]; reportPath: string },
) {
  expect(child.code).toBe(1);
  expect(child.exitCode).toBe(1);
  expect(child.signalCode).toBeNull();
  expect(child.killed).toBe(false);

  // JSON success/suite totals are not completion evidence: skips look like passed
  // files, and unhandled errors or process teardown timeouts need native hooks.
  const capture: VitestReportCapture = JSON.parse(
    await fs.readFile(`${expected.reportPath}.capture.json`, "utf8"),
  );
  expect(expected.pid).toEqual(expect.any(Number));
  expect(capture).toMatchObject({
    pid: expected.pid,
    root: expected.root,
    processTimedOut: false,
    ended: { reason: "failed", unhandledErrors: 0, failedModules: 1, suiteErrors: 1 },
  });
  const project = {
    name: "non-isolated-runner",
    root: expected.root,
    config: `${expected.root}/vitest.config.ts`,
    pool: "forks",
  };
  expect(capture.projects).toEqual([project]);
  expect(capture.modules.map((module) => module.file).toSorted()).toEqual(expected.files);
  for (const module of capture.modules) {
    expect(module).toMatchObject(project);
  }

  const report: JsonTestResults = JSON.parse(await fs.readFile(expected.reportPath, "utf8"));
  expect(report.testResults.map((file) => file.name).toSorted()).toEqual(expected.files);
  expect(report).toMatchObject({
    numTotalTests: 46,
    numPassedTests: 45,
    numPendingTests: 1,
    numFailedTests: 0,
    numTodoTests: 0,
  });
  for (const file of report.testResults) {
    const name = path.basename(file.name);
    const crashed = name === "01-a-crash.test.ts";
    const skipped = name === "09-f-test-api-skipped.test.ts";
    const lifecycle = ["09-d-test-api-producer.test.ts", "09-e-test-api-observer.test.ts"].includes(
      name,
    );
    const count = crashed ? 0 : lifecycle ? 2 : 1;
    expect(file.status, name).toBe(crashed ? "failed" : "passed");
    expect(file.message, name).toBe(crashed ? "synthetic collect failure" : "");
    expect(file.assertionResults, name).toHaveLength(count);
    expect(new Set(file.assertionResults.map((test) => test.fullName)).size, name).toBe(count);
    for (const test of file.assertionResults) {
      expect(test, name).toMatchObject({
        fullName: expect.stringMatching(/\S/u),
        status: skipped ? "skipped" : "passed",
        failureMessages: [],
      });
    }
  }
  for (const generation of ["producer", "observer"]) {
    expect(child.output).toContain(`test API lifecycle: ${generation} afterAll passed`);
    expect(child.output).toContain(`test API lifecycle: ${generation} resource teardown passed`);
  }
  expect(child.output).not.toContain("first-file");
}

async function verifyRunnerCleanup(signal: AbortSignal) {
  // Outside the enclosing Vitest TMPDIR: outer cleanup must not erase unjoined writers.
  const fixtureRoots = path.join(repoRoot, ".artifacts", "non-isolated-runner");
  await fs.mkdir(fixtureRoots, { recursive: true });
  const root = await fs.mkdtemp(path.join(fixtureRoots, "run-"));
  try {
    const vitestPackageDir = path.dirname(require.resolve("vitest/package.json"));
    await fs.symlink(path.dirname(vitestPackageDir), path.join(root, "node_modules"), "junction");
    const files = fixtureFiles();
    for (const [name, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await fs.writeFile(path.join(root, name), content, "utf8");
    }
    // This real source uses only type imports; Node can retain its native generation.
    await fs.writeFile(
      path.join(root, "vitest.config.ts"),
      `import { sharedVitestConfig } from ${JSON.stringify(path.join(repoRoot, "test", "vitest", "vitest.shared.config.ts"))};
import { defineConfig } from "vitest/config";
import { BaseSequencer } from "vitest/node";
class AlphabeticalSequencer extends BaseSequencer {
  override async sort(files: Parameters<BaseSequencer["sort"]>[0]) {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}
export default defineConfig({
  cacheDir: ${JSON.stringify(path.join(root, ".vite"))},
  resolve: sharedVitestConfig.resolve,
  test: {
    name: "non-isolated-runner",
    isolate: false,
    fileParallelism: false,
    maxWorkers: 1,
    server: { deps: { external: [new RegExp(${JSON.stringify(
      `^${path
        .join(repoRoot, "src/cron/service/active-run-cancellation.ts")
        .replaceAll("\\", "/")
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    )})] } },
    sequence: { sequencer: AlphabeticalSequencer },
    runner: ${JSON.stringify(path.join(root, "runner.ts"))},
  },
});
`,
      "utf8",
    );

    const reportPath = path.join(root, "report.json");
    let child!: ChildProcess;
    const result = await runVitestShutdownCommand({
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
        `--reporter=${path.join(repoRoot, "scripts/lib/vitest-report-capture.mts")}`,
        `--outputFile.json=${reportPath}`,
      ],
      cwd: repoRoot,
      env: childEnv(),
      maxBytes: 16 * 1024 * 1024,
      signal,
      onReady(owned) {
        child = owned;
      },
    });
    const completion: ChildCompletion = {
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      killed: child.killed,
      code: result.code,
      output: `${result.stdout}\n${result.stderr}`,
    };
    const canonicalRoot = (await fs.realpath(root)).replaceAll(path.sep, "/");
    const expected = {
      root: canonicalRoot,
      pid: child.pid,
      files: Object.keys(files)
        .filter((name) => name.endsWith(".test.ts"))
        .map((name) => `${canonicalRoot}/${name}`)
        .toSorted(),
      reportPath,
    };
    await assertCompletion(completion, expected);

    // Replay faults against this one completed child, not new fixture executions.
    // The same assertion path must reject incomplete proof even with a good summary.
    const capturePath = `${reportPath}.capture.json`;
    const originals = [
      await fs.readFile(reportPath, "utf8"),
      await fs.readFile(capturePath, "utf8"),
    ];
    for (const [index, artifact] of [reportPath, capturePath].entries()) {
      for (const contents of [null, "{", "null", "{}"]) {
        if (contents === null) await fs.rm(artifact);
        else await fs.writeFile(artifact, contents);
        await expect(
          assertCompletion(completion, expected),
          `rejects missing/corrupt ${path.basename(artifact)}: ${contents}`,
        ).rejects.toThrow();
        await fs.writeFile(artifact, originals[index]!);
      }
    }
    type Replay = { child: ChildCompletion; report: JsonTestResults; capture: VitestReportCapture };
    const faults: [string, (replay: Replay) => void][] = [
      ["missing project", ({ capture }) => capture.projects.pop()],
      [
        "wrong module project",
        ({ capture }) => Object.assign(capture.modules[0]!, { name: "other" }),
      ],
      ["omitted module", ({ capture }) => capture.modules.pop()],
      ["duplicated module", ({ capture }) => capture.modules.splice(1, 1, capture.modules[0]!)],
      ["unexpected module", ({ capture }) => Object.assign(capture.modules[0]!, { file: "other" })],
      ["omitted file", ({ report }) => report.testResults.pop()],
      ["duplicated file", ({ report }) => report.testResults.splice(1, 1, report.testResults[0]!)],
      ["unexpected file", ({ report }) => Object.assign(report.testResults[0]!, { name: "other" })],
      [
        "extra collection error",
        ({ report }) => Object.assign(report.testResults[1]!, { message: "other" }),
      ],
      [
        "extra failed file",
        ({ report }) => Object.assign(report.testResults[1]!, { status: "failed" }),
      ],
      [
        "wrong collection error",
        ({ report }) => Object.assign(report.testResults[0]!, { message: "other" }),
      ],
      ["inconsistent totals", ({ report }) => Object.assign(report, { numPassedTests: 44 })],
    ];
    for (const patch of [
      { ended: undefined },
      { processTimedOut: true },
      { pid: child.pid! + 1 },
      { root: "other" },
    ]) {
      faults.push([
        `invalid native capture: ${JSON.stringify(patch)}`,
        ({ capture }) => Object.assign(capture, patch),
      ]);
    }
    for (const patch of [
      { reason: "interrupted" },
      { reason: "passed" },
      { unhandledErrors: 1 },
      { failedModules: 0 },
      { failedModules: 2 },
      { suiteErrors: 0 },
      { suiteErrors: 2 },
    ]) {
      faults.push([
        `invalid native end: ${JSON.stringify(patch)}`,
        ({ capture }) => Object.assign(capture.ended!, patch),
      ]);
    }
    for (const patch of [
      { code: 0 },
      { code: 2 },
      { code: 143 },
      { exitCode: 0 },
      { exitCode: 2 },
      { exitCode: null },
      { signalCode: "SIGTERM" },
      { killed: true },
    ] satisfies Partial<ChildCompletion>[]) {
      faults.push([
        `abnormal child completion: ${JSON.stringify(patch)}`,
        ({ child }) => Object.assign(child, patch),
      ]);
    }
    const nativeReport: JsonTestResults = JSON.parse(originals[0]!);
    for (const [index, file] of nativeReport.testResults.entries()) {
      if (!file.assertionResults.length) continue;
      const name = path.basename(file.name);
      for (const status of ["pending", "skipped", "todo", "failed", "passed"] as const) {
        if (status === file.assertionResults[0]!.status) continue;
        faults.push([
          `${name}: unexpected ${status} assertion`,
          ({ report }) => {
            report.testResults[index]!.assertionResults.at(-1)!.status = status;
          },
        ]);
      }
      faults.push(
        [
          `${name}: omitted assertion`,
          ({ report }) => report.testResults[index]!.assertionResults.pop(),
        ],
        [
          `${name}: extra assertion`,
          ({ report }) =>
            report.testResults[index]!.assertionResults.push(file.assertionResults[0]!),
        ],
        [
          `${name}: failure messages`,
          ({ report }) =>
            Object.assign(report.testResults[index]!.assertionResults[0]!, {
              failureMessages: ["unexpected failure"],
            }),
        ],
      );
      if (file.assertionResults.length > 1) {
        faults.push([
          `${name}: duplicated assertion replacing its sibling`,
          ({ report }) => {
            report.testResults[index]!.assertionResults[1] =
              report.testResults[index]!.assertionResults[0]!;
          },
        ]);
      }
    }
    for (const generation of ["producer", "observer"]) {
      for (const phase of ["afterAll", "resource teardown"]) {
        faults.push([
          `missing ${generation} ${phase} marker`,
          ({ child }) => {
            child.output = child.output.replace(
              `test API lifecycle: ${generation} ${phase} passed`,
              "",
            );
          },
        ]);
      }
    }
    for (const [label, mutate] of faults) {
      const replay: Replay = {
        child: { ...completion },
        report: JSON.parse(originals[0]!),
        capture: JSON.parse(originals[1]!),
      };
      mutate(replay);
      await fs.writeFile(reportPath, JSON.stringify(replay.report));
      await fs.writeFile(capturePath, JSON.stringify(replay.capture));
      await expect(assertCompletion(replay.child, expected), label).rejects.toThrow();
    }
    // Release only after the managed child/group/output join and native proof.
    await fs.rm(root, { recursive: true, force: true });
  } catch (error) {
    if (error instanceof Error) {
      error.message += `; retained fixture ${root}`;
    }
    throw error;
  }
}

it("cleans every shared runner surface between files", (context) => {
  const run = verifyRunnerCleanup(context.signal);
  // Timeout rejects Vitest's wrapper before this promise settles. Join it again
  // at completion so cancellation and fixture writes cannot cross file cleanup.
  context.onTestFinished(() => run);
  return run;
});

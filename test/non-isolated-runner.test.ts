// Regression coverage for the non-isolated runner's cross-file cleanup. Keep
// every producer/observer pair in one child run: the contract is file-to-file
// cleanup, not five independent Vitest process boots.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
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
  const gatewayMocksPath = JSON.stringify(
    path.join(repoRoot, "src", "gateway", "test-helpers.mocks.ts"),
  );
  const runtimeStorePath = JSON.stringify(
    path.join(repoRoot, "src", "plugin-sdk", "runtime-store.ts"),
  );
  const sessionSuspensionPath = JSON.stringify(
    path.join(repoRoot, "src", "agents", "session-suspension.ts"),
  );
  const agentRunRegistryPath = JSON.stringify(
    path.join(repoRoot, "src", "infra", "agent-run-registry.ts"),
  );
  const agentEventsPath = JSON.stringify(path.join(repoRoot, "src", "infra", "agent-events.ts"));
  const activeSessionsPath = JSON.stringify(
    path.join(repoRoot, "src", "gateway", "active-sessions-shutdown-tracker.ts"),
  );
  const loggingConsolePath = JSON.stringify(path.join(repoRoot, "src", "logging", "console.ts"));
  const loggingStatePath = JSON.stringify(path.join(repoRoot, "src", "logging", "state.ts"));
  const testEnvPath = JSON.stringify(path.join(repoRoot, "src", "test-utils", "env.ts"));
  const payloadImports = [
    'import { createRequire } from "node:module";',
    'import { queryObjects } from "node:v8";',
    'const { ManualPayload, AutoPayload } = createRequire(import.meta.url)("./mock-payloads.cjs");',
  ].join("\n");

  return {
    "runner.ts": `export { default } from ${JSON.stringify(path.join(repoRoot, "test", "non-isolated-runner.ts"))};\n`,
    "01-dep.ts": 'export function flavor(): string {\n  return "real";\n}\n',
    "01-mid.ts": [
      'import { flavor } from "./01-dep.js";',
      "export function describeFlavor(): string {",
      "  return `flavor:${flavor()}`;",
      "}",
      "",
    ].join("\n"),
    // Evaluate the real importer graph, then fail collection. The following
    // file must still apply its mock after onAfterRunFiles cleanup.
    "01-a-crash.test.ts": 'import "./01-mid.js";\nthrow new Error("synthetic collect failure");\n',
    "01-b-mock.test.ts": [
      'import { expect, it, vi } from "vitest";',
      'vi.mock("./01-dep.js", () => ({ flavor: () => "mocked" }));',
      'const { describeFlavor } = await import("./01-mid.js");',
      'it("applies mocks after a sibling collection failure", () => {',
      '  expect(describeFlavor()).toBe("flavor:mocked");',
      "});",
      "",
    ].join("\n"),
    "02-a-gateway-env.test.ts": [
      `import ${gatewayMocksPath};`,
      'import { expect, it } from "vitest";',
      'it("seeds gateway helper env", () => {',
      '  expect(process.env.OPENCLAW_SKIP_CHANNELS).toBe("1");',
      '  expect(process.env.OPENCLAW_SKIP_CRON).toBe("1");',
      "});",
      "",
    ].join("\n"),
    "02-b-gateway-env.test.ts": [
      'import { expect, it } from "vitest";',
      'it("restores gateway helper env", () => {',
      "  expect(process.env.OPENCLAW_SKIP_CHANNELS).toBeUndefined();",
      "  expect(process.env.OPENCLAW_SKIP_CRON).toBeUndefined();",
      "});",
      "",
    ].join("\n"),
    "02-c-agent-env.test.ts": [
      `import { setTestEnvValue } from ${testEnvPath};`,
      'import { expect, it, vi } from "vitest";',
      'it("leaves agent selectors for file-completion env unstub", () => {',
      "  expect(process.env.HOME).toBe(process.env.OPENCLAW_TEST_HOME);",
      "  expect(process.env.OPENCLAW_TEST_HOME).toBeTruthy();",
      '  for (const key of ["OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"]) {',
      "    setTestEnvValue(key, `/tmp/inherited-${key}`);",
      "    vi.stubEnv(key, undefined);",
      "    expect(process.env[key]).toBeUndefined();",
      "  }",
      "});",
      "",
    ].join("\n"),
    "02-d-agent-env.test.ts": [
      'import { expect, it } from "vitest";',
      'it("clears restored agent selectors before the next file", () => {',
      "  expect(process.env.HOME).toBe(process.env.OPENCLAW_TEST_HOME);",
      "  expect(process.env.OPENCLAW_AGENT_DIR).toBeUndefined();",
      "  expect(process.env.PI_CODING_AGENT_DIR).toBeUndefined();",
      "});",
      "",
    ].join("\n"),
    "03-a-runtime-store.test.ts": [
      `import { createPluginRuntimeStore } from ${runtimeStorePath};`,
      'import { expect, it } from "vitest";',
      'const store = createPluginRuntimeStore({ pluginId: "fixture", errorMessage: "missing" });',
      'it("seeds a named runtime slot", () => {',
      '  store.setRuntime({ source: "first-file" });',
      '  expect(store.getRuntime()).toEqual({ source: "first-file" });',
      "});",
      "",
    ].join("\n"),
    "03-b-runtime-store.test.ts": [
      `import { createPluginRuntimeStore } from ${runtimeStorePath};`,
      'import { expect, it } from "vitest";',
      'const store = createPluginRuntimeStore({ pluginId: "fixture", errorMessage: "missing" });',
      'it("clears named runtime slots", () => {',
      "  expect(store.tryGetRuntime()).toBeNull();",
      "});",
      "",
    ].join("\n"),
    "04-a-session-suspension.test.ts": [
      `import { fenceSessionSuspensionWritesForGatewayShutdown } from ${sessionSuspensionPath};`,
      'import { expect, it } from "vitest";',
      'const testApi = (globalThis as Record<PropertyKey, { isSessionSuspensionWriteCleanupActiveForTest(): boolean }>)[Symbol.for("openclaw.sessionSuspensionTestApi")];',
      'it("seeds the session suspension shutdown fence", () => {',
      "  fenceSessionSuspensionWritesForGatewayShutdown();",
      "  expect(testApi?.isSessionSuspensionWriteCleanupActiveForTest()).toBe(true);",
      "});",
      "",
    ].join("\n"),
    "04-b-session-suspension.test.ts": [
      `import ${sessionSuspensionPath};`,
      'import { expect, it } from "vitest";',
      'const testApi = (globalThis as Record<PropertyKey, { isSessionSuspensionWriteCleanupActiveForTest(): boolean }>)[Symbol.for("openclaw.sessionSuspensionTestApi")];',
      'it("clears the session suspension shutdown fence", () => {',
      "  expect(testApi?.isSessionSuspensionWriteCleanupActiveForTest()).toBe(false);",
      "});",
      "",
    ].join("\n"),
    "05-a-agent-run.test.ts": [
      `import { getAgentRunContext, registerAgentRunContext } from ${agentRunRegistryPath};`,
      `import { emitAgentEvent, onAgentEvent } from ${agentEventsPath};`,
      `import { listActiveSessionsForShutdown, noteActiveSessionForShutdown } from ${activeSessionsPath};`,
      'import { expect, it } from "vitest";',
      'it("seeds process-global run contexts", () => {',
      '  noteActiveSessionForShutdown({ cfg: {}, sessionKey: "session-a", sessionId: "session-a", storePath: "/tmp/fixture.sqlite", agentId: "main" });',
      "  expect(listActiveSessionsForShutdown()).toHaveLength(1);",
      '  registerAgentRunContext("unrelated-run-a", { sessionKey: "session-a" });',
      '  registerAgentRunContext("unrelated-run-b", { sessionKey: "session-b" });',
      '  registerAgentRunContext("reused-run", { sessionKey: "reused-session" });',
      "  let sequence;",
      "  const unsubscribe = onAgentEvent((event) => { sequence = event.seq; });",
      '  emitAgentEvent({ runId: "reused-run", stream: "assistant", data: {} });',
      "  unsubscribe();",
      '  expect(getAgentRunContext("unrelated-run-a")).toBeDefined();',
      '  expect(getAgentRunContext("unrelated-run-b")).toBeDefined();',
      "  expect(sequence).toBe(1);",
      "});",
      "",
    ].join("\n"),
    "05-b-agent-run.test.ts": [
      `import { clearAgentRunContext, getAgentRunContext, registerAgentRunContext, sweepStaleRunContexts } from ${agentRunRegistryPath};`,
      `import { emitAgentEvent, onAgentEvent } from ${agentEventsPath};`,
      `import { listActiveSessionsForShutdown } from ${activeSessionsPath};`,
      'import { expect, it } from "vitest";',
      'it("clears agent run registry state", () => {',
      "  expect(listActiveSessionsForShutdown()).toEqual([]);",
      '  registerAgentRunContext("reused-run", { sessionKey: "reused-session" });',
      "  let sequence;",
      "  const unsubscribe = onAgentEvent((event) => { sequence = event.seq; });",
      '  emitAgentEvent({ runId: "reused-run", stream: "assistant", data: {} });',
      "  unsubscribe();",
      "  expect(sequence).toBe(1);",
      '  clearAgentRunContext("reused-run");',
      '  registerAgentRunContext("target-run", { sessionKey: "target-session" });',
      "  expect(sweepStaleRunContexts(-1)).toBe(1);",
      '  expect(getAgentRunContext("target-run")).toBeUndefined();',
      "});",
      "",
    ].join("\n"),
    "06-a-console-routing.test.ts": [
      `import { enableConsoleCapture, routeLogsToStderr } from ${loggingConsolePath};`,
      `import { loggingState } from ${loggingStatePath};`,
      'import { expect, it } from "vitest";',
      'it("latches console capture and stderr routing", () => {',
      "  const native = console.error;",
      '  const warningListeners = process.listeners("warning");',
      "  routeLogsToStderr();",
      "  enableConsoleCapture();",
      "  expect(loggingState.forceConsoleToStderr).toBe(true);",
      "  expect(loggingState.consolePatched).toBe(true);",
      "  expect(console.error).not.toBe(native);",
      '  expect(process.listeners("warning")).toEqual(warningListeners);',
      "});",
      "",
    ].join("\n"),
    // Production never unwinds those latches: a stdio MCP server or a `--json`
    // one-shot owns the console until the process exits. The next file must still
    // see its own console.error spy, not the previous file's stderr forwarder.
    "06-b-console-routing.test.ts": [
      `import { enableConsoleCapture } from ${loggingConsolePath};`,
      `import { loggingState } from ${loggingStatePath};`,
      'import { expect, it, vi } from "vitest";',
      'it("starts from unrouted, unpatched console state", () => {',
      '  const warningListeners = process.listeners("warning");',
      "  expect(loggingState.forceConsoleToStderr).toBe(false);",
      "  expect(loggingState.consolePatched).toBe(false);",
      "  expect(loggingState.rawConsole).toBeNull();",
      '  const spy = vi.spyOn(console, "error").mockImplementation(() => {});',
      "  enableConsoleCapture();",
      '  expect(process.listeners("warning")).toEqual(warningListeners);',
      '  console.error("routed line");',
      '  expect(spy.mock.calls).toEqual([["routed line"]]);',
      "  spy.mockRestore();",
      "});",
      "",
    ].join("\n"),
    // Native require keeps only the constructors stable across module resets.
    // Plain factory closures avoid vi.fn's separate process-lifetime mock set.
    // Each census collects and traverses the heap, so check presence and release
    // across files without also scanning before allocation.
    "mock-payloads.cjs": [
      'class ManualPayload { value = "manual"; }',
      "class AutoPayload extends Date {}",
      "module.exports = { ManualPayload, AutoPayload };",
      "",
    ].join("\n"),
    "07-manual-dep.ts": [
      'export function flavor() { return "real"; }',
      'export const untouched = "original";',
      "",
    ].join("\n"),
    "07-a-manual-payload.test.ts": [
      'import { expect, it, vi } from "vitest";',
      payloadImports,
      'vi.mock("./07-manual-dep.js", () => {',
      "  const payload = new ManualPayload();",
      "  return { flavor: () => payload.value };",
      "});",
      'it("creates a file-owned manual mock payload", async () => {',
      '  const { flavor } = await import("./07-manual-dep.js");',
      '  expect(flavor()).toBe("manual");',
      "  expect(queryObjects(ManualPayload)).toBe(1);",
      "});",
      "",
    ].join("\n"),
    "07-b-manual-release.test.ts": [
      'import { expect, it } from "vitest";',
      payloadImports,
      'it("releases the previous file manual mock payload", async () => {',
      "  expect(queryObjects(ManualPayload)).toBe(0);",
      '  const { flavor, untouched } = await import("./07-manual-dep.js");',
      '  expect(flavor()).toBe("real");',
      '  expect(untouched).toBe("original");',
      "});",
      "",
    ].join("\n"),
    "07-c-manual-remock.test.ts": [
      'import { expect, it, vi } from "vitest";',
      'vi.mock("./07-manual-dep.js", async (importOriginal) => ({',
      "  ...await importOriginal(),",
      '  flavor: () => "remocked",',
      "}));",
      'it("uses a fresh partial mock after a real import", async () => {',
      '  const { flavor, untouched } = await import("./07-manual-dep.js");',
      '  expect(flavor()).toBe("remocked");',
      '  expect(untouched).toBe("original");',
      "  vi.resetModules();",
      '  expect((await import("./07-manual-dep.js")).flavor()).toBe("remocked");',
      "});",
      "",
    ].join("\n"),
    "07-d-manual-real.test.ts": [
      'import { expect, it } from "vitest";',
      'import { flavor, untouched } from "./07-manual-dep.js";',
      'it("restores real imports after the partial mock", () => {',
      '  expect(flavor()).toBe("real");',
      '  expect(untouched).toBe("original");',
      "});",
      "",
    ].join("\n"),
    "08-auto-dep.ts": [
      'import { createRequire } from "node:module";',
      'const { AutoPayload } = createRequire(import.meta.url)("./mock-payloads.cjs");',
      "export const payload = new AutoPayload(1234);",
      "",
    ].join("\n"),
    "08-a-auto-payload.test.ts": [
      'import { expect, it, vi } from "vitest";',
      payloadImports,
      'vi.mock("./08-auto-dep.js");',
      'it("creates a file-owned automock payload", async () => {',
      '  const { payload } = await import("./08-auto-dep.js");',
      "  expect(payload.getTime()).toBe(1234);",
      "  expect(queryObjects(AutoPayload)).toBe(1);",
      "});",
      "",
    ].join("\n"),
    "08-b-auto-release.test.ts": [
      'import { expect, it } from "vitest";',
      payloadImports,
      'it("releases the previous file automock payload", async () => {',
      "  expect(queryObjects(AutoPayload)).toBe(0);",
      '  const { payload } = await import("./08-auto-dep.js");',
      "  expect(payload.getTime()).toBe(1234);",
      "});",
      "",
    ].join("\n"),
    "09-redirect-dep.ts": 'export const flavor = "real";\n',
    "__mocks__/09-redirect-dep.ts": 'export const flavor = "redirected";\n',
    "09-a-redirect.test.ts": [
      'import { expect, it, vi } from "vitest";',
      'vi.mock("./09-redirect-dep.js");',
      'import { flavor } from "./09-redirect-dep.js";',
      'it("loads the redirected mock", () => {',
      '  expect(flavor).toBe("redirected");',
      "});",
      "",
    ].join("\n"),
    "09-b-redirect-real.test.ts": [
      'import { expect, it } from "vitest";',
      'import { flavor } from "./09-redirect-dep.js";',
      'it("restores the real module after a redirect", () => {',
      '  expect(flavor).toBe("real");',
      "});",
      "",
    ].join("\n"),
    "09-c-redirect-remock.test.ts": [
      'import { expect, it, vi } from "vitest";',
      'vi.mock("./09-redirect-dep.js");',
      'import { flavor } from "./09-redirect-dep.js";',
      'it("reloads the redirected mock after a real import", () => {',
      '  expect(flavor).toBe("redirected");',
      "});",
      "",
    ].join("\n"),
    ...documentFocusFixtureFiles(),
  };
}

it("cleans every shared runner surface between files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-non-isolated-runner-"));
  try {
    const vitestPackageDir = path.dirname(require.resolve("vitest/package.json"));
    await fs.symlink(path.dirname(vitestPackageDir), path.join(root, "node_modules"), "junction");
    for (const [name, content] of Object.entries(fixtureFiles())) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await fs.writeFile(path.join(root, name), content, "utf8");
    }
    await fs.writeFile(
      path.join(root, "vitest.config.ts"),
      [
        `import { sharedVitestConfig } from ${JSON.stringify(path.join(repoRoot, "test", "vitest", "vitest.shared.config.ts"))};`,
        'import { defineConfig } from "vitest/config";',
        'import { BaseSequencer } from "vitest/node";',
        "class AlphabeticalSequencer extends BaseSequencer {",
        '  override async sort(files: Parameters<BaseSequencer["sort"]>[0]) {',
        "    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));",
        "  }",
        "}",
        "export default defineConfig({",
        `  cacheDir: ${JSON.stringify(path.join(root, ".vite"))},`,
        "  resolve: sharedVitestConfig.resolve,",
        "  test: {",
        "    isolate: false,",
        "    fileParallelism: false,",
        "    maxWorkers: 1,",
        "    sequence: { sequencer: AlphabeticalSequencer },",
        `    runner: ${JSON.stringify(path.join(root, "runner.ts"))},`,
        "  },",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await execFileAsync(
      process.execPath,
      [
        path.join(vitestPackageDir, "vitest.mjs"),
        "run",
        "--root",
        root,
        "--config",
        path.join(root, "vitest.config.ts"),
        "--configLoader",
        "runner",
      ],
      { cwd: repoRoot, env: childEnv(), maxBuffer: 16 * 1024 * 1024 },
    ).catch((error: unknown) => error as { stdout?: string; stderr?: string });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

    // The collection failure is intentional. Every behavior test after it must
    // pass; any leaked surface turns the summary into a second failure.
    expect(output).toContain("synthetic collect failure");
    expect(output).toContain("1 failed | 34 passed");
    expect(output).not.toContain("first-file");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

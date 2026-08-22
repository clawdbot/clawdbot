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
  const loggingConsolePath = JSON.stringify(path.join(repoRoot, "src", "logging", "console.ts"));
  const loggingStatePath = JSON.stringify(path.join(repoRoot, "src", "logging", "state.ts"));

  return {
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
      'import { expect, it } from "vitest";',
      'it("seeds process-global run contexts", () => {',
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
      'import { expect, it } from "vitest";',
      'it("clears agent run registry state", () => {',
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
      "  routeLogsToStderr();",
      "  enableConsoleCapture();",
      "  expect(loggingState.forceConsoleToStderr).toBe(true);",
      "  expect(loggingState.consolePatched).toBe(true);",
      "  expect(console.error).not.toBe(native);",
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
      "  expect(loggingState.forceConsoleToStderr).toBe(false);",
      "  expect(loggingState.consolePatched).toBe(false);",
      "  expect(loggingState.rawConsole).toBeNull();",
      '  const spy = vi.spyOn(console, "error").mockImplementation(() => {});',
      "  enableConsoleCapture();",
      '  console.error("routed line");',
      '  expect(spy.mock.calls).toEqual([["routed line"]]);',
      "  spy.mockRestore();",
      "});",
      "",
    ].join("\n"),
  };
}

it("cleans every shared runner surface between files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-non-isolated-runner-"));
  try {
    const vitestPackageDir = path.dirname(require.resolve("vitest/package.json"));
    await fs.symlink(path.dirname(vitestPackageDir), path.join(root, "node_modules"), "junction");
    for (const [name, content] of Object.entries(fixtureFiles())) {
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
        `    runner: ${JSON.stringify(path.join(repoRoot, "test", "non-isolated-runner.ts"))},`,
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
      ],
      { cwd: repoRoot, env: childEnv(), maxBuffer: 16 * 1024 * 1024 },
    ).catch((error: unknown) => error as { stdout?: string; stderr?: string });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

    // The collection failure is intentional. Every behavior test after it must
    // pass; any leaked surface turns the summary into a second failure.
    expect(output).toContain("synthetic collect failure");
    expect(output).toContain("1 failed | 11 passed");
    expect(output).not.toContain("first-file");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

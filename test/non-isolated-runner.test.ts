// Regression coverage for the non-isolated runner's cross-file cleanup: when a
// sibling file fails during collection, vitest skips onAfterRunSuite for it, so
// cleanup must run from onAfterRunFiles or the crashed file's evaluated real
// modules stay cached and the next file's vi.mock factories silently never apply.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Drop parent Vitest state so the child run resolves its own config, and
    // drop GITHUB_ACTIONS so the child's github-actions reporter cannot emit
    // ::error annotations that the parent CI job renders as its own failures.
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
  // "CI" in env alone turns tinyrainbow colors on; NO_COLOR overrides every
  // enable path, keeping the plain-text substring assertions below stable.
  env.NO_COLOR = "1";
  return env;
}

it("applies vi.mock factories after a sibling file fails during collection", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-non-isolated-runner-"));
  try {
    const write = (name: string, content: string) =>
      fs.writeFile(path.join(root, name), content, "utf-8");
    // The child project resolves vitest through the repository install.
    await fs.symlink(
      path.join(repoRoot, "node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    await write("dep.ts", 'export function flavor(): string {\n  return "real";\n}\n');
    await write(
      "mid.ts",
      [
        'import { flavor } from "./dep.js";',
        "export function describeFlavor(): string {",
        "  return `flavor:${flavor()}`;",
        "}",
        "",
      ].join("\n"),
    );
    // Evaluates the real mid->dep chain into the shared module cache, then
    // fails collection so runSuite early-returns without onAfterRunSuite.
    await write(
      "a-crash.test.ts",
      'import "./mid.js";\nthrow new Error("synthetic collect failure");\n',
    );
    // Mocks the leaf module and observes it through the cached importer; with a
    // poisoned cache this sees "flavor:real" instead of the mocked value.
    await write(
      "b-mock.test.ts",
      [
        'import { expect, it, vi } from "vitest";',
        'vi.mock("./dep.js", () => ({ flavor: () => "mocked" }));',
        'const { describeFlavor } = await import("./mid.js");',
        'it("sees the mocked module through its importer", () => {',
        '  expect(describeFlavor()).toBe("flavor:mocked");',
        "});",
        "",
      ].join("\n"),
    );
    await write(
      "vitest.config.ts",
      [
        `import { sharedVitestConfig } from ${JSON.stringify(path.join(repoRoot, "test", "vitest", "vitest.shared.config.ts"))};`,
        'import { defineConfig } from "vitest/config";',
        'import { BaseSequencer } from "vitest/node";',
        "// Alphabetical order keeps a-crash collected before b-mock regardless of",
        "// the duration cache; the leak only reproduces in that order.",
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
    );

    const vitestEntry = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
    const result = await execFileAsync(
      process.execPath,
      [vitestEntry, "run", "--root", root, "--config", path.join(root, "vitest.config.ts")],
      { cwd: repoRoot, env: childEnv(), maxBuffer: 16 * 1024 * 1024 },
    ).catch((error: unknown) => error as { stdout?: string; stderr?: string });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

    // The crash file must fail collection first, and the mock file must still
    // pass; a poisoned module cache turns b-mock into the second failure.
    expect(output).toContain("synthetic collect failure");
    expect(output).toContain("1 failed | 1 passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("restores gateway helper env stubs between files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-env-runner-"));
  try {
    const write = (name: string, content: string) =>
      fs.writeFile(path.join(root, name), content, "utf-8");
    const gatewayMocksPath = JSON.stringify(
      path.join(repoRoot, "src", "gateway", "test-helpers.mocks.ts"),
    );
    const sharedVitestConfigPath = JSON.stringify(
      path.join(repoRoot, "test", "vitest", "vitest.shared.config.ts"),
    );
    await fs.symlink(
      path.join(repoRoot, "node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    await write(
      "a-import.test.ts",
      [
        `import ${gatewayMocksPath};`,
        'import { expect, it } from "vitest";',
        'it("applies the gateway test defaults", () => {',
        '  expect(process.env.OPENCLAW_SKIP_CHANNELS).toBe("1");',
        '  expect(process.env.OPENCLAW_SKIP_CRON).toBe("1");',
        "});",
        "",
      ].join("\n"),
    );
    await write(
      "b-observe.test.ts",
      [
        'import { expect, it } from "vitest";',
        'it("starts without gateway test env from the previous file", () => {',
        "  expect(process.env.OPENCLAW_SKIP_CHANNELS).toBeUndefined();",
        "  expect(process.env.OPENCLAW_SKIP_CRON).toBeUndefined();",
        "});",
        "",
      ].join("\n"),
    );
    await write(
      "vitest.config.ts",
      [
        `import { sharedVitestConfig } from ${sharedVitestConfigPath};`,
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
    );

    const env = childEnv();
    delete env.OPENCLAW_SKIP_CHANNELS;
    delete env.OPENCLAW_SKIP_CRON;
    const vitestEntry = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
    const result = await execFileAsync(
      process.execPath,
      [vitestEntry, "run", "--root", root, "--config", path.join(root, "vitest.config.ts")],
      { cwd: repoRoot, env, maxBuffer: 16 * 1024 * 1024 },
    );
    expect(`${result.stdout}\n${result.stderr}`).toContain("2 passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("clears named plugin runtime slots between files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runtime-store-runner-"));
  try {
    const write = (name: string, content: string) =>
      fs.writeFile(path.join(root, name), content, "utf-8");
    const runtimeStorePath = JSON.stringify(
      path.join(repoRoot, "src", "plugin-sdk", "runtime-store.ts"),
    );
    await fs.symlink(
      path.join(repoRoot, "node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    await write(
      "a-seed.test.ts",
      [
        `import { createPluginRuntimeStore } from ${runtimeStorePath};`,
        'import { expect, it } from "vitest";',
        'const store = createPluginRuntimeStore({ pluginId: "fixture", errorMessage: "missing" });',
        'it("seeds a named runtime slot", () => {',
        '  store.setRuntime({ source: "first-file" });',
        '  expect(store.getRuntime()).toEqual({ source: "first-file" });',
        "});",
        "",
      ].join("\n"),
    );
    await write(
      "b-observe.test.ts",
      [
        `import { createPluginRuntimeStore } from ${runtimeStorePath};`,
        'import { expect, it } from "vitest";',
        'const store = createPluginRuntimeStore({ pluginId: "fixture", errorMessage: "missing" });',
        'it("starts without a runtime from the previous file", () => {',
        "  expect(store.tryGetRuntime()).toBeNull();",
        "});",
        "",
      ].join("\n"),
    );
    await write(
      "vitest.config.ts",
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
    );

    const vitestEntry = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
    const result = await execFileAsync(
      process.execPath,
      [vitestEntry, "run", "--root", root, "--config", path.join(root, "vitest.config.ts")],
      { cwd: repoRoot, env: childEnv(), maxBuffer: 16 * 1024 * 1024 },
    ).catch((error: unknown) => error as { stdout?: string; stderr?: string });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

    expect(output).toContain("2 passed");
    expect(output).not.toContain("first-file");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("clears the session suspension shutdown fence between files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-suspension-runner-"));
  try {
    const write = (name: string, content: string) =>
      fs.writeFile(path.join(root, name), content, "utf-8");
    const sessionSuspensionPath = JSON.stringify(
      path.join(repoRoot, "src", "agents", "session-suspension.ts"),
    );
    const sharedVitestConfigPath = JSON.stringify(
      path.join(repoRoot, "test", "vitest", "vitest.shared.config.ts"),
    );
    await fs.symlink(
      path.join(repoRoot, "node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    await write(
      "a-seed.test.ts",
      [
        `import { fenceSessionSuspensionWritesForGatewayShutdown } from ${sessionSuspensionPath};`,
        'import { expect, it } from "vitest";',
        'const testApi = (globalThis as Record<PropertyKey, { isSessionSuspensionWriteCleanupActiveForTest(): boolean }>)[Symbol.for("openclaw.sessionSuspensionTestApi")];',
        'it("seeds the real process-global shutdown fence", () => {',
        "  fenceSessionSuspensionWritesForGatewayShutdown();",
        "  expect(testApi?.isSessionSuspensionWriteCleanupActiveForTest()).toBe(true);",
        "});",
        "",
      ].join("\n"),
    );
    await write(
      "b-observe.test.ts",
      [
        `import ${sessionSuspensionPath};`,
        'import { expect, it } from "vitest";',
        'const testApi = (globalThis as Record<PropertyKey, { isSessionSuspensionWriteCleanupActiveForTest(): boolean }>)[Symbol.for("openclaw.sessionSuspensionTestApi")];',
        'it("starts without real suspension state from the previous file", () => {',
        "  expect(testApi?.isSessionSuspensionWriteCleanupActiveForTest()).toBe(false);",
        "});",
        "",
      ].join("\n"),
    );
    await write(
      "vitest.config.ts",
      [
        `import { sharedVitestConfig } from ${sharedVitestConfigPath};`,
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
    );

    const vitestEntry = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
    const result = await execFileAsync(
      process.execPath,
      [vitestEntry, "run", "--root", root, "--config", path.join(root, "vitest.config.ts")],
      { cwd: repoRoot, env: childEnv(), maxBuffer: 16 * 1024 * 1024 },
    );
    expect(`${result.stdout}\n${result.stderr}`).toContain("2 passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("clears agent run registry state between files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-run-registry-runner-"));
  try {
    const write = (name: string, content: string) =>
      fs.writeFile(path.join(root, name), content, "utf-8");
    const agentRunRegistryPath = JSON.stringify(
      path.join(repoRoot, "src", "infra", "agent-run-registry.ts"),
    );
    const agentEventsPath = JSON.stringify(path.join(repoRoot, "src", "infra", "agent-events.ts"));
    const sharedVitestConfigPath = JSON.stringify(
      path.join(repoRoot, "test", "vitest", "vitest.shared.config.ts"),
    );
    await fs.symlink(
      path.join(repoRoot, "node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    await write(
      "a-seed.test.ts",
      [
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
    );
    await write(
      "b-observe.test.ts",
      [
        `import { clearAgentRunContext, getAgentRunContext, registerAgentRunContext, sweepStaleRunContexts } from ${agentRunRegistryPath};`,
        `import { emitAgentEvent, onAgentEvent } from ${agentEventsPath};`,
        'import { expect, it } from "vitest";',
        'it("restarts sequence state and sweeps only its own target context", () => {',
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
    );
    await write(
      "vitest.config.ts",
      [
        `import { sharedVitestConfig } from ${sharedVitestConfigPath};`,
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
    );

    const vitestEntry = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
    const result = await execFileAsync(
      process.execPath,
      [vitestEntry, "run", "--root", root, "--config", path.join(root, "vitest.config.ts")],
      { cwd: repoRoot, env: childEnv(), maxBuffer: 16 * 1024 * 1024 },
    );
    expect(`${result.stdout}\n${result.stderr}`).toContain("2 passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

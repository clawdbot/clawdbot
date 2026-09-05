import path from "node:path";

export function testApiLifecycleFixtureFiles(repoRoot: string): Record<string, string> {
  const sourcePath = (name: string) => JSON.stringify(path.join(repoRoot, "src", name));
  const files: Record<string, string> = {};
  for (const [prefix, generation] of [
    ["09-d", "producer"],
    ["09-e", "observer"],
  ]) {
    const observeCleanup =
      generation === "observer"
        ? `
// Check during collection before imports can overwrite the previous generation.
const remainingKeys = [
  "openclaw.beforeToolCallBlockedErrorTestApi",
  "openclaw.backupPlanTestApi",
  "openclaw.staleAuthOrderTestApi",
  "openclaw.bashProcessRegistryTestApi",
  "openclaw.diagnosticRunActivityTestApi",
].filter((key) => Object.hasOwn(globalThis, Symbol.for(key)));
expect(remainingKeys, "completed-file test API publications").toEqual([]);
expect(Object.hasOwn(globalThis, "openclawOpenAIResponsesTransportTestApi")).toBe(false);
for (const key of [Symbol.for("fixture.foreignTestApi"), Symbol.for("openclaw.google.vertexAdcTestApi"), "openclaw.backupPlanTestApi"]) {
  expect(Reflect.get(globalThis, key)).toBe("foreign");
  Reflect.deleteProperty(globalThis, key);
}
`
        : "";
    files[`${prefix}-test-api-${generation}.test.ts`] = `
import path from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
${observeCleanup}
const { createBeforeToolCallBlockedError } = await import(${sourcePath("agents/agent-tools.before-tool-call.test-support.ts")});
const { isBeforeToolCallBlockedError } = await import(${sourcePath("agents/agent-tools.before-tool-call.wrapper.ts")});
const { resolveBackupPlanFromPaths } = await import(${sourcePath("commands/backup.test-support.ts")});
const { repairStaleConfiguredAuthOrders } = await import(${sourcePath("commands/doctor/shared/stale-auth-order.test-support.ts")});
const { testing: responses } = await import(${sourcePath("agents/openai-transport-stream.test-support.ts")});
const registry = await import(${sourcePath("agents/bash-process-registry.ts")});
const { resetProcessRegistryForTests } = await import(${sourcePath("agents/bash-process-registry.test-support.ts")});
const { createProcessSessionFixture } = await import(${sourcePath("agents/bash-process-registry.test-helpers.ts")});
const registryKey = Symbol.for("openclaw.bashProcessRegistryTestApi");
const capturedRegistryApi = Reflect.get(globalThis, registryKey);
const replacement = await import(${sourcePath("agents/bash-process-registry.ts?lifetime-replacement")});
const replacementApi = Reflect.get(globalThis, registryKey);
expect(replacementApi).not.toBe(capturedRegistryApi);
const nativeCron = await import(${sourcePath("cron/service/active-run-cancellation.ts")});
const native = createRequire(import.meta.url)("./native-cron.cjs");
expect(Reflect.get(globalThis, Symbol.for("openclaw.activeCronTaskRunTestApi"))).toBe(native.api);
expect(nativeCron.registerActiveCronTaskRun).toBe(native.register);
const { resetDiagnosticRunActivityForTest, getDiagnosticSessionActivitySnapshot } = await import(${sourcePath("logging/diagnostic-run-activity.ts")});
const { markDiagnosticToolStartedForTest } = await import(${sourcePath("logging/diagnostic-run-activity.test-support.ts")});
const { resolveGlobalSingleton } = await import(${sourcePath("shared/global-singleton.ts")});
const stateDir = path.join(import.meta.dirname, "test-api-state");
const configPath = path.join(stateDir, "missing-openclaw.json");
describe("${generation} test API consumers", () => {
  async function verifyConsumers(message: string): Promise<void> {
    const blocked = createBeforeToolCallBlockedError(message);
    expect(blocked.message).toBe(message);
    expect(isBeforeToolCallBlockedError(blocked)).toBe(true);
    expect(isBeforeToolCallBlockedError(new Error(message))).toBe(false);
    expect(responses.isInvalidEncryptedContentError({ code: "invalid_encrypted_content" })).toBe(true);
    expect(responses.isInvalidEncryptedContentError(new Error("unrelated"))).toBe(false);
    registry.addSession(createProcessSessionFixture({ id: "captured", backgrounded: true }));
    replacement.addSession(createProcessSessionFixture({ id: "replacement", backgrounded: true }));
    try {
      resetProcessRegistryForTests();
      expect(registry.listRunningSessions()).toEqual([]);
      expect(replacement.listRunningSessions().map((session) => session.id)).toEqual(["replacement"]);
    } finally {
      resetProcessRegistryForTests();
      replacementApi.resetProcessRegistryForTests();
    }
    const controller = new AbortController();
    nativeCron.registerActiveCronTaskRun({ runId: "native-fixture", controller });
    native.api.resetActiveCronTaskRunsForTests();
    expect(nativeCron.cancelActiveCronTaskRun({ runId: "native-fixture" })).toBe(false);
    expect(controller.signal.aborted).toBe(false);
    const plan = await resolveBackupPlanFromPaths({
      stateDir,
      configPath,
      oauthDir: path.join(stateDir, "credentials"),
      onlyConfig: true,
    });
    expect(plan).toMatchObject({
      included: [],
      workspaceDirs: [],
      skipped: [{ kind: "config", sourcePath: configPath, reason: "missing" }],
    });
    const cfg = { auth: { order: { "fixture-provider": [] } } };
    expect(repairStaleConfiguredAuthOrders({ cfg, stores: [] })).toEqual({
      config: cfg,
      changes: [],
    });
  }
  it.each(["first test", "second test"])("keeps test API consumers usable in %s", async (phase) => {
    await verifyConsumers(phase);
  });
  afterAll(async () => {
    await verifyConsumers("afterAll");
    console.info("test API lifecycle: ${generation} afterAll passed");
  });
  const cleanupKey = Symbol("fixture resource teardown");
  resolveGlobalSingleton(cleanupKey, () => ({}), async () => {
    try {
      await verifyConsumers("resource teardown");
      const key = Symbol.for("openclaw.diagnosticRunActivityTestApi");
      const priorApi = Reflect.get(globalThis, key);
      resetDiagnosticRunActivityForTest();
      expect(Reflect.get(globalThis, key)).not.toBe(priorApi);
      markDiagnosticToolStartedForTest({ sessionId: "fixture", toolName: "teardown" });
      expect(getDiagnosticSessionActivitySnapshot({ sessionId: "fixture" }).lastProgressReason).toBe("tool:teardown:started");
      console.info("test API lifecycle: ${generation} resource teardown passed");
    } finally {
      // Release this fixture's own lifecycle registration, including its captured consumers.
      Reflect.get(globalThis, Symbol.for("openclaw.globalSingletonLifecycleResets")).delete(cleanupKey);
      Reflect.deleteProperty(globalThis, cleanupKey);
    }
  });
});
${generation === "producer" ? 'await import("./foreign/extensions/google/vertex-adc.ts");' : ""}
`;
  }
  files["native-cron.cjs"] = `
const cron = require(${sourcePath("cron/service/active-run-cancellation.ts")});
module.exports = { register: cron.registerActiveCronTaskRun, api: globalThis[Symbol.for("openclaw.activeCronTaskRunTestApi")] };
`;
  files["foreign/extensions/google/vertex-adc.ts"] = `
for (const key of [Symbol.for("fixture.foreignTestApi"), Symbol.for("openclaw.google.vertexAdcTestApi"), "openclaw.backupPlanTestApi"]) {
  Reflect.set(globalThis, key, "foreign");
}
`;
  files["09-f-test-api-skipped.test.ts"] = `
import ${sourcePath("logging/diagnostic-run-activity.ts")};
import { it } from "vitest";
it.skip("collects a publisher without running its suite", () => {});
`;
  files["09-g-test-api-skipped-observer.test.ts"] = `
import { expect, it } from "vitest";
it("retires the skipped file publication", () => {
  expect(Object.hasOwn(globalThis, Symbol.for("openclaw.diagnosticRunActivityTestApi"))).toBe(false);
});
`;
  files["09-h-test-api-partial-mock.test.ts"] = `
import { createRequire } from "node:module";
import { afterAll, expect, it, vi } from "vitest";
vi.mock(${sourcePath("agents/workspace-legacy-state.ts")}, async () => ({
  ...await vi.importActual(${sourcePath("agents/workspace-legacy-state.ts")}),
  prepareLegacyWorkspaceStateReset: vi.fn(),
}));
vi.mock(${sourcePath("cron/service/active-run-cancellation.ts")}, async () => ({
  ...await vi.importActual(${sourcePath("cron/service/active-run-cancellation.ts")}),
}));
const nativeCron = await import(${sourcePath("cron/service/active-run-cancellation.ts")});
// The second import replaces native metadata with a manual-mock placeholder;
// the execution record must still identify the retained native generation.
await import(${sourcePath("cron/service/active-run-cancellation.ts")});
const native = createRequire(import.meta.url)("./native-cron.cjs");
const workspace = await import(${sourcePath("agents/workspace-legacy-state.ts")});
const { resetLegacyWorkspaceStateCheckForTest } = await import(${sourcePath("agents/workspace-legacy-state.test-support.ts")});
function verifyPartialMock() {
  expect(workspace.LEGACY_WORKSPACE_STATE_DIRNAME).toBe(".openclaw");
  expect(vi.isMockFunction(workspace.prepareLegacyWorkspaceStateReset)).toBe(true);
  expect(() => resetLegacyWorkspaceStateCheckForTest()).not.toThrow();
  expect(nativeCron.registerActiveCronTaskRun).toBe(native.register);
  expect(Reflect.get(globalThis, Symbol.for("openclaw.activeCronTaskRunTestApi"))).toBe(native.api);
}
it("uses the real source API behind a partial manual mock", verifyPartialMock);
afterAll(() => {
  vi.resetModules();
  verifyPartialMock();
});
`;
  files["09-i-test-api-partial-mock-observer.test.ts"] = `
import { createRequire } from "node:module";
import { expect, it } from "vitest";
expect(Object.hasOwn(globalThis, Symbol.for("openclaw.workspaceLegacyStateTestApi")), "partial mock source publication retired").toBe(false);
const { resetLegacyWorkspaceStateCheckForTest } = await import(${sourcePath("agents/workspace-legacy-state.test-support.ts")});
it("loads a fresh real source after the partial mock retires", () => {
  expect(() => resetLegacyWorkspaceStateCheckForTest()).not.toThrow();
  const native = createRequire(import.meta.url)("./native-cron.cjs");
  expect(Reflect.get(globalThis, Symbol.for("openclaw.activeCronTaskRunTestApi"))).toBe(native.api);
});
`;
  files["09-j-test-api-mock-only.test.ts"] = `
/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
vi.mock(${sourcePath("agents/workspace-legacy-state.ts")}, () => ({ LEGACY_WORKSPACE_STATE_DIRNAME: "mock-only" }));
const workspace = await import(${sourcePath("agents/workspace-legacy-state.ts")});
it("does not execute the source behind a mock-only import", () => {
  expect(workspace.LEGACY_WORKSPACE_STATE_DIRNAME).toBe("mock-only");
  const key = Symbol.for("openclaw.workspaceLegacyStateTestApi");
  expect(Object.hasOwn(globalThis, key)).toBe(false);
  Reflect.set(globalThis, key, "foreign");
});
`;
  files["09-k-test-api-mock-only-observer.test.ts"] = `
/* @vitest-environment jsdom */
import { expect, it } from "vitest";
it("preserves a foreign slot when only a prior generation executed its known source", () => {
  const key = Symbol.for("openclaw.workspaceLegacyStateTestApi");
  expect(Reflect.get(globalThis, key)).toBe("foreign");
  Reflect.deleteProperty(globalThis, key);
});
`;
  return files;
}

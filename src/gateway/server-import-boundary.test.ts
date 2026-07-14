// Gateway import-boundary tests keep startup-critical modules lazy and prevent
// heavyweight cron, doctor, secret, task, and WebSocket handlers from eager loads.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("gateway startup import boundaries", () => {
  it("keeps heavy cron and doctor legacy paths out of the server.impl import graph", () => {
    const serverImpl = readSource("src/gateway/server.impl.ts");
    const validation = readSource("src/config/validation.ts");

    expect(serverImpl).not.toContain('from "./server-cron.js"');
    expect(serverImpl).toContain('from "./server-cron-lazy.js"');
    expect(serverImpl).not.toContain('from "./server-methods.js"');
    expect(serverImpl).not.toContain('from "./config-reload.js"');
    expect(serverImpl).not.toMatch(
      /import\s+\{[^}]*resolveSessionKeyForRun[^}]*\}\s+from "\.\/server-session-key\.js"/s,
    );
    expect(serverImpl).not.toMatch(
      /export\s+\{[^}]*resetModelCatalogCacheForTest[^}]*\}\s+from "\.\/server-model-catalog\.js"/s,
    );
    expect(readSource("src/gateway/server-runtime-subscriptions.ts")).toContain(
      'import("./server-session-key.js")',
    );
    expect(readSource("src/gateway/server-shared-auth-generation.ts")).not.toContain(
      'from "./config-reload.js"',
    );
    expect(readSource("src/gateway/server-aux-handlers.ts")).not.toContain(
      'from "./config-reload.js"',
    );
    expect(readSource("src/gateway/server-runtime-state.ts")).not.toContain(
      'createCanvasHostHandler } from "../../extensions/canvas/runtime-api.js"',
    );
    expect(serverImpl).not.toContain('from "../plugins/hook-runner-global.js"');
    expect(serverImpl).not.toContain('from "../tasks/task-registry.js"');
    expect(serverImpl).not.toContain('from "../tasks/task-registry.maintenance.js"');
    expect(serverImpl).toContain('import("../tasks/task-registry.maintenance.js")');
    expect(serverImpl).not.toContain('from "../secrets/runtime.js"');
    expect(readSource("src/gateway/server-reload-handlers.ts")).not.toContain(
      'from "../secrets/runtime.js"',
    );
    const wsConnection = readSource("src/gateway/server/ws-connection.ts");
    expect(wsConnection).not.toMatch(
      /import\s+\{[^}]*attachGatewayWsMessageHandler[^}]*\}\s+from "\.\/ws-connection\/message-handler\.js"/s,
    );
    expect(wsConnection).toContain('import("./ws-connection/message-handler.js")');
    expect(readSource("src/gateway/server-aux-handlers.ts")).not.toMatch(
      /import\s+\{[^}]*create(?:Exec|Plugin|Secrets)[^}]*\}\s+from "\.\/server-methods\//s,
    );
    expect(validation).not.toContain("legacy-secretref-env-marker");
    expect(validation).not.toContain("commands/doctor");
    const workerStartup = readSource("src/gateway/server-worker-environment-startup.ts");
    expect(serverImpl).toContain('import("./server-worker-environment-startup.js")');
    for (const workerModule of ["live-events", "service", "store", "transcript-commit"]) {
      expect(serverImpl).not.toContain(`from "./worker-environments/${workerModule}.js"`);
      expect(workerStartup).toContain(`import("./worker-environments/${workerModule}.js")`);
    }
    expect(serverImpl).not.toContain('from "../plugins/worker-provider-registry.js"');
    expect(workerStartup).toContain('import("../plugins/worker-provider-registry.js")');
    expect(serverImpl).not.toContain(
      'from "../../packages/gateway-protocol/src/schema/worker-admission.js"',
    );
    expect(workerStartup).toContain(
      'import("../../packages/gateway-protocol/src/schema/worker-admission.js")',
    );
  });

  it("defers retained plugin generation cleanup to the post-ready idle scheduler", () => {
    const serverImpl = readSource("src/gateway/server.impl.ts");
    const cleanup = readSource("src/gateway/server-retained-plugin-cleanup.ts");
    const importBoundary = serverImpl.indexOf("type LoadGatewayModelCatalog");
    const serverStart = serverImpl.indexOf("export async function startGatewayServer");
    const postReadyStart = serverImpl.indexOf("scheduleGatewayPostReadyMaintenance({", serverStart);
    const cleanupCall = serverImpl.lastIndexOf("cleanupRetainedPluginInstallGenerations(");

    expect(importBoundary).toBeGreaterThan(-1);
    expect(serverImpl.slice(0, importBoundary)).not.toContain("managed-npm-retention");
    expect(serverImpl.slice(0, importBoundary)).not.toContain("installed-plugin-index-records");
    expect(cleanup).toContain('import("../plugins/managed-npm-retention.js")');
    expect(cleanup).toContain('import("../plugins/installed-plugin-index-records.js")');
    expect(postReadyStart).toBeGreaterThan(serverStart);
    expect(cleanupCall).toBeGreaterThan(postReadyStart);
    expect(serverImpl.slice(postReadyStart, cleanupCall + 300)).not.toContain(
      "startupConfigLoad.pluginMetadataSnapshot?.index.installRecords",
    );
    expect(cleanup).toContain("loadInstalledPluginIndexInstallRecordsSync()");
  });

  it("loads the worker bootstrap runtime only when an operation needs it", () => {
    const workerStartup = readSource("src/gateway/server-worker-environment-startup.ts");
    const runtimeLoad = "loadWorkerEnvironmentRuntimeModule()";
    const prepareStart = workerStartup.indexOf("const prepareInstallation = async");
    const serviceStart = workerStartup.indexOf("const workerEnvironmentService =", prepareStart);
    const identityStart = workerStartup.indexOf("resolveSshIdentity: async", serviceStart);
    const bootstrapStart = workerStartup.indexOf("bootstrapWorker: async", serviceStart);
    const loggerStart = workerStartup.indexOf("logger: params.log.child", bootstrapStart);

    expect(prepareStart).toBeGreaterThan(-1);
    expect(serviceStart).toBeGreaterThan(prepareStart);
    expect(identityStart).toBeGreaterThan(serviceStart);
    expect(bootstrapStart).toBeGreaterThan(serviceStart);
    expect(loggerStart).toBeGreaterThan(bootstrapStart);
    expect(workerStartup.slice(0, prepareStart)).not.toContain(runtimeLoad);
    expect(workerStartup.slice(prepareStart, serviceStart)).toContain(runtimeLoad);
    expect(workerStartup.slice(identityStart, bootstrapStart)).toContain(runtimeLoad);
    expect(workerStartup.slice(bootstrapStart, loggerStart)).toContain(runtimeLoad);
    expect(workerStartup.slice(bootstrapStart, loggerStart)).toContain(
      "pinnedHostKey: sshEndpoint.hostKey",
    );
    expect(workerStartup.match(/loadWorkerEnvironmentRuntimeModule\(\)/gu)).toHaveLength(3);
  });

  it("fences config reload before gateway teardown and gateway_stop hooks", () => {
    const serverImpl = readSource("src/gateway/server.impl.ts");
    const closeStart = /close:\s*async\s*\([^)]*\)\s*=>/u.exec(serverImpl)?.index ?? -1;
    const hookStart = serverImpl.indexOf("runGlobalGatewayStopSafely", closeStart);
    const reloadStopStart = serverImpl.indexOf("await beginClosePrelude();", closeStart);
    const terminalStopStart = serverImpl.indexOf("terminalSessions.disposeAll();", closeStart);
    const markHelperStart = serverImpl.indexOf("const markClosePreludeStarted = () => {");
    const markHelperEnd = serverImpl.indexOf("};", markHelperStart);
    const beginHelperStart = serverImpl.indexOf("const beginClosePrelude = async () => {");
    const beginHelperEnd = serverImpl.indexOf("};", beginHelperStart);
    const postReadyStart = serverImpl.indexOf("scheduleGatewayPostReadyMaintenance({");
    const postReadyEnd = serverImpl.indexOf("});", postReadyStart);
    const postReadyBlock = serverImpl.slice(postReadyStart, postReadyEnd);

    expect(closeStart).toBeGreaterThan(-1);
    expect(reloadStopStart).toBeGreaterThan(closeStart);
    expect(reloadStopStart).toBeLessThan(terminalStopStart);
    expect(reloadStopStart).toBeLessThan(hookStart);
    expect(markHelperStart).toBeGreaterThan(-1);
    expect(serverImpl.slice(markHelperStart, markHelperEnd)).toContain(
      "clearPostReadyMaintenanceTimer();",
    );
    expect(serverImpl.slice(markHelperStart, markHelperEnd)).toContain(
      "cronReconciliation.invalidate();",
    );
    expect(beginHelperStart).toBeGreaterThan(-1);
    expect(serverImpl.slice(beginHelperStart, beginHelperEnd)).toContain(
      "markClosePreludeStarted();",
    );
    expect(serverImpl.slice(beginHelperStart, beginHelperEnd)).toContain(
      "await stopConfigReloaderForClose()",
    );
    expect(postReadyStart).toBeGreaterThan(-1);
    expect(postReadyBlock).toContain("isClosing: () => closePreludeStarted");
    expect(postReadyBlock).toContain("if (closePreludeStarted)");
    expect(postReadyBlock).toContain(
      "shouldStartCron: () => !closePreludeStarted && !gatewayCronStartHandled",
    );
  });
});

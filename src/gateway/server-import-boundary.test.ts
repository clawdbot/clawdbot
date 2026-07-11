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
  });

  it("loads the worker bootstrap runtime only when an operation needs it", () => {
    const serverImpl = readSource("src/gateway/server.impl.ts");
    const runtimeLoad = "await loadWorkerEnvironmentRuntimeModule()";
    const prepareStart = serverImpl.indexOf("const prepareWorkerInstallation = async");
    const serviceStart = serverImpl.indexOf("const workerEnvironmentService =", prepareStart);
    const identityStart = serverImpl.indexOf("resolveSshIdentity: async", serviceStart);
    const bootstrapStart = serverImpl.indexOf("bootstrapWorker: async", serviceStart);
    const loggerStart = serverImpl.indexOf("logger: log.child", bootstrapStart);

    expect(prepareStart).toBeGreaterThan(-1);
    expect(serviceStart).toBeGreaterThan(prepareStart);
    expect(identityStart).toBeGreaterThan(serviceStart);
    expect(bootstrapStart).toBeGreaterThan(serviceStart);
    expect(loggerStart).toBeGreaterThan(bootstrapStart);
    expect(serverImpl.slice(0, prepareStart)).not.toContain(runtimeLoad);
    expect(serverImpl.slice(prepareStart, serviceStart)).toContain(runtimeLoad);
    expect(serverImpl.slice(identityStart, bootstrapStart)).toContain(runtimeLoad);
    expect(serverImpl.slice(bootstrapStart, loggerStart)).toContain(runtimeLoad);
    expect(serverImpl.slice(bootstrapStart, loggerStart)).toContain(
      "pinnedHostKey: sshEndpoint.hostKey",
    );
    expect(serverImpl.match(/await loadWorkerEnvironmentRuntimeModule\(\)/gu)).toHaveLength(3);
  });

  it("marks gateway close before awaiting gateway_stop hooks", () => {
    const serverImpl = readSource("src/gateway/server.impl.ts");
    const closeStart = /close:\s*async\s*\([^)]*\)\s*=>/u.exec(serverImpl)?.index ?? -1;
    const hookStart = serverImpl.indexOf("runGlobalGatewayStopSafely", closeStart);
    const markStart = serverImpl.indexOf("markClosePreludeStarted();", closeStart);
    const markHelperStart = serverImpl.indexOf("const markClosePreludeStarted = () => {");
    const markHelperEnd = serverImpl.indexOf("};", markHelperStart);
    const postReadyStart = serverImpl.indexOf("scheduleGatewayPostReadyMaintenance({");
    const postReadyEnd = serverImpl.indexOf("});", postReadyStart);
    const postReadyBlock = serverImpl.slice(postReadyStart, postReadyEnd);

    expect(closeStart).toBeGreaterThan(-1);
    expect(markStart).toBeGreaterThan(closeStart);
    expect(markStart).toBeLessThan(hookStart);
    expect(markHelperStart).toBeGreaterThan(-1);
    expect(serverImpl.slice(markHelperStart, markHelperEnd)).toContain(
      "clearPostReadyMaintenanceTimer();",
    );
    expect(serverImpl.slice(markHelperStart, markHelperEnd)).toContain(
      "cronReconciliation.invalidate();",
    );
    expect(postReadyStart).toBeGreaterThan(-1);
    expect(postReadyBlock).toContain("isClosing: () => closePreludeStarted");
    expect(postReadyBlock).toContain("if (closePreludeStarted)");
    expect(postReadyBlock).toContain(
      "shouldStartCron: () => !closePreludeStarted && !gatewayCronStartHandled",
    );
  });
});

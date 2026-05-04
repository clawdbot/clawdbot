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
      /export\s+\{[^}]*__resetModelCatalogCacheForTest[^}]*\}\s+from "\.\/server-model-catalog\.js"/s,
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
      'createCanvasHostHandler } from "../canvas-host/server.js"',
    );
    expect(serverImpl).not.toContain('from "../plugins/hook-runner-global.js"');
    expect(serverImpl).not.toContain('from "../tasks/task-registry.js"');
    expect(serverImpl).not.toContain('from "../tasks/task-registry.maintenance.js"');
    expect(serverImpl).toContain('import("../tasks/task-registry.maintenance.js")');
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

  it("marks gateway close before awaiting gateway_stop hooks", () => {
    const serverImpl = readSource("src/gateway/server.impl.ts");
    const closeStart = serverImpl.indexOf("close: async (opts)");
    const hookStart = serverImpl.indexOf("runGlobalGatewayStopSafely", closeStart);
    const markStart = serverImpl.indexOf("markClosePreludeStarted();", closeStart);

    expect(closeStart).toBeGreaterThan(-1);
    expect(markStart).toBeGreaterThan(closeStart);
    expect(markStart).toBeLessThan(hookStart);
  });
});

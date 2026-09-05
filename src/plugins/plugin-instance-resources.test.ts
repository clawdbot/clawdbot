import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";

describe("native plugin resource lifecycle", () => {
  it.each([
    "lazy-stream",
    "subclass",
    "factory-listener",
    "fluent-resource",
    "promisified-timer",
    "pending-http",
    "accepted-socket",
    "accepted-http-listeners",
    "accepted-http-upgrade-listeners",
    "pipe-identity",
    "pipe-drain",
    "errored-watcher",
    "signal-subclass-lifecycle",
    "signal-subclass-external",
    "signal-subclassconstruct-lifecycle",
    "signal-subclassconstruct-external",
    "signal-subclasspromise-lifecycle",
    "signal-subclasspromise-external",
    "signal-subclassthrow-lifecycle",
    "signal-subclassvoid-lifecycle",
    "signal-subclassvoid-external",
    "signal-subclasscallback-lifecycle",
    "signal-subclasscallback-external",
    "signal-watcher-lifecycle",
    "signal-watcher-external",
    "signal-server-lifecycle",
    "signal-server-external",
    "signal-child-lifecycle",
    "signal-child-external",
    "signal-childspawn-lifecycle",
    "signal-childspawn-external",
    "signal-childfork-lifecycle",
    "signal-childfork-external",
    "signal-childexecnull-lifecycle",
    "signal-childexecnull-external",
    "signal-childexecundefined-lifecycle",
    "signal-childexecundefined-external",
    "signal-http-lifecycle",
    "signal-http-external",
    "signal-httpurl-lifecycle",
    "signal-httpurl-external",
    "signal-socket-lifecycle",
    "signal-socket-external",
    "signal-connection-lifecycle",
    "signal-connection-external",
    "signal-childunhandled-lifecycle",
    "borrowed-process-stdin",
    "never-listening-server",
    "emitter-controls",
    "closed-watcher",
    "watch-file-retirement",
    "watch-file-unwatch-one",
    "watch-file-unwatch-all",
    "watch-file-natural-exit",
    "watch-file-natural-exit-get-cwd",
    "watch-file-invalid-path",
    "watch-file-shared-unref",
    "promise-watch-module-owner",
    "promise-watch-module-external",
    "promise-watch-namespace-owner",
    "promise-watch-namespace-external",
    "promise-watch-module-validation",
    "promise-watch-namespace-validation",
    "reopened-server",
    "timer-handle",
    "client-http-upgrade",
    "client-http-connect",
    "pooled-agent",
    "late-native-close",
    "accepted-http2-stream",
    "requested-http2-stream",
  ])("preserves %s ownership and Node behavior", (scenario) => {
    const fixture = new URL(
      "../../test/helpers/plugins/plugin-instance-resources.test-support.ts",
      import.meta.url,
    );
    const result = spawnNodeEvalSync(
      `
      import { verifyResourceLifecycle } from ${JSON.stringify(fixture.href)};
      await verifyResourceLifecycle(${JSON.stringify(scenario)});
    `,
      {
        imports: [fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url))],
        timeout: 15_000,
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
  });
});

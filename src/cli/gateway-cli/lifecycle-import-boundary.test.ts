// The run loop primes lifecycle.runtime.ts before the HTTP listener binds, so the
// hub's re-exports decide how much module graph loads during gateway cold start.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("gateway lifecycle hub import boundaries", () => {
  it("re-exports primed symbols from their defining modules instead of facades", () => {
    const hub = readSource("src/cli/gateway-cli/lifecycle.runtime.ts");

    // server-reload-handlers.ts also re-exports server-reload-hot.ts and
    // server-reload-managed.ts, so routing through it loads the hot-reload and
    // managed-reloader graphs before the gateway can accept a connection.
    expect(hub).toContain('from "../../gateway/server-reload-contracts.js"');
    expect(hub).not.toContain('from "../../gateway/server-reload-handlers.js"');

    // main-session-restart-recovery.ts also re-exports its -runtime sibling,
    // which the primed hub never calls.
    expect(hub).toContain(
      'from "../../agents/main-session-recovery/main-session-restart-recovery-marking.js"',
    );
    expect(hub).not.toContain(
      'from "../../agents/main-session-recovery/main-session-restart-recovery.js"',
    );
  });

  it("still primes the hub eagerly so signal handlers survive dist chunk rotation", () => {
    const runLoop = readSource("src/cli/gateway-cli/run-loop.ts");
    const eagerPrime = runLoop.indexOf("await loadGatewayLifecycleRuntimeModule()");
    const signalInstall = runLoop.indexOf("process.on(");

    expect(eagerPrime).toBeGreaterThan(-1);
    expect(signalInstall).toBeGreaterThan(eagerPrime);
  });
});

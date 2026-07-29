// Connected session-store test helper installs a suite-level gateway plus temp
// session store path for session RPC tests.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";
import { startConnectedServerWithClient } from "./test-helpers.js";

// Suite-level connected Gateway fixture with isolated session store path.

type ConnectedGateway = Awaited<ReturnType<typeof startConnectedServerWithClient>>;

/** Return a required suite value or fail with a clear readiness label. */
function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`${label} is not ready`);
  }
  return value;
}

/** Install a shared connected Gateway and temp session store for a Vitest suite. */
export function installConnectedSessionStoreGatewaySuite(prefix: string) {
  let started: ConnectedGateway | undefined;
  let sessionStoreDir: string | undefined;
  let sessionStorePath: string | undefined;

  beforeAll(async () => {
    started = await startConnectedServerWithClient();
    sessionStoreDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    sessionStorePath = path.join(sessionStoreDir, "sessions.json");
  });

  afterAll(async () => {
    started?.ws.close();
    await started?.server.close();
    if (sessionStoreDir) {
      await fs.rm(sessionStoreDir, { recursive: true, force: true });
    }
  });

  return {
    get sessionStorePath() {
      return requireValue(sessionStorePath, "session store path");
    },
    get ws() {
      return requireValue(started, "gateway client").ws;
    },
  };
}

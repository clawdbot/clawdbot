// Env isolation for fast shards that intentionally skip the full shared setup.
// unit-fast runs isolate:false with auto-curated membership, so without this any
// test that reads config/state sees the developer's real ~/.openclaw. The roster
// adapter below also models the load-time normalization ordinary runtime tests receive.
import "./setup-agent-roster.js";
import { installTestEnv } from "./test-env.js";

process.env.VITEST = "true";

const ENV_ISOLATION_SETUP = Symbol.for("openclaw.envIsolationTestSetup");

type EnvIsolationHandle = { cleanup: () => void };

const globalState = globalThis as typeof globalThis & {
  [ENV_ISOLATION_SETUP]?: EnvIsolationHandle;
};

if (!globalState[ENV_ISOLATION_SETUP]) {
  // unit-fast is never a live lane, even when its parent shell exports live flags.
  // Hermetic mode prevents real or staged credentials/config from entering the worker.
  const testEnv = installTestEnv({ mode: "hermetic" });
  const handle: EnvIsolationHandle = {
    cleanup: () => {
      testEnv.cleanup();
      delete globalState[ENV_ISOLATION_SETUP];
    },
  };
  process.once("exit", handle.cleanup);
  globalState[ENV_ISOLATION_SETUP] = handle;
}

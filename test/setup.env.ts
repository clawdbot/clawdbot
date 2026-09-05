// Env-only isolation for fast shards that intentionally skip the full shared
// setup (no module mocks, no custom runner). unit-fast runs isolate:false with
// auto-curated membership, so without this any test that reads config/state
// sees the developer's real ~/.openclaw (e.g. an openclaw.json key the branch
// schema rejects deterministically fails schema-reading tests locally while CI
// stays green).
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

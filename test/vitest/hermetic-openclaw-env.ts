/**
 * Hermetic test-env helper for OPENCLAW_* variables.
 *
 * Background:
 *   Local gateway service environments can export OPENCLAW_* variables to
 *   child shells. When `pnpm test` is invoked from such a shell, those vars
 *   leak into the test process and trip implementation branches that tests
 *   assume are inert by default. Tests that pass cleanly in CI or in an
 *   env-clean shell can then fail spuriously.
 *
 *   The exact set of leaked vars varies by operator overrides and service
 *   drop-ins, so enumerating known offenders in each test file is fragile.
 *
 * Guard:
 *   `useHermeticOpenclawEnv()` registers a `beforeEach` that snapshots and
 *   stubs every `OPENCLAW_*` key present in `process.env` to the empty
 *   string, plus an `afterEach` that restores via `vi.unstubAllEnvs()`.
 *   Wildcards over the namespace so new vars are caught
 *   automatically without a follow-up PR. Companion tests that need a
 *   specific `OPENCLAW_*` value can still set it explicitly inside the test
 *   body (via `vi.stubEnv` or direct `process.env` write); the helper's
 *   stub is a default, not a lock.
 *
 * Usage:
 *   import { useHermeticOpenclawEnv } from "../../../test/vitest/hermetic-openclaw-env";
 *
 *   describe("my suite", () => {
 *     useHermeticOpenclawEnv();
 *     // ... tests ...
 *   });
 *
 *   If the suite already has its own `beforeEach`/`afterEach`, call
 *   `useHermeticOpenclawEnv()` before them; vitest runs hooks in
 *   registration order so the env stub lands first and the unstub runs
 *   last, leaving any per-test mock state intact.
 */

import { afterEach, beforeEach, vi } from "vitest";

const OPENCLAW_ENV_PREFIX = "OPENCLAW_";

interface HermeticOpenclawEnvOptions {
  /**
   * `OPENCLAW_*` keys to leave untouched. Use for tests that set state-dir,
   * config-path, or other workspace-rooting vars in `beforeAll` and rely on
   * them persisting across the suite.
   */
  except?: readonly string[];
}

export function useHermeticOpenclawEnv(options: HermeticOpenclawEnvOptions = {}): void {
  const exceptSet = new Set(options.except ?? []);
  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith(OPENCLAW_ENV_PREFIX) && !exceptSet.has(key)) {
        vi.stubEnv(key, "");
      }
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });
}

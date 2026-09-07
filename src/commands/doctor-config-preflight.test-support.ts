import { withEnvOverride, withTempHome } from "../config/test-helpers.js";
import { listKnownProviderAuthEnvVarNames } from "../secrets/provider-env-vars.js";

/** Keep real preflight fixtures from provisioning plugins for the developer's credentials. */
export async function withDoctorConfigPreflightHome<T>(
  run: (home: string) => Promise<T>,
): Promise<T> {
  return withTempHome((home) => {
    const providerEnv = Object.fromEntries(
      listKnownProviderAuthEnvVarNames({ config: {}, env: process.env }).map((key) => [
        key,
        undefined,
      ]),
    );
    return withEnvOverride(providerEnv, () => run(home));
  });
}

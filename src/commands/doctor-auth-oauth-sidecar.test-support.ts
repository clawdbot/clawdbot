import type { LegacyOAuthRef } from "./doctor/shared/legacy-oauth-sidecar.js";
import "./doctor-auth-oauth-sidecar.js";

type DoctorAuthOAuthSidecarTestApi = {
  buildLegacyOAuthSecretAad(params: {
    ref: LegacyOAuthRef;
    profileId: string;
    provider: string;
  }): Buffer;
  buildLegacyOAuthSecretKey(seed: string): Buffer;
};

function getTestApi(): DoctorAuthOAuthSidecarTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.doctorAuthOAuthSidecarTestApi")
  ] as DoctorAuthOAuthSidecarTestApi;
}

export const testing: DoctorAuthOAuthSidecarTestApi = {
  buildLegacyOAuthSecretAad(params) {
    return getTestApi().buildLegacyOAuthSecretAad(params);
  },
  buildLegacyOAuthSecretKey(seed) {
    return getTestApi().buildLegacyOAuthSecretKey(seed);
  },
};

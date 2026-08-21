export const RELEASE_VALIDATION_INTENTS = Object.freeze({
  "release-beta": Object.freeze({ profile: "beta", publishable: true, soak: false }),
  "release-stable": Object.freeze({ profile: "stable", publishable: true, soak: true }),
  "main-daily": Object.freeze({ profile: "beta", publishable: false, soak: false }),
  "main-weekly": Object.freeze({ profile: "full", publishable: false, soak: true }),
  "diagnostic-full": Object.freeze({ profile: "full", publishable: false, soak: true }),
});

const PURPOSE_INTENTS = Object.freeze({
  "beta-publish": "release-beta",
  "stable-publish": "release-stable",
  "postpublish-confidence": "diagnostic-full",
  "main-qualification": "main-weekly",
});

function displayValue(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function resolveReleaseValidationIntent(intent, assertions = {}) {
  if (typeof intent !== "string" || !Object.hasOwn(RELEASE_VALIDATION_INTENTS, intent)) {
    throw new Error(`unsupported release validation intent: ${displayValue(intent)}`);
  }
  const policy = RELEASE_VALIDATION_INTENTS[intent];
  if (assertions.profile !== undefined && assertions.profile !== policy.profile) {
    throw new Error(
      `release validation intent ${intent} profile assertion conflicts: expected ${policy.profile}, got ${displayValue(assertions.profile)}`,
    );
  }
  if (assertions.soak !== undefined && assertions.soak !== policy.soak) {
    throw new Error(
      `release validation intent ${intent} soak assertion conflicts: expected ${policy.soak}, got ${displayValue(assertions.soak)}`,
    );
  }
  return { intent, ...policy };
}

export function releaseValidationIntentForPurpose(purpose) {
  if (typeof purpose !== "string" || !Object.hasOwn(PURPOSE_INTENTS, purpose)) {
    throw new Error(`unsupported release plan purpose: ${displayValue(purpose)}`);
  }
  return PURPOSE_INTENTS[purpose];
}

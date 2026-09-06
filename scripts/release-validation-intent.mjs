const RELEASE_VALIDATION_INTENTS = Object.freeze({
  "release-beta": Object.freeze({ profile: "beta", publishable: true, soak: false }),
  "release-stable": Object.freeze({ profile: "stable", publishable: true, soak: true }),
  "main-daily": Object.freeze({ profile: "beta", publishable: false, soak: false }),
  "main-weekly": Object.freeze({ profile: "full", publishable: false, soak: true }),
  "diagnostic-full": Object.freeze({ profile: "full", publishable: false, soak: true }),
});

const PURPOSE_INTENTS = Object.freeze({
  "beta-publish": Object.freeze(["release-beta"]),
  "stable-publish": Object.freeze(["release-stable"]),
  diagnostic: Object.freeze(["diagnostic-full"]),
  "postpublish-confidence": Object.freeze(["diagnostic-full"]),
  "main-qualification": Object.freeze(["main-daily", "main-weekly"]),
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

export function releaseValidationIntentForPurpose(purpose, requestedIntent) {
  if (typeof purpose !== "string" || !Object.hasOwn(PURPOSE_INTENTS, purpose)) {
    throw new Error(`unsupported release plan purpose: ${displayValue(purpose)}`);
  }
  const allowedIntents = PURPOSE_INTENTS[purpose];
  if (requestedIntent === undefined) {
    if (allowedIntents.length !== 1) {
      throw new Error(`release plan purpose ${purpose} requires an explicit validation intent`);
    }
    return allowedIntents[0];
  }
  if (typeof requestedIntent !== "string" || !allowedIntents.includes(requestedIntent)) {
    throw new Error(
      `release plan purpose ${purpose} does not allow validation intent: ${displayValue(requestedIntent)}`,
    );
  }
  return requestedIntent;
}

export type CiTestTimings = {
  compactGroupSeconds: { blacksmith: Record<string, number>; github: Record<string, number> };
  repoE2eFileSeconds: Record<string, number>;
  source: string;
  uiE2e: { fileSeconds: Record<string, number>; perFileOverheadSeconds: number };
  updatedAt: string;
  version: 1;
};

// PR preflight imports this closure before installing dependencies; even
// workspace coercion helpers are unavailable to its bare Node process.
function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function isSecondsMap(value: unknown): value is Record<string, number> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([key, seconds]) =>
        key.length > 0 &&
        typeof seconds === "number" &&
        Number.isSafeInteger(seconds) &&
        seconds > 0,
    )
  );
}

function isCiTestTimings(value: unknown): value is CiTestTimings {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "compactGroupSeconds",
      "repoE2eFileSeconds",
      "source",
      "uiE2e",
      "updatedAt",
      "version",
    ])
  ) {
    return false;
  }
  const { compactGroupSeconds, repoE2eFileSeconds, source, uiE2e, updatedAt, version } = value;
  return (
    version === 1 &&
    typeof source === "string" &&
    source.length > 0 &&
    typeof updatedAt === "string" &&
    /^\d{4}-\d{2}-\d{2}$/u.test(updatedAt) &&
    Number.isFinite(Date.parse(updatedAt)) &&
    // Date parsing normalizes impossible days; round-trip to reject them.
    new Date(updatedAt).toISOString().slice(0, 10) === updatedAt &&
    isRecord(uiE2e) &&
    hasExactKeys(uiE2e, ["fileSeconds", "perFileOverheadSeconds"]) &&
    typeof uiE2e.perFileOverheadSeconds === "number" &&
    Number.isFinite(uiE2e.perFileOverheadSeconds) &&
    uiE2e.perFileOverheadSeconds >= 0 &&
    uiE2e.perFileOverheadSeconds <= 5 &&
    isSecondsMap(uiE2e.fileSeconds) &&
    isSecondsMap(repoE2eFileSeconds) &&
    isRecord(compactGroupSeconds) &&
    hasExactKeys(compactGroupSeconds, ["blacksmith", "github"]) &&
    isSecondsMap(compactGroupSeconds.blacksmith) &&
    isSecondsMap(compactGroupSeconds.github)
  );
}

export const ciTestTimingsSchema = {
  parse(value: unknown): CiTestTimings {
    if (!isCiTestTimings(value)) {
      throw new TypeError("Invalid CI test timings");
    }
    return value;
  },
};

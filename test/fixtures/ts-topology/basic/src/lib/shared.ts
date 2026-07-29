// TS topology shared fixture helper models a shared library export.
export function sharedThing() {
  return "shared";
}

export function singleOwnerHelper() {
  return "single-owner";
}

export function aliasedThing() {
  return "aliased";
}

export function testOnlyThing() {
  return "test-only";
}

export function unusedThing() {
  return "unused";
}

export type SharedType = {
  value: string;
};

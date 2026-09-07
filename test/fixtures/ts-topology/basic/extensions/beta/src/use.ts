// TS topology beta extension fixture imports shared SDK members.
import { sharedThing } from "fixture-sdk";
import type { SharedType } from "fixture-sdk";

export function betaUse(input: SharedType) {
  return `${sharedThing()}:${input.value}`;
}

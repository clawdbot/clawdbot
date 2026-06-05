// TS topology alpha extension fixture imports SDK members with aliases.
import { aliasedThing as renamedThing, sharedThing, singleOwnerHelper } from "fixture-sdk";
import type { SharedType } from "fixture-sdk";
import * as extra from "fixture-sdk/extra";

export function alphaUse(input: SharedType) {
  return [
    sharedThing(),
    singleOwnerHelper(),
    renamedThing(),
    extra.sharedThing(),
    input.value,
  ].join(":");
}

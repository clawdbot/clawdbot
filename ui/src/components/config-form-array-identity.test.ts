// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  appendArrayRowIdentities,
  discardArrayRowIdentities,
  preserveArrayRowIdentities,
  rowIdentitiesForArray,
} from "./config-form-array-identity.ts";

describe("config form array row identity", () => {
  it("keeps appended primitive identities unique after an equal row is removed", () => {
    const initial = ["same", "same"];
    const initialIdentities = rowIdentitiesForArray(initial);
    const afterRemoval = ["same"];
    preserveArrayRowIdentities(afterRemoval, initialIdentities.slice(1));

    const afterAppend = ["same", "same"];
    appendArrayRowIdentities(afterAppend, rowIdentitiesForArray(afterRemoval), 1);
    const appendedIdentities = rowIdentitiesForArray(afterAppend);

    expect(new Set(appendedIdentities).size).toBe(appendedIdentities.length);
    expect(appendedIdentities[0]).toBe(initialIdentities[1]);
  });

  it("removes row metadata from rejected candidate arrays", () => {
    const candidate = ["same"];
    const rejectedIdentity = Symbol("rejected-row");
    preserveArrayRowIdentities(candidate, [rejectedIdentity]);
    discardArrayRowIdentities(candidate);

    expect(rowIdentitiesForArray(candidate)[0]).not.toBe(rejectedIdentity);
  });
});

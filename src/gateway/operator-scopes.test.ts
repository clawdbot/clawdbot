import { describe, expect, it } from "vitest";
import { hasOperatorAdminScope } from "./operator-scopes.js";

describe("hasOperatorAdminScope", () => {
  it.each([
    [["operator.admin"], true],
    [["operator.read", "operator.admin", "operator.write"], true],
    [["operator.write"], false],
    [[" operator.admin "], false],
    [["OPERATOR.ADMIN"], false],
    ["operator.admin", false],
    [{ 0: "operator.admin" }, false],
    [new Set(["operator.admin"]), false],
    [null, false],
    [undefined, false],
  ] as const)("checks exact raw array membership for %j", (scopes, expected) => {
    expect(hasOperatorAdminScope(scopes)).toBe(expected);
  });
});

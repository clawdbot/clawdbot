import { describe, expect, it } from "vitest";
import {
  authorizeOperatorScopesForMethod,
  resolveLeastPrivilegeOperatorScopesForMethod,
} from "./method-scopes.js";

describe("update.report scope", () => {
  it("requires explicit operator admin authorization", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("update.report")).toEqual([
      "operator.admin",
    ]);
    expect(authorizeOperatorScopesForMethod("update.report", ["operator.write"])).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
    expect(authorizeOperatorScopesForMethod("update.report", ["operator.admin"])).toEqual({
      allowed: true,
    });
  });
});

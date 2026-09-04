import { describe, expect, it } from "vitest";
import {
  authorizeOperatorScopesForMethod,
  resolveLeastPrivilegeOperatorScopesForMethod,
} from "./method-scopes.js";

describe("sessions.patch method scopes", () => {
  it("keeps permission CAS write-scoped while full remains admin-only", () => {
    const guarded = {
      key: "agent:main:ios-1",
      expectedPermissionMode: "read-only",
      permissionMode: "guarded",
    };
    expect(resolveLeastPrivilegeOperatorScopesForMethod("sessions.patch", guarded)).toEqual([
      "operator.write",
    ]);
    expect(authorizeOperatorScopesForMethod("sessions.patch", ["operator.write"], guarded)).toEqual(
      {
        allowed: true,
      },
    );
    expect(
      authorizeOperatorScopesForMethod("sessions.patch", ["operator.write"], {
        ...guarded,
        permissionMode: "full",
      }),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
  });
});

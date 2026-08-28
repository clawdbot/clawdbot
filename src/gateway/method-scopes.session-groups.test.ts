/**
 * Gateway session-group method-scope policy tests.
 * Split from method-scopes.test.ts to keep both files under the max-lines budget.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  authorizeOperatorScopesForMethod,
  resolveLeastPrivilegeOperatorScopesForMethod,
} from "./method-scopes.js";

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("session group method scope resolution", () => {
  it.each([
    ["sessions.groups.list", ["operator.read"]],
    ["sessions.groups.defaults", ["operator.write"]],
    ["sessions.groups.put", ["operator.write"]],
    ["sessions.groups.add", ["operator.write"]],
    ["sessions.groups.reorder", ["operator.write"]],
    ["sessions.groups.rename", ["operator.write"]],
    ["sessions.groups.update", ["operator.write"]],
    ["sessions.groups.delete", ["operator.write"]],
  ])("resolves least-privilege scopes for %s", (method, expected) => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod(method)).toEqual(expected);
    expect(authorizeOperatorScopesForMethod(method, expected)).toEqual({ allowed: true });
  });
});

// Operator scope compatibility tests cover legacy operator scope normalization.
import { describe, expect, it } from "vitest";
import {
  resolveMissingRequestedScope,
  resolveScopeOutsideRequestedRoles,
  roleScopesAllow,
} from "./operator-scope-compat.js";

describe("roleScopesAllow", () => {
  it("allows empty requested scope lists regardless of granted scopes", () => {
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: [],
        allowedScopes: [],
      }),
    ).toBe(true);
  });

  it("treats operator.read as satisfied by read/write/admin scopes", () => {
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.read"],
        allowedScopes: ["operator.read"],
      }),
    ).toBe(true);
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.read"],
        allowedScopes: ["operator.write"],
      }),
    ).toBe(true);
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.read"],
        allowedScopes: ["operator.admin"],
      }),
    ).toBe(true);
  });

  it("treats operator.write as satisfied by write/admin scopes", () => {
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.write"],
        allowedScopes: ["operator.write"],
      }),
    ).toBe(true);
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.write"],
        allowedScopes: ["operator.admin"],
      }),
    ).toBe(true);
  });

  it("treats operator.approvals/operator.pairing as satisfied by operator.admin", () => {
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.approvals"],
        allowedScopes: ["operator.admin"],
      }),
    ).toBe(true);
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.pairing"],
        allowedScopes: ["operator.admin"],
      }),
    ).toBe(true);
  });

  it("does not treat operator.admin as satisfying non-operator scopes", () => {
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["system.run"],
        allowedScopes: ["operator.admin"],
      }),
    ).toBe(false);
  });

  it("uses strict matching with role-prefix partitioning for non-operator roles", () => {
    expect(
      roleScopesAllow({
        role: "node",
        requestedScopes: ["node.exec"],
        allowedScopes: ["operator.admin", "node.exec"],
      }),
    ).toBe(true);
    expect(
      roleScopesAllow({
        role: "node",
        requestedScopes: ["node.exec"],
        allowedScopes: ["operator.admin"],
      }),
    ).toBe(false);
    expect(
      roleScopesAllow({
        role: "node",
        requestedScopes: ["operator.read"],
        allowedScopes: ["operator.read", "node.exec"],
      }),
    ).toBe(false);
    expect(
      roleScopesAllow({
        role: " node ",
        requestedScopes: [" node.exec ", "node.exec", "  "],
        allowedScopes: ["node.exec", "operator.admin"],
      }),
    ).toBe(true);
  });

  it("normalizes blank and duplicate scopes before evaluating", () => {
    expect(
      roleScopesAllow({
        role: " operator ",
        requestedScopes: [" operator.read ", "operator.read", "   "],
        allowedScopes: [" operator.write ", "operator.write", ""],
      }),
    ).toBe(true);
  });

  it("rejects unsatisfied operator write scopes and empty allowed scopes", () => {
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.write"],
        allowedScopes: ["operator.read"],
      }),
    ).toBe(false);
    expect(
      roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.read"],
        allowedScopes: ["   "],
      }),
    ).toBe(false);
  });

  it("returns the first missing requested scope with operator compatibility", () => {
    expect(
      resolveMissingRequestedScope({
        role: "operator",
        requestedScopes: ["operator.read", "operator.write", "operator.approvals"],
        allowedScopes: ["operator.write"],
      }),
    ).toBe("operator.approvals");
  });

  it("returns null when all requested scopes are satisfied", () => {
    expect(
      resolveMissingRequestedScope({
        role: "node",
        requestedScopes: ["node.exec"],
        allowedScopes: ["node.exec", "operator.admin"],
      }),
    ).toBeNull();
  });

  it("returns null when every requested scope belongs to one requested role", () => {
    expect(
      resolveScopeOutsideRequestedRoles({
        requestedRoles: ["node", "operator"],
        requestedScopes: ["node.exec", "operator.read"],
      }),
    ).toBeNull();
  });

  it("returns the first scope outside the requested role set", () => {
    expect(
      resolveScopeOutsideRequestedRoles({
        requestedRoles: ["node", "operator"],
        requestedScopes: ["node.exec", "vault.admin", "operator.read"],
      }),
    ).toBe("vault.admin");
  });
});

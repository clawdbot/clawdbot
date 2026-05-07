import { describe, expect, test } from "vitest";
import {
  isRoleAuthorizedForMethod,
  parseGatewayRole,
  roleCanSkipDeviceIdentity,
} from "./role-policy.js";

describe("gateway role policy", () => {
  test("parses supported roles", () => {
    expect(parseGatewayRole("operator")).toBe("operator");
    expect(parseGatewayRole("node")).toBe("node");
    expect(parseGatewayRole("admin")).toBeNull();
    expect(parseGatewayRole(undefined)).toBeNull();
  });

  test("allows device-less bypass only for operator + shared auth", () => {
    expect(roleCanSkipDeviceIdentity("operator", true)).toBe(true);
    expect(roleCanSkipDeviceIdentity("operator", false)).toBe(false);
    expect(roleCanSkipDeviceIdentity("node", true)).toBe(false);
  });

  test("authorizes roles against node vs operator methods", () => {
    expect(isRoleAuthorizedForMethod("node", "node.event")).toBe(true);
    expect(isRoleAuthorizedForMethod("node", "node.pluginSurface.refresh")).toBe(true);
    expect(isRoleAuthorizedForMethod("node", "node.pending.drain")).toBe(true);
    expect(isRoleAuthorizedForMethod("node", "status")).toBe(false);
    expect(isRoleAuthorizedForMethod("operator", "status")).toBe(true);
    expect(isRoleAuthorizedForMethod("operator", "node.pluginSurface.refresh")).toBe(false);
    expect(isRoleAuthorizedForMethod("operator", "node.pending.drain")).toBe(false);
    expect(isRoleAuthorizedForMethod("operator", "node.event")).toBe(false);
  });
});

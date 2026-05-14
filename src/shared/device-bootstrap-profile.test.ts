import { describe, expect, test } from "vitest";
import {
  BOOTSTRAP_HANDOFF_OPERATOR_SCOPES,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  normalizeDeviceBootstrapHandoffProfile,
  resolveBootstrapProfileScopesForRole,
  resolveBootstrapProfileScopesForRoles,
} from "./device-bootstrap-profile.js";

describe("device bootstrap profile", () => {
  test("bounds bootstrap handoff scopes by role", () => {
    expect(
      resolveBootstrapProfileScopesForRole("operator", [
        "node.exec",
        "operator.admin",
        "operator.approvals",
        "operator.pairing",
        "operator.read",
        "operator.write",
      ]),
    ).toEqual(["operator.approvals", "operator.read", "operator.write"]);

    expect(
      resolveBootstrapProfileScopesForRole("node", ["node.exec", "operator.approvals"]),
    ).toStrictEqual([]);
  });

  test("bounds bootstrap handoff scopes across profile roles", () => {
    expect(
      resolveBootstrapProfileScopesForRoles(
        ["node", "operator"],
        ["node.exec", "operator.admin", "operator.approvals", "operator.read", "operator.write"],
      ),
    ).toEqual(["operator.approvals", "operator.read", "operator.write"]);

    expect(
      resolveBootstrapProfileScopesForRoles(["node"], ["node.exec", "operator.admin"]),
    ).toStrictEqual([]);
  });

  test("normalizes issued handoff profiles to the bootstrap allowlist", () => {
    expect(
      normalizeDeviceBootstrapHandoffProfile({
        roles: ["node", "operator"],
        scopes: [
          "node.exec",
          "operator.admin",
          "operator.approvals",
          "operator.pairing",
          "operator.read",
          "operator.write",
        ],
      }),
    ).toEqual({
      roles: ["node", "operator"],
      scopes: ["operator.approvals", "operator.read", "operator.write"],
    });
  });

  test("default setup profile is node-only", () => {
    expect(PAIRING_SETUP_BOOTSTRAP_PROFILE).toEqual({
      roles: ["node"],
      scopes: [],
    });
  });

  test("bootstrap handoff operator allowlist stays bounded", () => {
    expect([...BOOTSTRAP_HANDOFF_OPERATOR_SCOPES]).toEqual([
      "operator.approvals",
      "operator.read",
      "operator.talk.secrets",
      "operator.write",
    ]);
  });
});

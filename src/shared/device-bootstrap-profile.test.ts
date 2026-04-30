import { describe, expect, test } from "vitest";
import {
  BOOTSTRAP_HANDOFF_OPERATOR_SCOPES,
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
    ).toEqual([]);
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
    ).toEqual([]);
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

  test("bootstrap handoff operator allowlist stays aligned with pairing setup profile", () => {
    expect([...BOOTSTRAP_HANDOFF_OPERATOR_SCOPES]).toEqual([
      "operator.approvals",
      "operator.read",
      "operator.talk.secrets",
      "operator.write",
    ]);
  });
});

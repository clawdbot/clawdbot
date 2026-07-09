// Device bootstrap profile tests cover profile normalization for paired devices.
import { describe, expect, test } from "vitest";
import {
  BOOTSTRAP_HANDOFF_OPERATOR_SCOPES,
  NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  isNodePairingSetupBootstrapProfile,
  isPairingSetupBootstrapProfile,
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
        "operator.talk.secrets",
        "operator.write",
      ]),
    ).toEqual(["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"]);

    expect(
      resolveBootstrapProfileScopesForRole("node", ["node.exec", "operator.approvals"]),
    ).toStrictEqual([]);
  });

  test("bounds bootstrap handoff scopes across profile roles", () => {
    expect(
      resolveBootstrapProfileScopesForRoles(
        ["node", "operator"],
        [
          "node.exec",
          "operator.admin",
          "operator.approvals",
          "operator.pairing",
          "operator.read",
          "operator.talk.secrets",
          "operator.write",
        ],
      ),
    ).toEqual(["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"]);

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
          "operator.talk.secrets",
          "operator.write",
        ],
      }),
    ).toEqual({
      roles: ["node", "operator"],
      scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
    });
  });

  test("default setup profile carries node plus bounded operator handoff", () => {
    expect(PAIRING_SETUP_BOOTSTRAP_PROFILE).toEqual({
      roles: ["node", "operator"],
      scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
    });
  });

  test("node setup profile carries no operator access", () => {
    expect(NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE).toEqual({ roles: ["node"], scopes: [] });
    expect(isNodePairingSetupBootstrapProfile(NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE)).toBe(true);
    expect(isPairingSetupBootstrapProfile(NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE)).toBe(false);
  });

  test("recognizes only the current setup profile", () => {
    expect(isPairingSetupBootstrapProfile(PAIRING_SETUP_BOOTSTRAP_PROFILE)).toBe(true);
    expect(
      isPairingSetupBootstrapProfile({
        roles: ["node", "operator"],
        scopes: ["operator.approvals", "operator.read", "operator.write"],
      }),
    ).toBe(false);
    expect(
      isPairingSetupBootstrapProfile({
        roles: ["node", "operator"],
        scopes: ["operator.approvals", "operator.pairing", "operator.read", "operator.write"],
      }),
    ).toBe(false);
    expect(
      isPairingSetupBootstrapProfile({
        roles: ["node", "operator"],
        scopes: ["operator.admin", "operator.approvals", "operator.read", "operator.write"],
      }),
    ).toBe(false);
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

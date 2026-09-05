// Device bootstrap profile tests cover profile normalization for paired devices.
import { describe, expect, test } from "vitest";
import {
  BOOTSTRAP_HANDOFF_OPERATOR_SCOPES,
  CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES,
  CONTROL_UI_OWNER_BOOTSTRAP_PROFILE,
  CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  isMobilePairingSetupBootstrapProfile,
  isNodePairingSetupBootstrapProfile,
  isVoiceNodePairingSetupBootstrapProfile,
  normalizeDeviceBootstrapHandoffProfile,
  normalizeDeviceBootstrapProfile,
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
        purpose: "control-ui",
      }),
    ).toEqual({
      roles: ["node", "operator"],
      scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
      purpose: "control-ui",
    });
  });

  test("allows admin only for closed full-access purposes", () => {
    expect(
      normalizeDeviceBootstrapHandoffProfile({
        roles: ["operator"],
        scopes: [
          "operator.admin",
          "operator.approvals",
          "operator.pairing",
          "operator.read",
          "operator.talk.secrets",
          "operator.write",
        ],
        purpose: "control-ui-owner",
      }),
    ).toEqual({
      roles: ["operator"],
      scopes: [
        "operator.admin",
        "operator.approvals",
        "operator.pairing",
        "operator.read",
        "operator.talk.secrets",
        "operator.write",
      ],
      purpose: "control-ui-owner",
    });

    expect(
      normalizeDeviceBootstrapHandoffProfile({
        roles: ["node", "operator"],
        scopes: ["operator.admin", "operator.pairing", "operator.read"],
        purpose: "mobile-full",
      }),
    ).toEqual({
      roles: ["node", "operator"],
      scopes: ["operator.admin", "operator.read", "operator.write"],
      purpose: "mobile-full",
    });
  });

  test("drops unknown bootstrap purpose codes", () => {
    expect(
      normalizeDeviceBootstrapProfile(
        JSON.parse('{"roles":["operator"],"scopes":["operator.read"],"purpose":"status"}'),
      ),
    ).toEqual({
      roles: ["operator"],
      scopes: ["operator.read"],
    });
  });

  test("full setup profile carries node plus full native operator access", () => {
    expect(FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE).toEqual({
      roles: ["node", "operator"],
      scopes: [
        "operator.admin",
        "operator.approvals",
        "operator.questions",
        "operator.read",
        "operator.talk.secrets",
        "operator.write",
      ],
      purpose: "mobile-full",
    });
  });

  test("browser-owner profile carries the exact full Control UI handoff", () => {
    expect(CONTROL_UI_OWNER_BOOTSTRAP_PROFILE).toEqual({
      roles: ["operator"],
      scopes: [
        "operator.admin",
        "operator.approvals",
        "operator.pairing",
        "operator.questions",
        "operator.read",
        "operator.talk.secrets",
        "operator.write",
      ],
      purpose: "control-ui-owner",
    });
    expect([...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES]).toEqual(
      CONTROL_UI_OWNER_BOOTSTRAP_PROFILE.scopes,
    );
  });

  test("existing setup profile preserves the bounded operator handoff", () => {
    expect(PAIRING_SETUP_BOOTSTRAP_PROFILE).toEqual({
      roles: ["node", "operator"],
      scopes: [
        "operator.approvals",
        "operator.questions",
        "operator.read",
        "operator.talk.secrets",
        "operator.write",
      ],
    });
  });

  test("node setup profile carries no operator access", () => {
    expect(NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE).toEqual({ roles: ["node"], scopes: [] });
    expect(isNodePairingSetupBootstrapProfile(NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE)).toBe(true);
    expect(isMobilePairingSetupBootstrapProfile(NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE)).toBe(false);
  });

  test("cloud worker setup remains node-only while retaining lifecycle purpose", () => {
    expect(CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE).toEqual({
      roles: ["node"],
      scopes: [],
      purpose: "cloud-worker",
    });
    expect(isNodePairingSetupBootstrapProfile(CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE)).toBe(
      true,
    );
  });

  test("voice-node setup profile carries only node, read, and Talk access", () => {
    expect(VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE).toEqual({
      roles: ["node", "operator"],
      scopes: ["operator.read", "operator.talk"],
      purpose: "voice-node",
    });
    expect(isMobilePairingSetupBootstrapProfile(VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE)).toBe(
      false,
    );
    expect(
      isVoiceNodePairingSetupBootstrapProfile(VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE),
    ).toBe(true);
  });

  test("recognizes only the supported mobile setup profiles", () => {
    expect(isMobilePairingSetupBootstrapProfile(PAIRING_SETUP_BOOTSTRAP_PROFILE)).toBe(true);
    expect(isMobilePairingSetupBootstrapProfile(FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE)).toBe(
      true,
    );
    expect(
      isMobilePairingSetupBootstrapProfile({
        roles: ["node", "operator"],
        scopes: ["operator.approvals", "operator.read", "operator.write"],
      }),
    ).toBe(false);
    expect(
      isMobilePairingSetupBootstrapProfile({
        roles: ["node", "operator"],
        scopes: ["operator.approvals", "operator.pairing", "operator.read", "operator.write"],
      }),
    ).toBe(false);
    expect(
      isMobilePairingSetupBootstrapProfile({
        roles: ["node", "operator"],
        scopes: ["operator.admin", "operator.approvals", "operator.read", "operator.write"],
      }),
    ).toBe(false);
  });

  test("bootstrap handoff operator allowlist stays bounded", () => {
    expect([...BOOTSTRAP_HANDOFF_OPERATOR_SCOPES]).toEqual([
      "operator.approvals",
      "operator.questions",
      "operator.read",
      "operator.talk.secrets",
      "operator.write",
    ]);
  });
});

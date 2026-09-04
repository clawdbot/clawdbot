import { afterEach, describe, expect, it } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  authorizeGatewaySessionCreation,
  invalidateOperatorRolePolicy,
  resolveCreatorSandbox,
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicy,
  resolveOperatorRolePolicyForAssignment,
  resolveOperatorRolePolicyForProfile,
} from "./operator-role-policy.js";
import type { GatewayClient } from "./server-methods/shared-types.js";

const guestRole = {
  sessions: { others: "view" },
  agents: ["guest-agent"],
  scopes: ["operator.read", "operator.write"],
} as const;

function roleConfig(defaultRole = true): OpenClawConfig {
  return {
    gateway: {
      roles: {
        ...(defaultRole ? { default: "guest" } : {}),
        definitions: {
          guest: {
            sessions: { others: guestRole.sessions.others },
            agents: [...guestRole.agents],
            scopes: [...guestRole.scopes],
          },
          maintainer: {
            sessions: { others: "write" },
            agents: "*",
            scopes: ["operator.admin"],
          },
        },
      },
    },
  };
}

function identifiedClient(profileId: string): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.read"],
    },
    authenticatedUserProfile: {
      profileId,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

afterEach(() => closeOpenClawStateDatabaseForTest());

describe("operator role policy", () => {
  it("preserves legacy access only when operator roles are not configured", () => {
    expect(resolveOperatorRolePolicyForProfile("unread-profile", {})).toBeUndefined();
    expect(resolveOperatorRolePolicyForProfile(undefined, roleConfig())).toMatchObject({
      sessions: { others: "none" },
      agents: [],
      scopes: [],
    });
    expect(resolveOperatorRolePolicy(null, roleConfig())).toMatchObject({
      sessions: { others: "none" },
      agents: [],
      scopes: [],
    });
  });

  it("resolves explicit and default assignments from the durable profile", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("role-default@example.com");
      const cfg = roleConfig();

      expect(resolveOperatorRolePolicy(identifiedClient(profile.id), cfg)).toEqual(guestRole);

      setUserProfileRole(profile.id, "maintainer");
      invalidateOperatorRolePolicy(profile.id);

      expect(resolveOperatorRolePolicyForProfile(profile.id, cfg)).toEqual(
        cfg.gateway?.roles?.definitions.maintainer,
      );
    });
  });

  it("keeps human-derived sandbox restrictions separate from profile provenance", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("role-sandbox-creator@example.com");
      const cfg = roleConfig();
      const guest = cfg.gateway?.roles?.definitions.guest;
      if (!guest) {
        throw new Error("missing guest role");
      }
      guest.sandbox = "required";

      for (const source of ["profile", "channel", "unknown"] as const) {
        expect(
          resolveCreatorSandbox(cfg, { actor: { type: "human", source, id: profile.id } }),
        ).toBe("required");
      }
      expect(
        resolveCreatorSandbox(cfg, {
          actor: { type: "human", source: "profile", id: GATEWAY_OWNER_PROFILE_ID },
        }),
      ).toBeUndefined();
      expect(
        resolveCreatorSandbox(cfg, { actor: { type: "agent", id: profile.id } }),
      ).toBeUndefined();
      expect(
        resolveCreatorSandbox(cfg, { actor: { type: "system", id: profile.id } }),
      ).toBeUndefined();
      expect(
        resolveCreatorSandbox(cfg, { actor: { type: "human", source: "unknown" } }),
      ).toBeUndefined();
      expect(
        resolveCreatorSandbox({}, { actor: { type: "human", source: "profile", id: profile.id } }),
      ).toBeUndefined();

      setUserProfileRole(profile.id, "maintainer");
      invalidateOperatorRolePolicy(profile.id);

      expect(
        resolveCreatorSandbox(cfg, { actor: { type: "human", source: "profile", id: profile.id } }),
      ).toBeUndefined();
    });
  });

  it("keeps owner attribution out of named roles and preserves explicit authority", () => {
    const cfg = roleConfig();
    const owner = identifiedClient(GATEWAY_OWNER_PROFILE_ID);
    expect(resolveGatewayOperatorRoleActor(owner)).toBeUndefined();
    expect(resolveOperatorRolePolicyForProfile(GATEWAY_OWNER_PROFILE_ID, cfg)).toBeUndefined();
    expect(
      resolveOperatorRolePolicyForAssignment(GATEWAY_OWNER_PROFILE_ID, "guest", cfg),
    ).toBeUndefined();
    owner.internal = { operatorRoleActor: { kind: "system" } };
    expect(resolveGatewayOperatorRoleActor(owner)).toEqual({ kind: "system" });
    expect(resolveOperatorRolePolicy(owner, cfg)).toBeUndefined();
  });

  it("falls back from stale assignments to the configured default or denies access", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("role-stale@example.com");
      setUserProfileRole(profile.id, "retired");

      expect(resolveOperatorRolePolicyForProfile(profile.id, roleConfig())).toEqual(guestRole);
      expect(resolveOperatorRolePolicyForProfile(profile.id, roleConfig(false))).toMatchObject({
        sessions: { others: "none" },
        agents: [],
        scopes: [],
      });
    });
  });

  it("retains the prepared assignment until the owner explicitly invalidates it", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("role-cache@example.com");
      const cfg = roleConfig();

      expect(resolveOperatorRolePolicyForProfile(profile.id, cfg)).toEqual(guestRole);
      setUserProfileRole(profile.id, "maintainer");
      expect(resolveOperatorRolePolicyForProfile(profile.id, cfg)).toEqual(guestRole);

      invalidateOperatorRolePolicy(profile.id);

      expect(resolveOperatorRolePolicyForProfile(profile.id, cfg)).toEqual(
        cfg.gateway?.roles?.definitions.maintainer,
      );
    });
  });

  it("authorizes only configured agents and rejects unidentified operators", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("role-agents@example.com");
      const cfg = roleConfig();

      expect(
        authorizeGatewaySessionCreation({
          cfg,
          profileId: profile.id,
          agentId: "guest-agent",
        }),
      ).toBeUndefined();
      expect(
        authorizeGatewaySessionCreation({ cfg, profileId: profile.id, agentId: "private-agent" }),
      ).toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringContaining("private-agent"),
      });
      expect(
        authorizeGatewaySessionCreation({ cfg, profileId: undefined, agentId: "private-agent" }),
      ).toMatchObject({ code: "FORBIDDEN" });
      expect(
        authorizeGatewaySessionCreation({
          cfg,
          actor: { kind: "system" },
          agentId: "private-agent",
        }),
      ).toBeUndefined();
      const trackedOperator = identifiedClient(profile.id);
      delete trackedOperator.authenticatedUserProfile;
      trackedOperator.internal = {
        syntheticClient: true,
        operatorRoleActor: { kind: "operator", profileId: profile.id },
      };
      expect(
        authorizeGatewaySessionCreation({ cfg, client: trackedOperator, agentId: "private-agent" }),
      ).toMatchObject({ code: "FORBIDDEN" });
      expect(resolveOperatorRolePolicy(trackedOperator, cfg)).toEqual(guestRole);
      trackedOperator.internal.operatorRoleActor = { kind: "system" };
      expect(
        authorizeGatewaySessionCreation({ cfg, client: trackedOperator, agentId: "private-agent" }),
      ).toBeUndefined();
      expect(resolveOperatorRolePolicy(trackedOperator, cfg)).toBeUndefined();
    });
  });
});

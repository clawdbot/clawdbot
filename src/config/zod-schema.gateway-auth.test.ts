import { describe, expect, test } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("gateway trusted-proxy device auto-approval config", () => {
  test("accepts bounded non-admin scopes", () => {
    const result = OpenClawSchema.safeParse({
      gateway: {
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-forwarded-user",
            deviceAutoApprove: {
              enabled: true,
              scopes: ["operator.read", "operator.write", "operator.approvals"],
            },
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  test.each(["operator.admin", " operator.admin "])(
    "accepts %j as an explicit admin opt-in",
    (adminScope) => {
      const result = OpenClawSchema.safeParse({
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-forwarded-user",
              deviceAutoApprove: {
                enabled: true,
                scopes: ["operator.read", adminScope],
              },
            },
          },
        },
      });

      expect(result.success).toBe(true);
    },
  );
});

describe("gateway identity scope grants config", () => {
  test.each([
    { scope: "operator.admin", success: true },
    { scope: "operator.superuser", success: false },
  ])("validates configured scope $scope", ({ scope, success }) => {
    const result = OpenClawSchema.safeParse({
      gateway: {
        auth: {
          identityScopes: {
            "admin@example.com": [scope],
          },
        },
      },
    });

    expect(result.success).toBe(success);
  });
});

describe("gateway operator role config", () => {
  const validRole = {
    sessions: { others: "view" },
    agents: ["guest-agent"],
    scopes: ["operator.read", "operator.write"],
  };

  test.each(["none", "view", "suggest", "write"])(
    "accepts the closed foreign-session access level %s",
    (others) => {
      const result = OpenClawSchema.safeParse({
        gateway: {
          roles: {
            default: "guest",
            definitions: { guest: { ...validRole, sessions: { others } } },
          },
        },
      });

      expect(result.success).toBe(true);
    },
  );

  test.each([
    { name: "all agents and explicit admin scope", agents: "*", scopes: ["operator.admin"] },
    { name: "an empty agent allowlist", agents: [], scopes: ["operator.read"] },
  ])("accepts $name", ({ agents, scopes }) => {
    const result = OpenClawSchema.safeParse({
      gateway: {
        roles: { default: "guest", definitions: { guest: { ...validRole, agents, scopes } } },
      },
    });

    expect(result.success).toBe(true);
  });

  test.each([
    { name: "unknown session permission", role: { ...validRole, sessions: { others: "edit" } } },
    { name: "unknown operator scope", role: { ...validRole, scopes: ["operator.superuser"] } },
    { name: "resource wildcard expression", role: { ...validRole, agents: "agent:*" } },
    { name: "wildcard in an agent allowlist", role: { ...validRole, agents: ["*"] } },
    { name: "blank allowed agent", role: { ...validRole, agents: [" "] } },
    { name: "missing session policy", role: { agents: "*", scopes: ["operator.read"] } },
    { name: "freeform capability", role: { ...validRole, capability: "sessions.delete" } },
  ])("rejects $name", ({ role }) => {
    const result = OpenClawSchema.safeParse({
      gateway: {
        roles: { default: "guest", definitions: { guest: role } },
      },
    });

    expect(result.success).toBe(false);
  });

  test("rejects a default role that has no definition", () => {
    const result = OpenClawSchema.safeParse({
      gateway: {
        roles: { default: "missing", definitions: { guest: validRole } },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ["gateway", "roles", "default"] }),
        ]),
      );
    }
  });

  test.each([
    {
      name: "role definitions without a default policy",
      roles: { definitions: { guest: validRole } },
      issuePath: ["gateway", "roles", "default"],
    },
    {
      name: "role enforcement without any definitions",
      roles: { definitions: {} },
      issuePath: ["gateway", "roles", "definitions"],
    },
  ])("rejects $name", ({ roles, issuePath }) => {
    const result = OpenClawSchema.safeParse({ gateway: { roles } });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: issuePath })]),
      );
    }
  });

  test("normalizes and deduplicates configured agent and operator-scope allowlists", () => {
    const result = OpenClawSchema.safeParse({
      gateway: {
        roles: {
          default: "guest",
          definitions: {
            guest: {
              ...validRole,
              agents: [" Guest-Agent ", "guest-agent", "SECOND-agent"],
              scopes: ["operator.read", "operator.write", "operator.read"],
            },
          },
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gateway?.roles?.definitions.guest).toMatchObject({
        agents: ["guest-agent", "second-agent"],
        scopes: ["operator.read", "operator.write"],
      });
    }
  });

  test("keeps roles optional for existing solo and shared-secret configurations", () => {
    expect(OpenClawSchema.safeParse({ gateway: { auth: { mode: "token" } } }).success).toBe(true);
  });
});

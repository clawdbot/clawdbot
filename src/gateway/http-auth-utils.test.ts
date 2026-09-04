import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setDisplayName } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayAuthResult } from "./auth.js";
import {
  checkGatewayHttpRequestAuth,
  resolveSharedSecretHttpOperatorScopes,
} from "./http-auth-utils.js";

const { authorize, ensureOwner } = vi.hoisted(() => ({ authorize: vi.fn(), ensureOwner: vi.fn() }));
vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.js")>()),
  authorizeHttpGatewayConnect: authorize,
}));
vi.mock("../infra/host-account-name.js", () => ({
  resolveHostAccountName: async () => "Gateway Person",
}));
vi.mock("../state/user-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/user-profiles.js")>();
  ensureOwner.mockImplementation(actual.ensureGatewayOwnerProfile);
  return { ...actual, ensureGatewayOwnerProfile: ensureOwner };
});

const roles: NonNullable<NonNullable<OpenClawConfig["gateway"]>["roles"]> = {
  default: "reader",
  definitions: { reader: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] } },
};
const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage;

async function authenticate(
  method: GatewayAuthResult["method"],
  cfg: OpenClawConfig = {},
  user?: string,
) {
  authorize.mockResolvedValueOnce({ ok: true, method, ...(user ? { user } : {}) });
  return checkGatewayHttpRequestAuth({ req, auth: { mode: "none", allowTailscale: false }, cfg });
}

describe("HTTP gateway owner profiles", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shares the durable owner across auth methods and preserves an edited name", async () => {
    await withOpenClawTestState({ label: "http-owner-profile" }, async () => {
      let profileId: string | undefined;
      for (const method of ["token", "password", "device-token", "none"] as const) {
        const result = await authenticate(method);
        expect(result.ok).toBe(true);
        if (!result.ok) {
          throw new Error("expected authenticated request");
        }
        expect(result.requestAuth.user).toBeUndefined();
        expect(result.requestAuth.authenticatedUserProfile).toMatchObject({
          displayName: profileId ? "Saved Owner" : "Gateway Person",
        });
        const currentId = result.requestAuth.authenticatedUserProfile!.profileId;
        if (profileId) {
          expect(currentId).toBe(profileId);
        } else {
          profileId = currentId;
          setDisplayName(profileId, "Saved Owner");
        }
        expect(result.requestAuth.operatorRolePolicy).toBeUndefined();
      }
    });
  });

  it.each(["token", "password"] as const)(
    "keeps %s owner authority with configured roles",
    async (method) => {
      await withOpenClawTestState({ label: "http-owner-roles" }, async () => {
        const result = await authenticate(method, { gateway: { roles } });
        expect(result.ok).toBe(true);
        if (!result.ok) {
          throw new Error("expected authenticated request");
        }
        expect(result.requestAuth.authenticatedUserProfile).toBeDefined();
        expect(result.requestAuth.operatorRolePolicy).toBeUndefined();
        expect(result.requestAuth.trustDeclaredOperatorScopes).toBe(false);
        expect(resolveSharedSecretHttpOperatorScopes(req, result.requestAuth)).toContain(
          "operator.admin",
        );
      });
    },
  );

  it.each(["none", "device-token"] as const)(
    "keeps configured-role %s requests without identity denied",
    async (method) => {
      expect(await authenticate(method, { gateway: { roles } })).toEqual({
        ok: false,
        authResult: { ok: false, reason: "user_profile_unavailable" },
      });
      expect(ensureOwner).not.toHaveBeenCalled();
    },
  );

  it("preserves a verified user's profile and role ceiling", async () => {
    await withOpenClawTestState({ label: "http-identified-profile" }, async () => {
      const result = await authenticate(
        "trusted-proxy",
        { gateway: { roles } },
        "alice@example.test",
      );
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("expected authenticated request");
      }
      expect(result.requestAuth.user).toBe("alice@example.test");
      expect(result.requestAuth.authenticatedUserProfile?.displayName).toBe("alice");
      expect(result.requestAuth.operatorRolePolicy?.scopes).toEqual(["operator.read"]);
      expect(ensureOwner).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])(
    "continues unidentified after owner storage failure (roles=%s)",
    async (configured) => {
      ensureOwner.mockImplementationOnce(() => {
        throw new Error("profile storage unavailable");
      });
      const result = await authenticate("token", configured ? { gateway: { roles } } : {});
      expect(result).toMatchObject({ ok: true, requestAuth: { authMethod: "token" } });
      if (!result.ok) {
        throw new Error("expected authenticated request");
      }
      expect(result.requestAuth.authenticatedUserProfile).toBeUndefined();
      expect(result.requestAuth.operatorRolePolicy).toBeUndefined();
    },
  );
});

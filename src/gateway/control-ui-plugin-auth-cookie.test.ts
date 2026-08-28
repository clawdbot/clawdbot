import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  resolveControlUiPluginAuthCookieGrants,
  setControlUiPluginAuthCookie,
} from "./control-ui-plugin-auth-cookie.js";
import { authorizeControlUiPluginCookieRequest } from "./http-auth-utils.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { makeMockHttpResponse } from "./test-http-response.js";
import { withTempConfig } from "./test-temp-config.js";

function issueCookie(profileId?: string): string {
  const { res, setHeader } = makeMockHttpResponse();
  setControlUiPluginAuthCookie(
    res,
    [{ pluginId: "example", path: "/plugins/example", match: "prefix", scopes: ["operator.read"] }],
    { generation: "generation", ...(profileId ? { profileId } : {}) },
  );
  const value = setHeader.mock.calls.at(-1)?.[1];
  const header = Array.isArray(value) ? value[0] : value;
  if (typeof header !== "string" || !header) {
    throw new Error("expected plugin auth cookie");
  }
  return header.split(";", 1)[0]!;
}

function authorizeCookie(cookie: string) {
  return authorizeControlUiPluginCookieRequest(
    { method: "GET", headers: { cookie } } as IncomingMessage,
    {
      requestPath: "/plugins/example/session",
      authGeneration: "generation",
    },
  );
}

async function withRoleConfig(run: () => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await withTempConfig({
      cfg: {
        gateway: {
          roles: {
            default: "denied",
            definitions: {
              admin: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
              writer: { sessions: { others: "write" }, agents: "*", scopes: ["operator.write"] },
              denied: { sessions: { others: "none" }, agents: [], scopes: [] },
            },
          },
        },
      },
      run,
    });
  });
}

describe("Control UI plugin auth cookie profile binding", () => {
  it.each(["admin", "writer"])(
    "preserves a read grant under %s until the profile is demoted",
    async (role) => {
      await withRoleConfig(async () => {
        const profile = ensureProfileForEmail("plugin-reader@example.test");
        setUserProfileRole(profile.id, role);
        const cookie = issueCookie(profile.id);
        try {
          expect(authorizeCookie(cookie)?.requestAuth).toMatchObject({
            authenticatedUserProfile: { profileId: profile.id },
            controlUiPluginGrants: [{ pluginId: "example", scopes: ["operator.read"] }],
          });
          setUserProfileRole(profile.id, "denied");
          invalidateOperatorRolePolicy(profile.id);
          expect(authorizeCookie(cookie)?.requestAuth.controlUiPluginGrants).toMatchObject([
            { pluginId: "example", scopes: [] },
          ]);
        } finally {
          invalidateOperatorRolePolicy(profile.id);
        }
      });
    },
  );

  it.each([undefined, "missing-profile"])(
    "rejects a signed grant without a current durable profile (%s)",
    async (profileId) => {
      await withRoleConfig(async () => {
        expect(authorizeCookie(issueCookie(profileId))).toBeNull();
      });
    },
  );

  it("preserves the authenticated durable profile inside the signed grant", () => {
    const request = {
      headers: { cookie: issueCookie("profile-guest") },
    } as IncomingMessage;

    expect(
      resolveControlUiPluginAuthCookieGrants(request, {
        requestPath: "/plugins/example/session",
        generation: "generation",
      }),
    ).toEqual([
      {
        pluginId: "example",
        path: "/plugins/example",
        match: "prefix",
        scopes: ["operator.read"],
        profileId: "profile-guest",
      },
    ]);
  });

  it("keeps legacy grants unchanged when no profile is bound", async () => {
    const request = { headers: { cookie: issueCookie() } } as IncomingMessage;

    expect(
      resolveControlUiPluginAuthCookieGrants(request, {
        requestPath: "/plugins/example",
        generation: "generation",
      }),
    ).toEqual([
      {
        pluginId: "example",
        path: "/plugins/example",
        match: "prefix",
        scopes: ["operator.read"],
      },
    ]);
    await withTempConfig({
      cfg: {},
      run: async () => {
        expect(authorizeCookie(issueCookie())?.requestAuth.controlUiPluginGrants).toEqual([
          {
            pluginId: "example",
            path: "/plugins/example",
            match: "prefix",
            scopes: ["operator.read"],
          },
        ]);
      },
    });
  });
});

import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  resolveControlUiPluginAuthCookieGrants,
  setControlUiPluginAuthCookie,
} from "./control-ui-plugin-auth-cookie.js";
import { makeMockHttpResponse } from "./test-http-response.js";

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

describe("Control UI plugin auth cookie profile binding", () => {
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

  it("keeps legacy grants unchanged when no profile is bound", () => {
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
  });
});

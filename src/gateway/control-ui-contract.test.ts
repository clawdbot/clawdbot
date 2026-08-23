import { describe, expect, it } from "vitest";
import {
  buildControlUiChannelAvatarUrl,
  buildControlUiResourcePath,
  buildControlUiRootAssetPath,
  buildControlUiUserAvatarPath,
  canonicalizeControlUiUserAvatarPath,
  CONTROL_UI_ROOT_PUBLIC_ASSETS,
  matchControlUiResourceUrl,
  parseControlUiUserAvatarPath,
  parseControlUiResourcePath,
  type ControlUiResourceRoute,
} from "./control-ui-contract.js";

const ROUTES = [
  {
    route: "agentAvatar",
    value: "ops/main",
    path: "/avatar/ops%2Fmain",
  },
  {
    route: "catalogIcon",
    value: "https://cdn.example.test/icon.svg",
    path: "/__openclaw__/catalog-icon/https%3A%2F%2Fcdn.example.test%2Ficon.svg",
  },
  {
    route: "channelAvatar",
    value: "agent:main:discord:direct:user-1",
    path: "/__openclaw__/channel-avatar/agent%3Amain%3Adiscord%3Adirect%3Auser-1",
  },
  {
    route: "linkFavicon",
    value: "docs.example.test",
    path: "/__openclaw__/link-favicon/docs.example.test",
  },
  {
    route: "pluginIcon",
    value: "@scope/plugin",
    path: "/__openclaw__/plugin-icon/%40scope%2Fplugin",
  },
  {
    route: "userAvatar",
    value: "profile/a b",
    path: "/api/users/profile%2Fa%20b/avatar",
  },
  {
    route: "workspaceIcon",
    value: "agent:main:one",
    path: "/__openclaw__/workspace-icon/agent%3Amain%3Aone",
  },
] as const satisfies readonly {
  route: ControlUiResourceRoute;
  value: string;
  path: string;
}[];

describe("Control UI resource route contract", () => {
  it.each(ROUTES)("round-trips $route as one encoded segment", ({ route, value, path }) => {
    expect(buildControlUiResourcePath(route, "", value)).toBe(path);
    expect(buildControlUiResourcePath(route, "control/", value)).toBe(`/control${path}`);
    expect(parseControlUiResourcePath(route, path)).toEqual({ matched: true, value });
    expect(parseControlUiResourcePath(route, `/control${path}`, "/control/")).toEqual({
      matched: true,
      value,
    });
  });

  it.each([
    ["blank segment", "/__openclaw__/workspace-icon/"],
    ["raw nested segment", "/__openclaw__/workspace-icon/agent/main"],
    ["malformed escape", "/__openclaw__/workspace-icon/%zz"],
  ])("claims a %s without producing a route value", (_label, pathname) => {
    expect(parseControlUiResourcePath("workspaceIcon", pathname)).toEqual({
      matched: true,
      value: null,
    });
  });

  it("does not claim another resource route", () => {
    expect(
      parseControlUiResourcePath("workspaceIcon", "/__openclaw__/plugin-icon/firecrawl"),
    ).toEqual({ matched: false });
  });

  it("builds and canonicalizes cache-busted user avatar paths", () => {
    expect(buildControlUiUserAvatarPath("profile/a b", "hash/image")).toBe(
      "/api/users/profile%2Fa%20b/avatar?v=hash%2Fimage",
    );
    expect(buildControlUiUserAvatarPath("profile/a b", 1_725_000_123_456)).toBe(
      "/api/users/profile%2Fa%20b/avatar?v=1725000123456",
    );
    expect(
      canonicalizeControlUiUserAvatarPath("/wilfred/api/users/profile%2F1/avatar", "/wilfred"),
    ).toBe("/api/users/profile%2F1/avatar");
    expect(
      canonicalizeControlUiUserAvatarPath("/wilfred-other/api/users/profile-1/avatar", "/wilfred"),
    ).toBeUndefined();
  });

  it("preserves malformed configured-base user avatar ownership", () => {
    expect(
      parseControlUiUserAvatarPath("/wilfred/api/users/profile-1/avatar/extra", "/wilfred"),
    ).toEqual({ matched: true, value: null });
  });

  it("builds revision-aware channel avatar paths through the route contract", () => {
    expect(buildControlUiChannelAvatarUrl("/control", "agent:main/one", "hash/image")).toBe(
      "/control/__openclaw__/channel-avatar/agent%3Amain%2Fone?v=hash%2Fimage",
    );
  });

  it("matches exact same-origin resource URLs without parser reinterpretation", () => {
    expect(matchControlUiResourceUrl("agentAvatar", "/avatar/main?v=2#profile")).toEqual({
      value: "main",
      search: "?v=2",
      hash: "#profile",
    });
    expect(
      matchControlUiResourceUrl("agentAvatar", "/control/avatar/main?v=2", "/control"),
    ).toEqual({ value: "main", search: "?v=2", hash: "" });
    for (const value of [
      "//evil.example/avatar/main",
      "//[",
      "/avatar\\main",
      "/avatar/main/extra",
      "/avatar/%zz",
    ]) {
      expect(matchControlUiResourceUrl("agentAvatar", value), value).toBeUndefined();
    }
  });

  it("builds every declared root asset under the normalized mount", () => {
    expect(new Set(CONTROL_UI_ROOT_PUBLIC_ASSETS).size).toBe(CONTROL_UI_ROOT_PUBLIC_ASSETS.length);
    for (const asset of CONTROL_UI_ROOT_PUBLIC_ASSETS) {
      expect(buildControlUiRootAssetPath("/control/", asset)).toBe(`/control/${asset}`);
    }
  });
});

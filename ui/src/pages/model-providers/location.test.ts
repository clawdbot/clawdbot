import { describe, expect, it } from "vitest";
import { modelsLocation, modelsNavigationOptions, readModelsRouteState } from "./location.ts";

describe("Models locations", () => {
  it.each([
    ["", { view: "manage", firstRun: false }],
    ["?view=connect", { view: "connect", firstRun: false }],
    ["?firstRun=1", { view: "connect", firstRun: true }],
  ] as const)("reads %s as one typed workspace state", (search, expected) => {
    expect(readModelsRouteState({ search })).toEqual(expected);
  });

  it("builds direct manage and connect navigation without stale workspace state", () => {
    expect(modelsNavigationOptions({ view: "connect", firstRun: true })).toEqual({
      search: "?view=connect&firstRun=1",
      hash: "",
    });
    expect(
      modelsNavigationOptions(
        { view: "manage" },
        { search: "?view=connect&firstRun=1&provider=xai", hash: "#provider" },
      ),
    ).toEqual({ search: "?provider=xai", hash: "#provider" });
  });

  it("preserves unrelated query and hash state when adapting a legacy setup URL", () => {
    expect(
      modelsLocation(
        "/ui",
        { view: "connect", firstRun: true },
        { search: "?provider=xai&firstRun=1", hash: "#candidate" },
      ),
    ).toEqual({
      pathname: "/ui/settings/model-providers",
      search: "?provider=xai&firstRun=1&view=connect",
      hash: "#candidate",
    });
  });
});

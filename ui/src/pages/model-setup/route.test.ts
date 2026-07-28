import type { RouteLocation } from "@openclaw/uirouter";
import { describe, expect, it } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { page } from "./route.ts";

describe("model setup route", () => {
  it("keys loader data by the first-run query", () => {
    const location = (search: string): RouteLocation => ({
      pathname: "/settings/model-setup",
      search,
      hash: "",
    });
    const context = {} as ApplicationContext;

    expect(page.loaderDeps?.(context, location(""))).toBe("");
    expect(page.loaderDeps?.(context, location("?firstRun=1"))).toBe("?firstRun=1");
  });
});

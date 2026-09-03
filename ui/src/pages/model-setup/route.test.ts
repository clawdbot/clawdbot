import type { RouteLoaderOptions, RouteLocation } from "@openclaw/uirouter";
import { describe, expect, it } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { page } from "./route.ts";

const location: RouteLocation = {
  pathname: "/settings/model-setup",
  search: "",
  hash: "",
};

async function loadRedirect(current: RouteLocation, basePath = "") {
  const loader = page.loader;
  if (!loader) {
    throw new Error("model setup redirect loader missing");
  }
  const context = { basePath } as ApplicationContext;
  return await loader(context, {
    location: current,
    signal: new AbortController().signal,
    shouldRun: () => true,
    revalidating: false,
    deps: page.loaderDeps?.(context, current) ?? "",
    cause: "navigation",
  } satisfies RouteLoaderOptions);
}

describe("model setup compatibility route", () => {
  it("keys redirects by query and hash state", () => {
    const context = { basePath: "" } as ApplicationContext;
    expect(page.loaderDeps?.(context, location)).toBe("\u0000");
    expect(
      page.loaderDeps?.(context, { ...location, search: "?firstRun=1", hash: "#candidate" }),
    ).toBe("?firstRun=1\u0000#candidate");
  });

  it.each([
    {
      name: "ordinary setup",
      current: { ...location, search: "?provider=xai", hash: "#candidate" },
      basePath: "",
      expected: {
        pathname: "/settings/model-providers",
        search: "?provider=xai&view=connect",
        hash: "#candidate",
      },
    },
    {
      name: "first run under a base path",
      current: {
        pathname: "/ui/settings/model-setup",
        search: "?firstRun=1&bootstrapProfile=owner",
        hash: "#resume",
      },
      basePath: "/ui",
      expected: {
        pathname: "/ui/settings/model-providers",
        search: "?firstRun=1&bootstrapProfile=owner&view=connect",
        hash: "#resume",
      },
    },
  ])("redirects $name into the Models connect view", async ({ current, basePath, expected }) => {
    await expect(loadRedirect(current, basePath)).resolves.toEqual({
      type: "redirect",
      location: expected,
    });
  });
});

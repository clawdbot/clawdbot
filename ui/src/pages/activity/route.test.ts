// @vitest-environment node
import type { RouteLoaderOptions, RouteLocation } from "@openclaw/uirouter";
import { describe, expect, it } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { page } from "./route.ts";
import type { ActivityRouteData } from "./run-inspector-model.ts";

function loadRoute(search: string): ActivityRouteData {
  if (!page.loader) {
    throw new Error("activity route has no loader");
  }
  const location: RouteLocation = { pathname: "/activity", search, hash: "" };
  return page.loader({} as ApplicationContext, {
    signal: new AbortController().signal,
    shouldRun: () => true,
    revalidating: false,
    location,
    deps: search,
    cause: "navigation",
  } satisfies RouteLoaderOptions) as ActivityRouteData;
}

describe("resolveActivityRouteData", () => {
  it("keeps the default Activity route on the live browser-local view", () => {
    expect(loadRoute("")).toEqual({ mode: "live", selector: null });
    expect(loadRoute("?view=other&run=ignored")).toEqual({
      mode: "live",
      selector: null,
    });
  });

  it("decodes one run-inspector query reference without narrowing it", () => {
    const runId = "run:a/b % lobster";
    expect(loadRoute(`?view=run&run=${encodeURIComponent(runId)}`)).toEqual({
      mode: "run",
      selector: { kind: "run", id: runId },
    });
  });

  it("selects one exact execution without also sending the run selector", () => {
    const executionId = "execution:a/b % lobster";
    expect(
      loadRoute(`?view=run&run=ambiguous&execution=${encodeURIComponent(executionId)}`),
    ).toEqual({
      mode: "run",
      selector: { kind: "execution", id: executionId },
    });
  });

  it("keeps a run view with an empty selection explicit", () => {
    expect(loadRoute("?view=run")).toEqual({ mode: "run", selector: null });
    expect(loadRoute("?view=run&run=%20%20")).toEqual({
      mode: "run",
      selector: null,
    });
  });
});

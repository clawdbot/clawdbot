// @vitest-environment node
import type { RouteLoaderOptions, RouteLocation } from "@openclaw/uirouter";
import { describe, expect, it } from "vitest";
import { activityPersonFromPath } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { page } from "./route.ts";
import { resolveActivityRouteData, type ActivityRouteData } from "./run-inspector-model.ts";

function loadRoute(search: string, pathname = "/activity", basePath = ""): ActivityRouteData {
  if (!page.loader) {
    throw new Error("activity route has no loader");
  }
  const location: RouteLocation = { pathname, search, hash: "" };
  const loaded = page.loader({} as ApplicationContext, {
    signal: new AbortController().signal,
    shouldRun: () => true,
    revalidating: false,
    location,
    deps: search,
    cause: "navigation",
  } satisfies RouteLoaderOptions);
  if (!("pathname" in loaded)) {
    throw new Error("activity route did not return a location");
  }
  return resolveActivityRouteData(loaded.search, activityPersonFromPath(loaded.pathname, basePath));
}

describe("resolveActivityRouteData", () => {
  it("opens the session feed by default and decodes its linkable filters", () => {
    expect(loadRoute("")).toEqual({
      mode: "sessions",
      filters: { personId: null, query: "", time: "7d" },
      selector: null,
    });
    expect(loadRoute("?view=other&run=ignored")).toEqual({
      mode: "sessions",
      filters: { personId: null, query: "", time: "7d" },
      selector: null,
    });
    expect(loadRoute("?person=alice&time=30d&q=release")).toEqual({
      mode: "sessions",
      filters: { personId: "alice", query: "release", time: "30d" },
      selector: null,
    });
  });

  it("keeps the browser-local tool feed behind its explicit mode", () => {
    expect(loadRoute("?view=live")).toEqual({ mode: "live", selector: null });
  });

  it("scopes readable person paths independently of query filters and mounted prefixes", () => {
    expect(
      loadRoute("?person=ignored&time=30d&q=release", "/ui/activity/ada-12345678", "/ui"),
    ).toEqual({
      mode: "sessions",
      filters: { personId: "12345678", time: "30d", query: "release" },
      selector: null,
    });
    expect(loadRoute("?view=live", "/activity/ada-12345678")).toEqual({
      mode: "live",
      selector: null,
    });
  });

  it("decodes one run-inspector query reference without narrowing it", () => {
    const runId = "run:a/b % lobster";
    expect(loadRoute(`?view=run&run=${encodeURIComponent(runId)}`)).toEqual({
      mode: "run",
      selector: { kind: "run", id: runId },
      selectorId: null,
      decisionCursor: null,
    });
  });

  it("selects one exact execution without also sending the run selector", () => {
    const executionId = "execution:a/b % lobster";
    expect(
      loadRoute(`?view=run&run=ambiguous&execution=${encodeURIComponent(executionId)}`),
    ).toEqual({
      mode: "run",
      selector: { kind: "execution", id: executionId },
      selectorId: null,
      decisionCursor: null,
    });
  });

  it("preserves an encoded receipt deep link only with its selected page", () => {
    expect(
      loadRoute("?view=run&run=run-1&receipt=receipt%3Aa%2Fb&decision=cursor%3A10%3A2"),
    ).toEqual({
      mode: "run",
      selector: { kind: "run", id: "run-1" },
      selectorId: "receipt:a/b",
      decisionCursor: "cursor:10:2",
    });
    expect(loadRoute("?view=run&run=run-1&decision=ignored-without-receipt")).toEqual({
      mode: "run",
      selector: { kind: "run", id: "run-1" },
      selectorId: null,
      decisionCursor: null,
    });
  });

  it("keeps a run view with an empty selection explicit", () => {
    expect(loadRoute("?view=run")).toEqual({
      mode: "run",
      selector: null,
      selectorId: null,
      decisionCursor: null,
    });
    expect(loadRoute("?view=run&run=%20%20")).toEqual({
      mode: "run",
      selector: null,
      selectorId: null,
      decisionCursor: null,
    });
  });
});

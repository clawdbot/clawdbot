import { describe, expect, it } from "vitest";
import { resolveWorkboardRouteLocation } from "./route-location.ts";

describe("Workboard route location", () => {
  it("reads the canonical board path without rewriting it", () => {
    expect(
      resolveWorkboardRouteLocation({
        pathname: "/workboard/ops",
        search: "?agent=main",
        hash: "#ready",
      }),
    ).toEqual({ boardFilter: "ops", search: "?agent=main" });
  });

  it("redirects the shipped query alias to the canonical path", () => {
    expect(
      resolveWorkboardRouteLocation({
        pathname: "/workboard",
        search: "?agent=main&board=ops",
        hash: "#ready",
      }),
    ).toEqual({
      boardFilter: "ops",
      search: "?agent=main",
      canonicalLocation: {
        pathname: "/workboard/ops",
        search: "?agent=main",
        hash: "#ready",
      },
    });
  });

  it("drops a redundant legacy query from an already-canonical board path", () => {
    expect(
      resolveWorkboardRouteLocation({
        pathname: "/workboard/ops",
        search: "?board=other&agent=main",
        hash: "",
      }),
    ).toEqual({
      boardFilter: "ops",
      search: "?agent=main",
      canonicalLocation: {
        pathname: "/workboard/ops",
        search: "?agent=main",
        hash: "",
      },
    });
  });

  it("normalizes an invalid legacy board to the all-boards route", () => {
    expect(
      resolveWorkboardRouteLocation(
        {
          pathname: "/ui/workboard",
          search: "?board=not%20valid&agent=main",
          hash: "",
        },
        "/ui",
      ),
    ).toEqual({
      boardFilter: "__all__",
      search: "?agent=main",
      canonicalLocation: {
        pathname: "/ui/workboard",
        search: "?agent=main",
        hash: "",
      },
    });
  });
});

// Line tests cover webhook entrypoint plugin behavior.
import { describe, expect, it } from "vitest";
import { startLineWebhook } from "./webhook.js";

describe("startLineWebhook", () => {
  // The route an operator is told to register and the route the gateway serves come
  // from one resolver. Nothing pinned that here, so a partial adoption — taking the
  // default constant without the resolution rules — passed the whole suite.
  it.each([
    { name: "no path configured", path: undefined, expected: "/line/webhook" },
    { name: "an empty path", path: "", expected: "/line/webhook" },
    { name: "a path with no leading slash", path: "hooks/line", expected: "/hooks/line" },
    { name: "a trailing slash", path: "/hooks/line/", expected: "/hooks/line" },
    { name: "surrounding whitespace", path: "  /hooks/line  ", expected: "/hooks/line" },
  ])("serves $name as the resolved route", ({ path, expected }) => {
    const { path: served } = startLineWebhook({
      channelSecret: "secret",
      onEvents: async () => {},
      ...(path === undefined ? {} : { path }),
    });

    expect(served).toBe(expected);
  });

  it("rejects a missing channel secret rather than serving an unverified route", () => {
    expect(() => startLineWebhook({ channelSecret: "  ", onEvents: async () => {} })).toThrow(
      /non-empty channel secret/,
    );
  });
});

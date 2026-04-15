import { describe, expect, it, vi } from "vitest";
import {
  collectSlackCursorItems,
  resolveSlackAllowlistEntries,
} from "./resolve-allowlist-common.js";

describe("collectSlackCursorItems", () => {
  it("collects items across cursor pages", async () => {
    type MockPage = {
      items: string[];
      response_metadata?: { next_cursor?: string };
    };
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: ["a", "b"],
        response_metadata: { next_cursor: "cursor-1" },
      })
      .mockResolvedValueOnce({
        items: ["c"],
        response_metadata: { next_cursor: "" },
      });

    const items = await collectSlackCursorItems<string, MockPage>({
      fetchPage,
      collectPageItems: (response) => response.items,
    });

    expect(items).toEqual(["a", "b", "c"]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});

describe("resolveSlackAllowlistEntries", () => {
  it("handles id, non-id, and unresolved entries", () => {
    const results = resolveSlackAllowlistEntries({
      entries: ["id:1", "name:beta", "missing"],
      lookup: [
        { id: "1", name: "alpha" },
        { id: "2", name: "beta" },
      ],
      parseInput: (input) => {
        if (input.startsWith("id:")) {
          return { id: input.slice("id:".length) };
        }
        if (input.startsWith("name:")) {
          return { name: input.slice("name:".length) };
        }
        return {};
      },
      findById: (lookup, id) => lookup.find((entry) => entry.id === id),
      buildIdResolved: ({ input, match }) => ({ input, resolved: true, name: match?.name }),
      resolveNonId: ({ input, parsed, lookup }) => {
        const name = (parsed as { name?: string }).name;
        if (!name) {
          return undefined;
        }
        const match = lookup.find((entry) => entry.name === name);
        return match ? { input, resolved: true, name: match.name } : undefined;
      },
      buildUnresolved: (input) => ({ input, resolved: false }),
    });

    expect(results).toEqual([
      { input: "id:1", resolved: true, name: "alpha" },
      { input: "name:beta", resolved: true, name: "beta" },
      { input: "missing", resolved: false },
    ]);
  });
});

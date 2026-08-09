import { describe, expect, it } from "vitest";
import { resolveDirectoryAllowlistEntries } from "./directory-runtime.js";

describe("directory runtime helpers", () => {
  it("resolves id, provider-specific, and unresolved entries", () => {
    expect(
      resolveDirectoryAllowlistEntries({
        entries: ["id:1", "name:beta", "missing"],
        lookup: [
          { id: "1", name: "alpha" },
          { id: "2", name: "beta" },
        ],
        parseInput: (input) =>
          input.startsWith("id:")
            ? { id: input.slice(3) }
            : input.startsWith("name:")
              ? { name: input.slice(5) }
              : {},
        findById: (lookup, id) => lookup.find((entry) => entry.id === id),
        buildIdResolved: ({ input, match }) => ({ input, resolved: true, name: match?.name }),
        resolveNonId: ({ input, parsed, lookup }) => {
          const name = (parsed as { name?: string }).name;
          const match = name ? lookup.find((entry) => entry.name === name) : undefined;
          return match ? { input, resolved: true, name: match.name } : undefined;
        },
        buildUnresolved: (input) => ({ input, resolved: false }),
      }),
    ).toEqual([
      { input: "id:1", resolved: true, name: "alpha" },
      { input: "name:beta", resolved: true, name: "beta" },
      { input: "missing", resolved: false },
    ]);
  });
});

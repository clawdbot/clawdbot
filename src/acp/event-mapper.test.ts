import { describe, expect, it } from "vitest";
import { extractToolCallLocations } from "./event-mapper.js";

describe("extractToolCallLocations", () => {
  it("enforces the global node visit cap across nested structures", () => {
    const nested = Array.from({ length: 20 }, (_, outer) =>
      Array.from({ length: 20 }, (_, inner) =>
        inner === 19 ? { path: `/tmp/file-${outer}.txt` } : { note: `${outer}-${inner}` },
      ),
    );

    const locations = extractToolCallLocations(nested);

    if (locations === undefined) {
      throw new Error("expected bounded tool-call locations");
    }
    expect(locations).toEqual([{ path: "/tmp/file-0.txt" }, { path: "/tmp/file-1.txt" }]);
  });
});

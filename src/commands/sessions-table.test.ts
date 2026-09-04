// Sessions table tests cover shared display-label formatting.
import { describe, expect, it } from "vitest";
import { formatSessionKeyCell } from "./sessions-table.js";

describe("formatSessionKeyCell", () => {
  it.each(["😀", "👩‍💻", "e\u0301"])(
    "keeps complete %s clusters at both summary boundaries",
    (cluster) => {
      const key = `${"a".repeat(15)}${cluster}middle${cluster}${"z".repeat(5)}`;

      const rendered = formatSessionKeyCell(key, false);

      expect(rendered).toBe(`${"a".repeat(15)}${cluster}...${cluster}${"z".repeat(5)}`);
    },
  );
});

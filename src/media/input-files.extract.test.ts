// Regression: input_file callers declare their MIME; a cosmetic filename must
// not reroute classification past an operator-configured allowlist.
import { describe, expect, it } from "vitest";
import { extractFileContentFromSource, resolveInputFileLimits } from "./input-files.js";

describe("extractFileContentFromSource", () => {
  it("keeps the declared MIME when the filename suggests plain text", async () => {
    const payload = JSON.stringify({ report: "q3", revenue: 12345 });
    const limits = resolveInputFileLimits({ allowedMimes: ["application/json"] });

    const result = await extractFileContentFromSource({
      source: {
        type: "base64",
        data: Buffer.from(payload, "utf8").toString("base64"),
        mediaType: "application/json",
        filename: "notes.txt",
      },
      limits,
    });

    expect(result.text).toContain('"revenue"');
  });
});

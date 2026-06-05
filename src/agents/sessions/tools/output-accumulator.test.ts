// OutputAccumulator tests cover spill-file permissions for truncated command
// output kept outside the model-visible response.
import { rm, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { OutputAccumulator } from "./output-accumulator.js";

describe("OutputAccumulator", () => {
  it("stores spilled full output in an owner-only temp file", async () => {
    const accumulator = new OutputAccumulator({
      maxBytes: 8,
      maxLines: 10,
      tempFilePrefix: "openclaw-output-test",
    });

    accumulator.append(Buffer.from("secret output"));
    accumulator.finish();
    const snapshot = accumulator.snapshot({ persistIfTruncated: true });
    await accumulator.closeTempFile();

    expect(snapshot.fullOutputPath).toBeDefined();
    // Spilled output can include command secrets, so temp files must be
    // owner-only even though their path is returned to the local operator.
    const mode = (await stat(snapshot.fullOutputPath!)).mode & 0o777;
    expect(mode & 0o077).toBe(0);
    await rm(snapshot.fullOutputPath!, { force: true });
  });
});

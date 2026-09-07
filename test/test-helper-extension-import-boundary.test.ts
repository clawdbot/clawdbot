// Test helper extension boundary tests enforce helper import boundaries.
import { describe, expect, it } from "vitest";
import { main } from "../scripts/check-test-helper-extension-import-boundary.mts";
import { createCapturedIo } from "./helpers/captured-io.js";

describe("test-helper extension import boundary inventory", () => {
  it("script json output stays empty", async () => {
    const captured = createCapturedIo();
    const exitCode = await main(["--json"], captured.io);

    expect(exitCode).toBe(0);
    expect(captured.readStderr()).toBe("");
    expect(JSON.parse(captured.readStdout())).toStrictEqual([]);
  });
});

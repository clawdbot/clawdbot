import { describe, expect, it } from "vitest";
import {
  collectTestHelperExtensionImportBoundaryInventory,
  main,
} from "../scripts/check-test-helper-extension-import-boundary.mjs";
import { createCapturedIo } from "./helpers/captured-io.js";

describe("test-helper extension import boundary inventory", () => {
  it("stays empty", async () => {
    expect(await collectTestHelperExtensionImportBoundaryInventory()).toEqual([]);
  });

  it("script json output stays empty", async () => {
    const captured = createCapturedIo();
    const exitCode = await main(["--json"], captured.io);

    expect(exitCode).toBe(0);
    expect(captured.readStderr()).toBe("");
    expect(JSON.parse(captured.readStdout())).toEqual([]);
  });
});

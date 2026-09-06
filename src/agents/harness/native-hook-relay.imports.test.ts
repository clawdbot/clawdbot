import { describe, expect, it } from "vitest";
import { findSourceImportBackedges } from "../../../test/helpers/source-import-closure.js";

describe("native hook relay registration imports", () => {
  it("retains existing policy without importing the host capability constructor", () => {
    expect(
      findSourceImportBackedges("src/agents/harness/native-hook-relay.ts", [
        "src/agents/harness/host-capability.ts",
      ]),
    ).toEqual([]);
  });
});

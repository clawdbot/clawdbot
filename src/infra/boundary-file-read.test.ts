import * as upstream from "@openclaw/fs-safe/advanced";
import { describe, expect, it } from "vitest";
import * as shim from "./boundary-file-read.js";

describe("root file open shim", () => {
  it("re-exports the fs-safe root file helpers", () => {
    expect(shim.canUseRootFileOpen).toBe(upstream.canUseRootFileOpen);
    expect(shim.matchRootFileOpenFailure).toBe(upstream.matchRootFileOpenFailure);
    expect(shim.openRootFile).toBe(upstream.openRootFile);
    expect(shim.openRootFileSync).toBe(upstream.openRootFileSync);
  });
});

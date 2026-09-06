import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const injectHelperScript = resolve(import.meta.dirname, "../scripts/inject-helper.sh");

describe("FaceTime helper injection", () => {
  it("casts dynamic-loader results for LLDB's fallback expression parser", async () => {
    const source = await readFile(injectHelperScript, "utf8");

    expect(source).toContain('(void *)dlopen(\\"${dylib}\\", 2)');
    expect(source).toContain('(int *)(void *)dlsym(h, \\"OpenClawFaceTimeHelperInitialized\\")');
  });
});

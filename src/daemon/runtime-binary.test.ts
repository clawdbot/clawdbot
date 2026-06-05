// Daemon runtime binary tests cover runtime executable resolution.
import { describe, expect, it } from "vitest";
import { isBunRuntime, isNodeRuntime } from "./runtime-binary.js";

describe("isNodeRuntime", () => {
  it("recognizes standard node binaries", () => {
    expect(isNodeRuntime("/usr/bin/node")).toBe(true);
    expect(isNodeRuntime("C:\\Program Files\\nodejs\\node.exe")).toBe(true);
    expect(isNodeRuntime("/usr/bin/nodejs")).toBe(true);
    expect(isNodeRuntime("C:\\nodejs.exe")).toBe(true);
  });

  it("recognizes versioned node binaries with and without dashes", () => {
    expect(isNodeRuntime("/usr/bin/node24")).toBe(true);
    expect(isNodeRuntime("/usr/bin/node-24")).toBe(true);
    expect(isNodeRuntime("/usr/bin/node24.1")).toBe(true);
    expect(isNodeRuntime("/usr/bin/node-24.1")).toBe(true);
    expect(isNodeRuntime("C:\\node24.exe")).toBe(true);
    expect(isNodeRuntime("C:\\node-24.exe")).toBe(true);
  });

  it("handles quotes and casing", () => {
    expect(isNodeRuntime('"/usr/bin/node24"')).toBe(true);
    expect(isNodeRuntime("'C:\\Program Files\\nodejs\\NODE.EXE'")).toBe(true);
  });

  it("rejects non-node runtimes", () => {
    expect(isNodeRuntime("/usr/bin/bun")).toBe(false);
    expect(isNodeRuntime("/usr/bin/node-dev")).toBe(false);
    expect(isNodeRuntime("/usr/bin/nodeenv")).toBe(false);
    expect(isNodeRuntime("/usr/bin/nodemon")).toBe(false);
  });
});

describe("isBunRuntime", () => {
  it("recognizes bun binaries", () => {
    expect(isBunRuntime("/usr/bin/bun")).toBe(true);
    expect(isBunRuntime("C:\\BUN.EXE")).toBe(true);
    expect(isBunRuntime('"/opt/homebrew/bin/bun"')).toBe(true);
  });

  it("rejects non-bun runtimes", () => {
    expect(isBunRuntime("/usr/bin/node")).toBe(false);
    expect(isBunRuntime("/usr/bin/bunx")).toBe(false);
  });
});

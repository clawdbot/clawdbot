// Covers the bounded structural walk in config include resolution.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfigIncludes, type IncludeResolver } from "./includes.js";

const ROOT_DIR = path.parse(process.cwd()).root;
const DEFAULT_BASE_PATH = path.join(ROOT_DIR, "config", "openclaw.json");

function createMockResolver(files: Record<string, unknown> = {}): IncludeResolver {
  return {
    readFile: (filePath: string) => {
      if (filePath in files) {
        return JSON.stringify(files[filePath]);
      }
      throw new Error(`ENOENT: no such file: ${filePath}`);
    },
    parseJson: JSON.parse,
  };
}

function resolve(obj: unknown, files: Record<string, unknown> = {}, basePath = DEFAULT_BASE_PATH) {
  return resolveConfigIncludes(obj, basePath, createMockResolver(files));
}

function buildDeepValue(depth: number): unknown {
  let value: unknown = 0;
  for (let i = 0; i < depth; i += 1) {
    value = [value];
  }
  return value;
}

describe("include resolution nesting depth guard", () => {
  it("rejects deeply-nested config structures instead of recursing without bound", () => {
    const deep = buildDeepValue(600);
    let thrown: unknown;
    try {
      resolve(deep);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("ConfigNestingDepthError");
    expect((thrown as Error).message).toContain("nesting depth");
  });

  it("resolves includes through structures within the supported depth", () => {
    const supported = buildDeepValue(100);
    expect(resolve(supported)).toEqual(supported);
  });

  it("rejects a deeply-nested include file before parsing instead of overflowing", () => {
    const deepRaw = "[".repeat(600) + "]".repeat(600);
    let thrown: unknown;
    try {
      resolveConfigIncludes({ $include: "./deep.json" }, DEFAULT_BASE_PATH, {
        readFile: () => deepRaw,
        parseJson: JSON.parse,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/Failed to parse include file/);
  });

  it("carries structural depth across an include chain instead of resetting per file", () => {
    // Each file stays well within the 512-level contract on its own, but the
    // chain must accumulate: the depth counter has to survive the new
    // processor created per included file, or a chain of in-limit files can
    // stack thousands of recursive frames and bypass the intended bound.
    const configDir = path.dirname(DEFAULT_BASE_PATH);
    const files: Record<string, unknown> = {};
    const chainLength = 6;
    const perFileNesting = 100;
    for (let i = 0; i < chainLength; i += 1) {
      let value: unknown = 0;
      if (i + 1 < chainLength) {
        value = { $include: `./chain-${i + 1}.json` };
      }
      for (let d = 0; d < perFileNesting; d += 1) {
        value = [value];
      }
      files[path.normalize(path.resolve(configDir, `chain-${i}.json`))] = value;
    }
    let thrown: unknown;
    try {
      resolve({ $include: "./chain-0.json" }, files);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("ConfigNestingDepthError");
    expect((thrown as Error).message).toContain("nesting depth");
  });

  it("accepts an include chain that stays within the cumulative depth contract", () => {
    const configDir = path.dirname(DEFAULT_BASE_PATH);
    const files: Record<string, unknown> = {};
    const chainLength = 4;
    const perFileNesting = 100;
    for (let i = 0; i < chainLength; i += 1) {
      let value: unknown = 0;
      if (i + 1 < chainLength) {
        value = { $include: `./chain-${i + 1}.json` };
      }
      for (let d = 0; d < perFileNesting; d += 1) {
        value = [value];
      }
      files[path.normalize(path.resolve(configDir, `chain-${i}.json`))] = value;
    }
    expect(resolve({ $include: "./chain-0.json" }, files)).toEqual(
      buildDeepValue(chainLength * perFileNesting),
    );
  });
});

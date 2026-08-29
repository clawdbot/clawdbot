import { describe, expect, it } from "vitest";
import { resolveCoreToolFactoryFamily } from "./core-tool-factory-descriptors.js";

describe("core tool factory descriptors", () => {
  it.each(["read", "grep", "find", "ls", "write", "edit"])(
    "classifies %s as a base coding tool",
    (name) => {
      expect(resolveCoreToolFactoryFamily(name)).toBe("base-coding");
    },
  );
});

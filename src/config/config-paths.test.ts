import { describe, expect, it, vi } from "vitest";
import {
  getConfigValueAtPath,
  setConfigValueAtPath,
  unsetConfigValueAtPath,
} from "./config-paths.js";

describe("config path own-property traversal", () => {
  for (const key of ["toString", "valueOf", "hasOwnProperty"]) {
    it(`does not treat inherited ${key} as config`, () => {
      const parent: Record<string, unknown> = {};
      const root: Record<string, unknown> = { parent };

      expect(getConfigValueAtPath(root, ["parent", key])).toBeUndefined();
      expect(unsetConfigValueAtPath(root, ["parent", key])).toBe(false);
      expect(root).toEqual({ parent: {} });

      setConfigValueAtPath(root, ["parent", key], "own");
      expect(Object.hasOwn(parent, key)).toBe(true);
      expect(getConfigValueAtPath(root, ["parent", key])).toBe("own");
      expect(unsetConfigValueAtPath(root, ["parent", key])).toBe(true);
      expect(root).toEqual({});
    });
  }

  it("replaces an inherited parent instead of traversing it", () => {
    const prototypeBranch = { leaf: "prototype" };
    const root = Object.create({ branch: prototypeBranch }) as Record<string, unknown>;

    expect(getConfigValueAtPath(root, ["branch", "leaf"])).toBeUndefined();
    expect(unsetConfigValueAtPath(root, ["branch", "leaf"])).toBe(false);
    expect(prototypeBranch).toEqual({ leaf: "prototype" });

    setConfigValueAtPath(root, ["branch", "leaf"], "own");
    expect(Object.hasOwn(root, "branch")).toBe(true);
    expect(root.branch).toEqual({ leaf: "own" });
    expect(prototypeBranch).toEqual({ leaf: "prototype" });

    expect(unsetConfigValueAtPath(root, ["branch", "leaf"])).toBe(true);
    expect(Object.hasOwn(root, "branch")).toBe(false);
    expect(getConfigValueAtPath(root, ["branch", "leaf"])).toBeUndefined();
    expect(prototypeBranch).toEqual({ leaf: "prototype" });
  });

  for (const inheritedKind of ["setter", "non-writable"] as const) {
    it(`creates an own parent over an inherited ${inheritedKind} property`, () => {
      const setter = vi.fn();
      const prototype = {};
      Object.defineProperty(
        prototype,
        "branch",
        inheritedKind === "setter"
          ? { configurable: true, set: setter }
          : { configurable: true, value: { leaf: "prototype" }, writable: false },
      );
      const root = Object.create(prototype) as Record<string, unknown>;

      expect(() => setConfigValueAtPath(root, ["branch", "leaf"], "own")).not.toThrow();
      expect(setter).not.toHaveBeenCalled();
      expect(Object.getOwnPropertyDescriptor(root, "branch")).toMatchObject({
        configurable: true,
        enumerable: true,
        value: { leaf: "own" },
        writable: true,
      });
    });

    it(`creates an own leaf over an inherited ${inheritedKind} property`, () => {
      const setter = vi.fn();
      const prototype = {};
      Object.defineProperty(
        prototype,
        "leaf",
        inheritedKind === "setter"
          ? { configurable: true, set: setter }
          : { configurable: true, value: "prototype", writable: false },
      );
      const parent = Object.create(prototype) as Record<string, unknown>;
      const root = { parent };

      expect(() => setConfigValueAtPath(root, ["parent", "leaf"], "own")).not.toThrow();
      expect(setter).not.toHaveBeenCalled();
      expect(Object.getOwnPropertyDescriptor(parent, "leaf")).toMatchObject({
        configurable: true,
        enumerable: true,
        value: "own",
        writable: true,
      });
    });
  }
});

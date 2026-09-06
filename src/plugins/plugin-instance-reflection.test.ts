import { runInNewContext, runInThisContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { PluginInstance } from "./plugin-instance.js";

const cases = (["host", "VM"] as const).flatMap((realm) =>
  (["object", "function", "array"] as const).map((kind) => ({ realm, kind })),
);

function createSource(realm: "host" | "VM", kind: "object" | "function" | "array"): object {
  const expression = kind === "object" ? "{}" : kind === "array" ? "[]" : "function exported() {}";
  const source = `Object.defineProperty(Object.assign(${expression}, { execute() { return "current"; } }), "reader", { configurable: true, get() { return this.execute; } })`;
  return realm === "VM" ? runInNewContext(source) : runInThisContext(source);
}

describe("managed plugin reflection", () => {
  it.each(cases)("defines fixed data on $realm $kind views atomically", async ({ realm, kind }) => {
    const instance = new PluginInstance("fixed-data");
    const source = createSource(realm, kind);
    const view = instance.wrap(source);
    try {
      const descriptor = { value: 1, configurable: false, writable: false, enumerable: true };
      expect(Reflect.defineProperty(view, "fixed", descriptor)).toBe(true);
      expect(Object.getOwnPropertyDescriptor(source, "fixed")).toEqual(descriptor);
      expect(Object.getOwnPropertyDescriptor(view, "fixed")).toEqual(descriptor);
      expect(Reflect.get(view, "fixed")).toBe(1);
      expect(Object.keys(view)).toContain("fixed");
      expect(Reflect.set(view, "fixed", 2)).toBe(false);
      expect(Reflect.deleteProperty(view, "fixed")).toBe(false);
      expect(Reflect.defineProperty(view, "fixed", { value: 2 })).toBe(false);
      expect(Reflect.get(source, "fixed")).toBe(1);
      await instance.dispose();
      expect(() => Reflect.defineProperty(view, "late", { value: 2 })).toThrow(
        "reloaded or disabled",
      );
      expect(Object.hasOwn(source, "late")).toBe(false);
    } finally {
      await instance.dispose();
    }
  });

  it.each(cases)(
    "keeps existing $realm $kind methods fenced when made fixed",
    async ({ realm, kind }) => {
      const instance = new PluginInstance("fixed-method");
      const source = createSource(realm, kind);
      const view = instance.wrap(source);
      try {
        const execute = Reflect.get(view, "execute");
        expect(
          Reflect.defineProperty(view, "execute", { configurable: false, writable: false }),
        ).toBe(true);
        const descriptor = Object.getOwnPropertyDescriptor(view, "execute");
        expect(descriptor).toMatchObject({ configurable: false, writable: false, value: execute });
        expect(Reflect.get(view, "execute")).toBe(execute);
        expect(Reflect.apply(execute, view, [])).toBe("current");
        await instance.dispose();
        expect(() => Reflect.apply(execute, view, [])).toThrow("reloaded or disabled");
        expect(() => Reflect.apply(Reflect.get(view, "execute"), view, [])).toThrow(
          "reloaded or disabled",
        );
      } finally {
        await instance.dispose();
      }
    },
  );

  it.each(cases)(
    "keeps existing $realm $kind accessors fenced when made fixed",
    async ({ realm, kind }) => {
      const instance = new PluginInstance("fixed-accessor");
      const view = instance.wrap(createSource(realm, kind));
      try {
        expect(Reflect.defineProperty(view, "reader", { configurable: false })).toBe(true);
        const descriptor = Object.getOwnPropertyDescriptor(view, "reader")!;
        expect(descriptor.configurable).toBe(false);
        const execute = descriptor.get!.call(view);
        expect(Reflect.apply(execute, view, [])).toBe("current");
        await instance.dispose();
        expect(() => descriptor.get!.call(view)).toThrow("reloaded or disabled");
        expect(() => Reflect.get(view, "reader")).toThrow("reloaded or disabled");
        expect(() => Reflect.apply(execute, view, [])).toThrow("reloaded or disabled");
      } finally {
        await instance.dispose();
      }
    },
  );

  it.each(["value", "get"] as const)("preserves caller-owned fixed %s identity", async (field) => {
    const instance = new PluginInstance("caller-descriptor");
    const view = instance.wrap({ execute() {} });
    const supplied = () => "caller";
    try {
      expect(
        Reflect.defineProperty(view, "caller", { [field]: supplied, configurable: false }),
      ).toBe(true);
      const descriptor = Object.getOwnPropertyDescriptor(view, "caller")!;
      expect(descriptor[field]).toBe(supplied);
      expect(Reflect.get(view, "caller")).toBe(field === "value" ? supplied : "caller");
      await instance.dispose();
      // Caller-owned code does not acquire plugin ownership through a fixed descriptor.
      expect(Reflect.apply(descriptor[field], view, [])).toBe("caller");
    } finally {
      await instance.dispose();
    }
  });

  it.each([Object.preventExtensions, Object.seal, Object.freeze])(
    "rejects %s before changing either object's extensibility",
    async (operation) => {
      const instance = new PluginInstance("extensibility");
      const source = {
        execute() {
          return "current";
        },
      };
      const view = instance.wrap(source);
      try {
        expect(() => operation(view)).toThrow(TypeError);
        expect(Object.isExtensible(view)).toBe(true);
        expect(Object.isExtensible(source)).toBe(true);
        expect(Reflect.defineProperty(view, "next", { value: 2, configurable: true })).toBe(true);
        expect(Reflect.get(source, "next")).toBe(2);
        expect(view.execute()).toBe("current");
      } finally {
        await instance.dispose();
      }
    },
  );
  it("applies native descriptor transitions without partially committing an invalid request", async () => {
    const instance = new PluginInstance("descriptor-transition");
    const source = { execute() {}, mutable: 1 };
    const view = instance.wrap(source);
    try {
      const getter = () => 2;
      expect(Reflect.defineProperty(view, "mutable", { get: getter, configurable: false })).toBe(
        true,
      );
      expect(Object.getOwnPropertyDescriptor(view, "mutable")).toEqual({
        get: getter,
        set: undefined,
        configurable: false,
        enumerable: true,
      });
      expect(Reflect.get(view, "mutable")).toBe(2);
      expect(Reflect.defineProperty(view, "mutable", { value: 3 })).toBe(false);
      expect(Object.getOwnPropertyDescriptor(source, "mutable")).toMatchObject({ get: getter });
    } finally {
      await instance.dispose();
    }
  });
});

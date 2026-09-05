import { runInNewContext, runInThisContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { PluginInstance } from "./plugin-instance.js";

// oxlint-disable typescript/unbound-method -- Retaining methods and supplying their receiver later is the lifecycle behavior under test.

interface BaseInstance {
  basePublic: string;
  baseLabel: string;
  readBase(): string;
}
interface BaseConstructor {
  new (): BaseInstance;
  prototype: BaseInstance;
}

function createBase(kind: "class" | "function", realm: "host" | "VM"): BaseConstructor {
  const source =
    kind === "class"
      ? `(class Base {
    basePublic = "base";
    #value = "base private";
    readBase() { return this.#value; }
    get baseLabel() { return this.#value; }
    set baseLabel(value) { this.#value = value; }
  })`
      : `(() => {
    const values = new WeakMap();
    function Base() { this.basePublic = "base"; values.set(this, "base private"); }
    Object.defineProperties(Base.prototype, {
      readBase: { configurable: true, value() { return values.get(this); } },
      baseLabel: { configurable: true,
        get() { return values.get(this); },
        set(value) { values.set(this, value); }
      }
    });
    return Base;
  })()`;
  return realm === "VM" ? runInNewContext(source) : runInThisContext(source);
}

const constructorCases = (["host", "VM"] as const).flatMap((realm) =>
  (["class", "function"] as const).map((kind) => ({ realm, kind })),
);

describe("managed exported constructors", () => {
  it.each(
    constructorCases.flatMap(({ realm, kind }) =>
      (["prototype", "capability"] as const).map((key) => ({ realm, kind, key })),
    ),
  )("preserves $realm $kind $key membership", async ({ realm, kind, key }) => {
    const instance = new PluginInstance("constructor-membership");
    const source = Object.assign(createBase(kind, realm), { capability: true });
    try {
      const wrapped = instance.wrap(source);
      expect(wrapped.capability).toBe(true);
      expect(Object.hasOwn(wrapped, key)).toBe(true);
      expect("bind" in wrapped).toBe(true);
      expect("missing" in wrapped).toBe(false);
      expect(key in wrapped).toBe(true);
    } finally {
      await instance.dispose();
    }
  });

  it("reads a custom prototype accessor only when requested", async () => {
    const instance = new PluginInstance("prototype-accessor");
    let reads = 0;
    const source = () => "call";
    Object.defineProperty(source, "prototype", { get: () => ({ value: ++reads }) });
    try {
      const wrapped = instance.wrap(source);
      expect(reads).toBe(0);
      expect(Reflect.get(wrapped, "prototype")).toEqual({ value: 1 });
      await instance.dispose();
      expect(() => Reflect.get(wrapped, "prototype")).toThrow("reloaded or disabled");
      expect(reads).toBe(1);
    } finally {
      await instance.dispose();
    }
  });

  it.each(
    constructorCases.flatMap(({ realm, kind }) =>
      (["public", "private", "super"] as const).map((fields) => ({ realm, kind, fields })),
    ),
  )("preserves $realm $kind derived $fields fields", async ({ realm, kind, fields }) => {
    const instance = new PluginInstance("derived-constructor");
    const Base = createBase(kind, realm);
    const WrappedBase = instance.wrap(Base);
    class Derived extends WrappedBase {
      derivedPublic = "derived";
      #value = "derived private";
      readDerived() {
        return this.#value;
      }
      get derivedLabel() {
        return this.#value;
      }
      set derivedLabel(value: string) {
        this.#value = value;
      }
      readSuper() {
        return `${super.readBase()}/${super.baseLabel}/${this.#value}`;
      }
    }
    try {
      const base = new WrappedBase();
      expect(base).toBeInstanceOf(Base);
      expect(base).toBeInstanceOf(WrappedBase);
      expect(base.basePublic).toBe("base");
      expect(base.readBase()).toBe("base private");
      const derived = new Derived();
      expect(derived).toBeInstanceOf(Derived);
      expect(derived).toBeInstanceOf(WrappedBase);
      expect(derived).toBeInstanceOf(Base);
      expect(derived.basePublic).toBe("base");
      if (fields === "public") {
        expect(derived.derivedPublic).toBe("derived");
        expect(Object.keys(derived)).toEqual(
          expect.arrayContaining(["basePublic", "derivedPublic"]),
        );
        expect(Object.getOwnPropertyDescriptor(derived, "derivedPublic")?.value).toBe("derived");
      } else if (fields === "private") {
        expect(derived.readBase()).toBe("base private");
        expect(derived.readDerived()).toBe("derived private");
        expect(derived.derivedLabel).toBe("derived private");
        derived.baseLabel = "changed base";
        derived.derivedLabel = "changed derived";
        expect(derived.readBase()).toBe("changed base");
        expect(derived.readDerived()).toBe("changed derived");
      } else {
        expect(derived.readSuper()).toBe("base private/base private/derived private");
      }
    } finally {
      await instance.dispose();
    }
  });

  it.each(
    constructorCases.flatMap(({ realm, kind }) =>
      (["constructor", "method", "receiver"] as const).map((member) => ({ realm, kind, member })),
    ),
  )("owns the $realm $kind prototype $member", async ({ realm, kind, member }) => {
    const instance = new PluginInstance("prototype-constructor");
    const Base = createBase(kind, realm);
    const WrappedBase = instance.wrap(Base);
    const Constructor: BaseConstructor = Reflect.get(WrappedBase.prototype, "constructor");
    const method = WrappedBase.prototype.readBase;
    const receiver = member === "receiver" ? new WrappedBase() : new Base();
    try {
      expect(new Constructor().basePublic).toBe("base");
      expect(Reflect.apply(method, receiver, [])).toBe("base private");
      await instance.dispose();
      if (member === "constructor") {
        expect(() => new Constructor()).toThrow("reloaded or disabled");
      } else {
        expect(() => Reflect.apply(method, receiver, [])).toThrow("reloaded or disabled");
      }
    } finally {
      await instance.dispose();
    }
  });
});

describe("managed constructor receiver layers", () => {
  it.each(
    constructorCases.flatMap(({ realm, kind }) =>
      (["method", "getter"] as const).map((member) => ({ realm, kind, member })),
    ),
  )(
    "preserves a nested $realm $kind prototype $member receiver",
    async ({ realm, kind, member }) => {
      const instance = new PluginInstance("nested-constructors");
      const Base = createBase(kind, realm);
      const WrappedBase = instance.wrap(Base);
      class Middle extends WrappedBase {
        #value = "middle private";
        readMiddle() {
          return this.#value;
        }
        get middleLabel() {
          return this.#value;
        }
      }
      const WrappedMiddle = instance.wrap(Middle);
      try {
        const value = new WrappedMiddle();
        expect(value).toBeInstanceOf(Base);
        expect(value).toBeInstanceOf(Middle);
        expect(value).toBeInstanceOf(WrappedMiddle);
        expect(value.readBase()).toBe("base private");
        const read =
          member === "method"
            ? WrappedMiddle.prototype.readMiddle
            : Object.getOwnPropertyDescriptor(WrappedMiddle.prototype, "middleLabel")!.get!;
        expect(Reflect.apply(read, value, [])).toBe("middle private");
        await instance.dispose();
        expect(() => Reflect.apply(read, value, [])).toThrow("reloaded or disabled");
      } finally {
        await instance.dispose();
      }
    },
  );

  it.each(
    (["host", "VM"] as const).flatMap((realm) =>
      (["field", "assignment"] as const).map((form) => ({ realm, form })),
    ),
  )("preserves $realm base and derived own callable $form receivers", async ({ realm, form }) => {
    const source = `(class Base {
      #value = "base own";
      ${
        form === "field"
          ? "baseOwn = function() { return this.#value; };"
          : "constructor() { this.baseOwn = function() { return this.#value; }; }"
      }
    })`;
    const Base: new () => { baseOwn(): string } =
      realm === "VM" ? runInNewContext(source) : runInThisContext(source);
    const instance = new PluginInstance("own-constructor-fields");
    const WrappedBase = instance.wrap(Base);
    class DerivedFields extends WrappedBase {
      #value = "derived own";
      derivedOwn = function (this: DerivedFields) {
        return this.#value;
      };
    }
    class DerivedAssignment extends WrappedBase {
      #value = "derived own";
      declare derivedOwn: () => string;
      constructor() {
        super();
        this.derivedOwn = function (this: DerivedAssignment) {
          return this.#value;
        };
      }
    }
    try {
      const value = form === "field" ? new DerivedFields() : new DerivedAssignment();
      const baseOwn = value.baseOwn;
      const derivedOwn = value.derivedOwn;
      expect(baseOwn()).toBe("base own");
      expect(Reflect.apply(derivedOwn, undefined, [])).toBe("derived own");
      await instance.dispose();
      expect(() => baseOwn()).toThrow("reloaded or disabled");
      expect(() => Reflect.apply(derivedOwn, undefined, [])).toThrow("reloaded or disabled");
    } finally {
      await instance.dispose();
    }
  });
});

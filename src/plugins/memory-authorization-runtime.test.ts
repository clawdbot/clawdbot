import { describe, expect, it, vi } from "vitest";
import { referenceMemoryAuthorizationConformanceAdapter } from "../plugin-sdk/memory-authorization-conformance.js";
import {
  COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
  LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
  MEMORY_AUTHORIZATION_CAPABILITY_NAMES,
} from "../plugin-sdk/memory-authorization.js";
import {
  admitMemoryAuthorizationReadRuntime,
  inspectMemoryAuthorizationCapability,
} from "./memory-authorization-runtime.js";
import { observeMemoryAuthorizationShadowSurface } from "./memory-authorization-shadow.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

const AUTHORIZED_METHOD_NAMES = [
  "authorize",
  "searchAuthorized",
  "readAuthorized",
  "writeAuthorized",
  "importAuthorized",
  "syncAuthorized",
  "exportAuthorized",
  "statusAuthorized",
] as const;

function createRuntime() {
  const notCalled = vi.fn(() => {
    throw new Error("runtime methods must not execute in shadow mode");
  });
  return {
    authorize: notCalled,
    searchAuthorized: notCalled,
    readAuthorized: notCalled,
    writeAuthorized: notCalled,
    importAuthorized: notCalled,
    syncAuthorized: notCalled,
    exportAuthorized: notCalled,
    statusAuthorized: notCalled,
    legacyManager: { search: notCalled },
  };
}

class PrototypeRuntime {
  authorize() {
    throw new Error("runtime methods must not execute in shadow mode");
  }

  searchAuthorized() {
    throw new Error("runtime methods must not execute in shadow mode");
  }

  readAuthorized() {
    throw new Error("runtime methods must not execute in shadow mode");
  }

  writeAuthorized() {
    throw new Error("runtime methods must not execute in shadow mode");
  }

  importAuthorized() {
    throw new Error("runtime methods must not execute in shadow mode");
  }

  syncAuthorized() {
    throw new Error("runtime methods must not execute in shadow mode");
  }

  exportAuthorized() {
    throw new Error("runtime methods must not execute in shadow mode");
  }

  statusAuthorized() {
    throw new Error("runtime methods must not execute in shadow mode");
  }
}

class PrototypeCapability {
  readonly authorization = COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES;
  readonly runtime = new PrototypeRuntime();
}

describe("memory authorization capability inspection", () => {
  it("reports a complete declared surface without calling an authorized or legacy method", () => {
    const runtime = createRuntime();
    const inspection = inspectMemoryAuthorizationCapability({
      authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
      runtime,
    });

    expect(inspection).toMatchObject({
      version: 1,
      capabilityDeclaration: "complete",
      declaredCapabilityCount: MEMORY_AUTHORIZATION_CAPABILITY_NAMES.length,
      implementedMethodCount: AUTHORIZED_METHOD_NAMES.length,
      surfaceComplete: true,
      reasonCode: "surface-complete",
    });
    expect(inspection.missingCapabilities).toEqual([]);
    expect(inspection.missingMethods).toEqual([]);
    expect(Object.isFrozen(inspection)).toBe(true);
    expect(Object.isFrozen(inspection.missingMethods)).toBe(true);
    expect(runtime.authorize).not.toHaveBeenCalled();
    expect(runtime.legacyManager.search).not.toHaveBeenCalled();
  });

  it("fails closed for an enforced nonconforming alternate without calling legacy search", async () => {
    const legacySearch = vi.fn();
    const rejected = await admitMemoryAuthorizationReadRuntime({
      authorization: LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
      authorizationConformance: referenceMemoryAuthorizationConformanceAdapter,
      runtime: { ...createRuntime(), legacySearch },
    });
    expect(rejected).toEqual({ ok: false, reasonCode: "backend-nonconforming" });
    expect(legacySearch).not.toHaveBeenCalled();

    const admitted = await admitMemoryAuthorizationReadRuntime({
      authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
      authorizationConformance: referenceMemoryAuthorizationConformanceAdapter,
      runtime: createRuntime(),
    });
    expect(admitted.ok).toBe(true);
  });

  it("reports all-false and incomplete declarations as nonconforming", () => {
    const legacy = inspectMemoryAuthorizationCapability({
      authorization: LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
      runtime: createRuntime(),
    });
    const incomplete = inspectMemoryAuthorizationCapability({
      authorization: { ...COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES, scopedSync: false },
      runtime: Object.fromEntries(AUTHORIZED_METHOD_NAMES.map((name) => [name, () => undefined])),
    });

    expect(legacy).toMatchObject({
      capabilityDeclaration: "partial",
      declaredCapabilityCount: 0,
      surfaceComplete: false,
      reasonCode: "backend-nonconforming",
    });
    expect(legacy.missingCapabilities).toEqual(MEMORY_AUTHORIZATION_CAPABILITY_NAMES);
    expect(incomplete).toMatchObject({
      capabilityDeclaration: "partial",
      declaredCapabilityCount: MEMORY_AUTHORIZATION_CAPABILITY_NAMES.length - 1,
      surfaceComplete: false,
      reasonCode: "backend-nonconforming",
    });
    expect(incomplete.missingCapabilities).toEqual(["scopedSync"]);
  });

  it("uses the SDK's exact capability-declaration rules for shadow reporting", () => {
    const unexpectedCapability = inspectMemoryAuthorizationCapability({
      authorization: { ...COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES, unexpected: true },
      runtime: createRuntime(),
    });
    const symbolicCapability = inspectMemoryAuthorizationCapability({
      authorization: {
        ...COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
        [Symbol("plugin-framework-metadata")]: true,
      },
      runtime: createRuntime(),
    });

    expect(unexpectedCapability).toMatchObject({
      capabilityDeclaration: "malformed",
      declaredCapabilityCount: 0,
      reasonCode: "backend-nonconforming",
    });
    expect(symbolicCapability).toMatchObject({
      capabilityDeclaration: "malformed",
      declaredCapabilityCount: 0,
      reasonCode: "backend-nonconforming",
    });
  });

  it("accepts data descriptors from class prototypes and ignores unrelated symbols", () => {
    const capability = new PrototypeCapability();
    Object.defineProperty(capability, Symbol("plugin-framework-metadata"), {
      value: "not an authorization capability",
    });

    expect(inspectMemoryAuthorizationCapability(capability)).toMatchObject({
      capabilityDeclaration: "complete",
      implementedMethodCount: AUTHORIZED_METHOD_NAMES.length,
      surfaceComplete: true,
      reasonCode: "surface-complete",
    });
  });

  it("fails closed on accessor and proxy surfaces without evaluating their getters or methods", () => {
    let getterCalls = 0;
    const accessorRuntime = Object.create(null) as Record<string, unknown>;
    for (const name of AUTHORIZED_METHOD_NAMES) {
      Object.defineProperty(accessorRuntime, name, {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error("must not read method getter");
        },
      });
    }
    const accessorCapability = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorCapability, "authorization", {
      enumerable: true,
      value: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
    });
    Object.defineProperty(accessorCapability, "runtime", {
      enumerable: true,
      value: accessorRuntime,
    });
    const capabilityGetter = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(capabilityGetter, "authorization", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("must not read authorization getter");
      },
    });
    Object.defineProperty(capabilityGetter, "runtime", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("must not read runtime getter");
      },
    });
    const proxyCapability = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("hostile proxy");
        },
      },
    );
    const declarationProxyCapability = {
      authorization: new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error("hostile capability declaration");
          },
        },
      ),
      runtime: createRuntime(),
    };

    const accessor = inspectMemoryAuthorizationCapability(accessorCapability);
    const getter = inspectMemoryAuthorizationCapability(capabilityGetter);
    const undefinedDeclaration = inspectMemoryAuthorizationCapability({
      authorization: undefined,
      runtime: createRuntime(),
    });
    const proxy = inspectMemoryAuthorizationCapability(proxyCapability);
    const declarationProxy = inspectMemoryAuthorizationCapability(declarationProxyCapability);

    expect(getterCalls).toBe(0);
    expect(accessor).toMatchObject({
      capabilityDeclaration: "complete",
      reasonCode: "backend-nonconforming",
    });
    expect(getter).toMatchObject({
      capabilityDeclaration: "malformed",
      reasonCode: "backend-nonconforming",
    });
    expect(undefinedDeclaration).toMatchObject({
      capabilityDeclaration: "malformed",
      reasonCode: "backend-nonconforming",
    });
    expect(proxy).toMatchObject({
      capabilityDeclaration: "malformed",
      reasonCode: "backend-nonconforming",
    });
    expect(declarationProxy).toMatchObject({
      capabilityDeclaration: "malformed",
      reasonCode: "backend-nonconforming",
    });
  });
});

describe("memory authorization shadow inspection", () => {
  it("returns one bounded, content-free observation per selected registry", () => {
    const runtime = Object.assign(createRuntime(), {
      content: "private content sentinel",
      prompt: "private prompt sentinel",
      query: "private query sentinel",
      principalId: "private principal sentinel",
    });
    const capability = { authorization: LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES, runtime };
    const registry = createEmptyPluginRegistry();
    const first = observeMemoryAuthorizationShadowSurface({ capability, registry });
    const second = observeMemoryAuthorizationShadowSurface({ capability, registry });

    expect(first).toMatchObject({
      mode: "shadow",
      capabilityDeclaration: "partial",
      reasonCode: "backend-nonconforming",
    });
    expect(second).toBeUndefined();
    expect(JSON.stringify(first)).not.toMatch(/private|content|prompt|query|principal/u);
  });

  it("observes runtime-less selected capabilities without invoking or creating a runtime", () => {
    const observation = observeMemoryAuthorizationShadowSurface({
      capability: { authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES },
      registry: createEmptyPluginRegistry(),
    });

    expect(observation).toEqual(
      expect.objectContaining({
        capabilityDeclaration: "complete",
        implementedMethodCount: 0,
        surfaceComplete: false,
        reasonCode: "backend-nonconforming",
      }),
    );
  });

  it("deduplicates by selected registry rather than a shared runtime object", () => {
    const runtime = createRuntime();
    const first = observeMemoryAuthorizationShadowSurface({
      capability: { authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES, runtime },
      registry: createEmptyPluginRegistry(),
    });
    const second = observeMemoryAuthorizationShadowSurface({
      capability: { authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES, runtime },
      registry: createEmptyPluginRegistry(),
    });

    expect(first).toEqual(expect.objectContaining({ surfaceComplete: true }));
    expect(second).toEqual(expect.objectContaining({ surfaceComplete: true }));
  });

  it("does not let a hostile proxy change a selected capability path", () => {
    const capability = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("hostile proxy");
        },
      },
    );
    const observation = observeMemoryAuthorizationShadowSurface({
      capability,
      registry: createEmptyPluginRegistry(),
    });

    expect(observation).toEqual(
      expect.objectContaining({ reasonCode: "backend-nonconforming", surfaceComplete: false }),
    );
  });
});

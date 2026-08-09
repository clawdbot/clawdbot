import { describe, expect, it, vi } from "vitest";
import {
  COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
  LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
  MEMORY_AUTHORIZATION_CAPABILITY_NAMES,
} from "../memory-host-sdk/host/authorization.js";
import { inspectMemoryAuthorizationRuntime } from "./memory-authorization-runtime.js";
import { observeMemoryAuthorizationShadowSurface } from "./memory-authorization-shadow.js";

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

function createRuntime(capabilities = COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES) {
  const notCalled = vi.fn(() => {
    throw new Error("runtime methods must not execute in shadow mode");
  });
  return {
    authorization: capabilities,
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
  readonly authorization = COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES;

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

describe("memory authorization runtime inspection", () => {
  it("reports a complete declared surface without calling an authorized or legacy method", () => {
    const runtime = createRuntime();
    const inspection = inspectMemoryAuthorizationRuntime(runtime);

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

  it("reports all-false and incomplete declarations as nonconforming", () => {
    const legacy = inspectMemoryAuthorizationRuntime(
      createRuntime(LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES),
    );
    const incomplete = inspectMemoryAuthorizationRuntime({
      authorization: { ...COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES, scopedSync: false },
      ...Object.fromEntries(AUTHORIZED_METHOD_NAMES.map((name) => [name, () => undefined])),
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
    const unexpectedCapability = inspectMemoryAuthorizationRuntime({
      ...createRuntime(),
      authorization: { ...COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES, unexpected: true },
    });
    const symbolicCapability = inspectMemoryAuthorizationRuntime({
      ...createRuntime(),
      authorization: {
        ...COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
        [Symbol("plugin-framework-metadata")]: true,
      },
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
    const runtime = new PrototypeRuntime();
    Object.defineProperty(runtime, Symbol("plugin-framework-metadata"), {
      value: "not an authorization capability",
    });

    expect(inspectMemoryAuthorizationRuntime(runtime)).toMatchObject({
      capabilityDeclaration: "complete",
      implementedMethodCount: AUTHORIZED_METHOD_NAMES.length,
      surfaceComplete: true,
      reasonCode: "surface-complete",
    });
  });

  it("fails closed on accessor and proxy surfaces without evaluating their getters or methods", () => {
    let getterCalls = 0;
    const accessorRuntime = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorRuntime, "authorization", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("must not read authorization getter");
      },
    });
    for (const name of AUTHORIZED_METHOD_NAMES) {
      Object.defineProperty(accessorRuntime, name, {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error("must not read method getter");
        },
      });
    }
    const proxyRuntime = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("hostile proxy");
        },
      },
    );
    const declarationProxyRuntime = {
      authorization: new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error("hostile capability declaration");
          },
        },
      ),
    };

    const accessor = inspectMemoryAuthorizationRuntime(accessorRuntime);
    const undefinedDeclaration = inspectMemoryAuthorizationRuntime({ authorization: undefined });
    const proxy = inspectMemoryAuthorizationRuntime(proxyRuntime);
    const declarationProxy = inspectMemoryAuthorizationRuntime(declarationProxyRuntime);

    expect(getterCalls).toBe(0);
    expect(accessor).toMatchObject({
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
  it("returns one bounded, content-free observation per selected runtime", () => {
    const runtime = Object.assign(createRuntime(LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES), {
      content: "private content sentinel",
      prompt: "private prompt sentinel",
      query: "private query sentinel",
      principalId: "private principal sentinel",
    });
    const first = observeMemoryAuthorizationShadowSurface(runtime);
    const second = observeMemoryAuthorizationShadowSurface(runtime);

    expect(first).toMatchObject({
      mode: "shadow",
      capabilityDeclaration: "partial",
      reasonCode: "backend-nonconforming",
    });
    expect(second).toBeUndefined();
    expect(JSON.stringify(first)).not.toMatch(/private|content|prompt|query|principal/u);
  });

  it("does not let a hostile proxy change a selected runtime path", () => {
    const runtime = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("hostile proxy");
        },
      },
    );
    const observation = observeMemoryAuthorizationShadowSurface(runtime);

    expect(observation).toEqual(
      expect.objectContaining({ reasonCode: "backend-nonconforming", surfaceComplete: false }),
    );
  });
});

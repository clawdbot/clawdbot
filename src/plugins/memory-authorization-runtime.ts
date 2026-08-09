import {
  MEMORY_AUTHORIZATION_CAPABILITY_NAMES,
  isMemoryAuthorizationCapabilities,
  listMissingMemoryAuthorizationCapabilities,
  type AuthorizedMemoryRuntime,
  type MemoryAuthorizationCapabilityName,
} from "../memory-host-sdk/host/authorization.js";

const AUTHORIZED_MEMORY_RUNTIME_METHODS = [
  "authorize",
  "searchAuthorized",
  "readAuthorized",
  "writeAuthorized",
  "importAuthorized",
  "syncAuthorized",
  "exportAuthorized",
  "statusAuthorized",
] as const satisfies readonly (keyof AuthorizedMemoryRuntime)[];

type AuthorizedMemoryRuntimeMethodName = (typeof AUTHORIZED_MEMORY_RUNTIME_METHODS)[number];

export type MemoryAuthorizationRuntimeInspection = Readonly<{
  version: 1;
  capabilityDeclaration: "missing" | "malformed" | "partial" | "complete";
  declaredCapabilityCount: number;
  requiredCapabilityCount: number;
  implementedMethodCount: number;
  requiredMethodCount: number;
  missingCapabilities: readonly MemoryAuthorizationCapabilityName[];
  missingMethods: readonly AuthorizedMemoryRuntimeMethodName[];
  surfaceComplete: boolean;
  reasonCode: "surface-complete" | "backend-nonconforming";
}>;

// Runtime interfaces are shallow; the bound prevents hostile prototype chains from extending a
// shadow-only inspection beyond its fixed metadata budget.
const MAXIMUM_RUNTIME_PROTOTYPE_DEPTH = 8;

function isObjectReference(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

type DataPropertyLookup =
  | { kind: "data"; value: unknown }
  | { kind: "missing" | "accessor" | "unavailable" };

/**
 * Reads a data descriptor without evaluating the corresponding property. Runtime interfaces may
 * use class methods, so the bounded prototype walk accepts data descriptors there too. A getter
 * or hostile reflection failure remains nonconforming without touching an authorized or legacy
 * runtime method.
 */
function readDataProperty(value: unknown, key: string): DataPropertyLookup {
  if (!isObjectReference(value)) {
    return { kind: "missing" };
  }
  try {
    let current: object | null = value;
    for (let depth = 0; current && depth < MAXIMUM_RUNTIME_PROTOTYPE_DEPTH; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) {
        return "value" in descriptor
          ? { kind: "data", value: descriptor.value }
          : { kind: "accessor" };
      }
      current = Object.getPrototypeOf(current);
    }
  } catch {
    // A Proxy can reject reflection. Treat it as a nonconforming declaration.
    return { kind: "unavailable" };
  }
  return { kind: "missing" };
}

/**
 * The SDK validator deliberately enforces exact descriptor shape. A plugin runtime can still be
 * a hostile Proxy, so shadow inspection turns any reflection failure into a nonconforming result.
 */
function inspectCapabilityDeclaration(value: unknown): {
  hasWellFormedDeclaration: boolean;
  missingCapabilities: readonly MemoryAuthorizationCapabilityName[];
} {
  try {
    if (!isMemoryAuthorizationCapabilities(value)) {
      return {
        hasWellFormedDeclaration: false,
        missingCapabilities: MEMORY_AUTHORIZATION_CAPABILITY_NAMES,
      };
    }
    return {
      hasWellFormedDeclaration: true,
      missingCapabilities: listMissingMemoryAuthorizationCapabilities(value),
    };
  } catch {
    return {
      hasWellFormedDeclaration: false,
      missingCapabilities: MEMORY_AUTHORIZATION_CAPABILITY_NAMES,
    };
  }
}

function freezeInspection(params: Omit<MemoryAuthorizationRuntimeInspection, "version">) {
  return Object.freeze({
    version: 1 as const,
    ...params,
    missingCapabilities: Object.freeze([...params.missingCapabilities]),
    missingMethods: Object.freeze([...params.missingMethods]),
  });
}

/**
 * Produces content-free shape metadata only. It is intentionally not an admission decision and
 * does not retain, invoke, or wrap the inspected runtime.
 */
export function inspectMemoryAuthorizationRuntime(
  runtime: unknown,
): MemoryAuthorizationRuntimeInspection {
  const authorization = readDataProperty(runtime, "authorization");
  const hasDeclaration = authorization.kind === "data";
  // Use the shared contract validator so shadow reporting and enforced-mode admission agree on
  // the exact declaration shape. This boundary catches reflection traps as malformed.
  const { hasWellFormedDeclaration, missingCapabilities } = inspectCapabilityDeclaration(
    hasDeclaration ? authorization.value : undefined,
  );
  const declaredCapabilityCount =
    MEMORY_AUTHORIZATION_CAPABILITY_NAMES.length - missingCapabilities.length;
  const methods = AUTHORIZED_MEMORY_RUNTIME_METHODS.map((name) => ({
    name,
    property: readDataProperty(runtime, name),
  }));
  const implementedMethodCount = methods.filter(
    ({ property }) => property.kind === "data" && typeof property.value === "function",
  ).length;
  const missingMethods = methods
    .filter(({ property }) => property.kind !== "data" || typeof property.value !== "function")
    .map(({ name }) => name);
  const capabilityDeclaration = !hasDeclaration
    ? authorization.kind === "missing"
      ? "missing"
      : "malformed"
    : !hasWellFormedDeclaration
      ? "malformed"
      : missingCapabilities.length === 0
        ? "complete"
        : "partial";
  const surfaceComplete = capabilityDeclaration === "complete" && missingMethods.length === 0;

  return freezeInspection({
    capabilityDeclaration,
    declaredCapabilityCount,
    requiredCapabilityCount: MEMORY_AUTHORIZATION_CAPABILITY_NAMES.length,
    implementedMethodCount,
    requiredMethodCount: AUTHORIZED_MEMORY_RUNTIME_METHODS.length,
    missingCapabilities,
    missingMethods,
    surfaceComplete,
    reasonCode: surfaceComplete ? "surface-complete" : "backend-nonconforming",
  });
}

import {
  runMemoryAuthorizationConformanceSuite,
  type MemoryAuthorizationConformanceAdapter,
} from "../plugin-sdk/memory-authorization-conformance.js";
import {
  MEMORY_AUTHORIZATION_CAPABILITY_NAMES,
  isMemoryAuthorizationCapabilities,
  listMissingMemoryAuthorizationCapabilities,
  type AuthorizedMemoryRuntime,
  type MemoryAuthorizationCapabilityName,
} from "../plugin-sdk/memory-authorization.js";

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

const AUTHORIZED_MEMORY_READ_METHODS = ["authorize", "searchAuthorized", "readAuthorized"] as const;
const AUTHORIZED_MEMORY_READ_CAPABILITIES = [
  "scopedCandidates",
  "exactReadByAuthorizedHandle",
] as const satisfies readonly MemoryAuthorizationCapabilityName[];

export type AdmittedAuthorizedMemoryReadRuntime = Readonly<
  Pick<AuthorizedMemoryRuntime, (typeof AUTHORIZED_MEMORY_READ_METHODS)[number]>
>;

export type MemoryAuthorizationReadAdmission =
  | Readonly<{ ok: true; runtime: AdmittedAuthorizedMemoryReadRuntime }>
  | Readonly<{ ok: false; reasonCode: "backend-nonconforming" }>;

type MemoryAuthorizationCapabilityInspection = Readonly<{
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

// Capability and runtime interfaces are shallow; the bound prevents hostile prototype chains
// from extending a shadow-only inspection beyond its fixed metadata budget.
const MAXIMUM_INSPECTION_PROTOTYPE_DEPTH = 8;

function isObjectReference(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

type DataPropertyLookup =
  | { kind: "data"; value: unknown }
  | { kind: "missing" | "accessor" | "unavailable" };

/**
 * Reads a data descriptor without evaluating the corresponding property. Capability and runtime
 * interfaces may use class methods, so the bounded prototype walk accepts data descriptors there
 * too. A getter or hostile reflection failure remains nonconforming without touching a method.
 */
function readDataProperty(value: unknown, key: string): DataPropertyLookup {
  if (!isObjectReference(value)) {
    return { kind: "missing" };
  }
  try {
    let current: object | null = value;
    for (let depth = 0; current && depth < MAXIMUM_INSPECTION_PROTOTYPE_DEPTH; depth += 1) {
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
 * The SDK validator deliberately enforces exact descriptor shape. A plugin capability can still
 * be a hostile Proxy, so shadow inspection turns any reflection failure into a nonconforming result.
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

function freezeInspection(params: Omit<MemoryAuthorizationCapabilityInspection, "version">) {
  return Object.freeze({
    version: 1 as const,
    ...params,
    missingCapabilities: Object.freeze([...params.missingCapabilities]),
    missingMethods: Object.freeze([...params.missingMethods]),
  });
}

/**
 * Produces content-free shape metadata only. It is intentionally not an admission decision and
 * does not retain, invoke, or wrap the selected capability or its runtime.
 */
export function inspectMemoryAuthorizationCapability(
  capability: unknown,
): MemoryAuthorizationCapabilityInspection {
  const authorization = readDataProperty(capability, "authorization");
  const hasDeclaration = authorization.kind === "data";
  // Use the shared contract validator so shadow reporting and enforced-mode admission agree on
  // the exact declaration shape. This boundary catches reflection traps as malformed.
  const { hasWellFormedDeclaration, missingCapabilities } = inspectCapabilityDeclaration(
    hasDeclaration ? authorization.value : undefined,
  );
  const declaredCapabilityCount =
    MEMORY_AUTHORIZATION_CAPABILITY_NAMES.length - missingCapabilities.length;
  const runtime = readDataProperty(capability, "runtime");
  const methods = AUTHORIZED_MEMORY_RUNTIME_METHODS.map((name) => ({
    name,
    property: readDataProperty(runtime.kind === "data" ? runtime.value : undefined, name),
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

function isConformanceAdapter(value: unknown): value is MemoryAuthorizationConformanceAdapter {
  const evaluate = readCallable(value, "evaluate");
  const prefilter = readCallable(value, "prefilter");
  return (
    isObjectReference(value) && typeof evaluate === "function" && typeof prefilter === "function"
  );
}

function readCallable(value: unknown, key: string): ((...args: never[]) => unknown) | undefined {
  const property = readDataProperty(value, key);
  return property.kind === "data" && typeof property.value === "function"
    ? (property.value as (...args: never[]) => unknown)
    : undefined;
}

/**
 * Enforced callers use this admission result directly. A failed alternate has no legacy runtime
 * in the result, so it cannot silently broaden a scoped read through the old search manager.
 */
export async function admitMemoryAuthorizationReadRuntime(
  capability: unknown,
): Promise<MemoryAuthorizationReadAdmission> {
  const authorization = readDataProperty(capability, "authorization");
  const runtime = readDataProperty(capability, "runtime");
  const conformance = readDataProperty(capability, "authorizationConformance");
  const authorizationCapabilities =
    authorization.kind === "data" && isMemoryAuthorizationCapabilities(authorization.value)
      ? authorization.value
      : undefined;
  if (
    runtime.kind !== "data" ||
    conformance.kind !== "data" ||
    !authorizationCapabilities ||
    AUTHORIZED_MEMORY_READ_CAPABILITIES.some((name) => !authorizationCapabilities[name]) ||
    !isConformanceAdapter(conformance.value)
  ) {
    return Object.freeze({ ok: false, reasonCode: "backend-nonconforming" });
  }
  const authorize = readCallable(runtime.value, "authorize");
  const searchAuthorized = readCallable(runtime.value, "searchAuthorized");
  const readAuthorized = readCallable(runtime.value, "readAuthorized");
  if (!authorize || !searchAuthorized || !readAuthorized) {
    return Object.freeze({ ok: false, reasonCode: "backend-nonconforming" });
  }
  try {
    const report = await runMemoryAuthorizationConformanceSuite(conformance.value);
    if (!report.ok) {
      return Object.freeze({ ok: false, reasonCode: "backend-nonconforming" });
    }
  } catch {
    return Object.freeze({ ok: false, reasonCode: "backend-nonconforming" });
  }
  return Object.freeze({
    ok: true,
    runtime: Object.freeze({
      authorize: (authorize as AuthorizedMemoryRuntime["authorize"]).bind(runtime.value),
      searchAuthorized: (searchAuthorized as AuthorizedMemoryRuntime["searchAuthorized"]).bind(
        runtime.value,
      ),
      readAuthorized: (readAuthorized as AuthorizedMemoryRuntime["readAuthorized"]).bind(
        runtime.value,
      ),
    }),
  });
}

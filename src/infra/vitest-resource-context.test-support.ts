import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import {
  composeVitestResourceContextNodeOptions,
  findVitestResourceOwner,
  getVitestResourceContext,
  type VitestResourceContextDescriptor,
  type VitestResourceOwner,
  VITEST_RESOURCE_CONTEXT_KEY,
  VITEST_RESOURCE_CONTEXT_SYMBOL,
} from "./vitest-resource-ownership.ts";

export const VITEST_OPENCLAW_RESOURCE_ROOT = "VITEST_OPENCLAW_RESOURCE_ROOT";
export const VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN = "VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN";
export const VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT = "VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT";
export const VITEST_PAUSE_AFTER_ACK_RECEIPT = "VITEST_PAUSE_AFTER_ACK_RECEIPT";
export const VITEST_RESOURCE_CONTEXT_NODE_OPTION = `--import=${
  new URL("./vitest-resource-context-preload.test-support.ts", import.meta.url).href
}`;

export function composeVitestLauncherNodeOptions(requested: string | undefined): string {
  const nodeOptions = composeVitestResourceContextNodeOptions(
    requested,
    VITEST_RESOURCE_CONTEXT_NODE_OPTION,
  );
  if (!nodeOptions) {
    throw new Error("Failed to compose Vitest launcher NODE_OPTIONS");
  }
  return nodeOptions;
}

type VitestResourceOwnerLineageEntry = { root: string; identity: string };

function isResourceOwnerLineageEntry(value: unknown): value is VitestResourceOwnerLineageEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { root?: unknown }).root === "string" &&
    typeof (value as { identity?: unknown }).identity === "string"
  );
}

function resolveExactResourceOwner(marker: string): VitestResourceOwner | undefined {
  const canonicalRoot = fs.realpathSync(marker);
  const owner = findVitestResourceOwner(canonicalRoot);
  return owner?.root === canonicalRoot ? owner : undefined;
}

function deriveProductionRuntimeDirectory(env: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32") {
    return "/tmp";
  }
  const originalHome =
    env.USERPROFILE ??
    (env.HOMEDRIVE && env.HOMEPATH ? path.join(env.HOMEDRIVE, env.HOMEPATH) : homedir());
  return path.join(originalHome, "AppData", "Local", "OpenClaw", "locks");
}

function resolveContext(env: NodeJS.ProcessEnv): {
  descriptor: VitestResourceContextDescriptor;
  owners: readonly VitestResourceOwner[];
} {
  const resourceMarker = env[VITEST_OPENCLAW_RESOURCE_ROOT];
  const chainMarker = env[VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN];
  if (resourceMarker === undefined) {
    if (chainMarker !== undefined) {
      throw new Error("Inherited Vitest resource root chain requires its root marker");
    }
    return { descriptor: { kind: "absent" }, owners: [] };
  }
  if (!resourceMarker) {
    throw new Error("Invalid inherited Vitest resource root");
  }
  if (!chainMarker) {
    throw new Error("Inherited Vitest resource root requires an identity-bearing chain");
  }
  let primaryOwner: VitestResourceOwner | undefined;
  try {
    primaryOwner = resolveExactResourceOwner(resourceMarker);
  } catch (error) {
    throw new Error(`Invalid inherited Vitest resource root: ${resourceMarker}`, { cause: error });
  }
  if (!primaryOwner) {
    throw new Error(`Invalid inherited Vitest resource root: ${resourceMarker}`);
  }
  let markers: unknown;
  try {
    markers = JSON.parse(chainMarker);
  } catch (error) {
    throw new Error("Invalid inherited Vitest resource root chain", { cause: error });
  }
  if (!Array.isArray(markers) || markers.some((entry) => !isResourceOwnerLineageEntry(entry))) {
    throw new Error("Invalid inherited Vitest resource root chain");
  }
  const owners = [primaryOwner];
  for (const entry of markers) {
    let owner: VitestResourceOwner | undefined;
    try {
      owner = resolveExactResourceOwner(entry.root);
    } catch (error) {
      throw new Error(`Invalid inherited Vitest resource root: ${entry.root}`, { cause: error });
    }
    if (!owner || owner.identity !== entry.identity) {
      throw new Error(`Invalid inherited Vitest resource root: ${entry.root}`);
    }
    if (!owners.some((candidate) => candidate.root === owner.root)) {
      owners.push(owner);
    }
  }
  if (
    !markers.some(
      (entry) => entry.root === primaryOwner.root && entry.identity === primaryOwner.identity,
    )
  ) {
    throw new Error("Inherited Vitest resource root is not bound to its owner identity");
  }
  const productionRuntimeDirectory = env[VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT];
  if (!productionRuntimeDirectory) {
    throw new Error("Inherited Vitest resource lineage requires a production lock root");
  }
  const ownerDescriptors = owners.map(({ root, identity }) => ({ root, identity }));
  return {
    descriptor: {
      kind: "owned",
      environment: {
        [VITEST_OPENCLAW_RESOURCE_ROOT]: primaryOwner.root,
        [VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN]: JSON.stringify(ownerDescriptors),
        [VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT]: productionRuntimeDirectory,
      },
      nodeOption: VITEST_RESOURCE_CONTEXT_NODE_OPTION,
      owners: ownerDescriptors,
      productionRuntimeDirectory,
    },
    owners,
  };
}

export function resolveVitestResourceContext(
  env: NodeJS.ProcessEnv,
): VitestResourceContextDescriptor {
  return resolveContext(env).descriptor;
}

export function resolveVitestLauncherResourceContext(env: NodeJS.ProcessEnv): {
  kind: "absent" | "owned";
  owners: readonly VitestResourceOwner[];
  productionRuntimeDirectory: string;
} {
  const published = getVitestResourceContext();
  const resourceMarker = env[VITEST_OPENCLAW_RESOURCE_ROOT];
  const chainMarker = env[VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN];
  if (resourceMarker === undefined && chainMarker === undefined) {
    if (published?.kind === "owned") {
      const requestedProductionRoot = env[VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT];
      if (
        requestedProductionRoot &&
        requestedProductionRoot !== published.productionRuntimeDirectory
      ) {
        throw new Error("Conflicting inherited Vitest production lock root");
      }
      return {
        kind: published.kind,
        owners: published.owners,
        productionRuntimeDirectory: published.productionRuntimeDirectory,
      };
    }
  }
  const context = resolveContext(env);
  if (published?.kind === "owned" && context.descriptor.kind === "owned") {
    if (context.descriptor.productionRuntimeDirectory !== published.productionRuntimeDirectory) {
      throw new Error("Conflicting inherited Vitest production lock root");
    }
    const owners = [...context.owners];
    for (const publishedOwner of published.owners) {
      const existing = owners.find((owner) => owner.root === publishedOwner.root);
      if (existing && existing.identity !== publishedOwner.identity) {
        throw new Error(`Conflicting inherited Vitest resource owner: ${publishedOwner.root}`);
      }
      if (!existing) {
        owners.push(publishedOwner);
      }
    }
    return {
      kind: "owned",
      owners,
      productionRuntimeDirectory: published.productionRuntimeDirectory,
    };
  }
  return {
    kind: context.descriptor.kind,
    owners: context.owners,
    productionRuntimeDirectory:
      context.descriptor.kind === "owned"
        ? context.descriptor.productionRuntimeDirectory
        : deriveProductionRuntimeDirectory(env),
  };
}

function contextsMatch(
  left: VitestResourceContextDescriptor,
  right: VitestResourceContextDescriptor,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "absent" || right.kind === "absent") {
    return true;
  }
  return (
    left.productionRuntimeDirectory === right.productionRuntimeDirectory &&
    left.nodeOption === right.nodeOption &&
    Object.keys(left.environment).length === Object.keys(right.environment).length &&
    Object.entries(left.environment).every(([key, value]) => right.environment[key] === value) &&
    left.owners.length === right.owners.length &&
    left.owners.every(
      (owner, index) =>
        owner.root === right.owners[index]?.root &&
        owner.identity === right.owners[index]?.identity,
    )
  );
}

export function publishVitestResourceContext(context: VitestResourceContextDescriptor): void {
  const target = globalThis as Record<PropertyKey, unknown>;
  const existingContexts = [
    target[VITEST_RESOURCE_CONTEXT_SYMBOL],
    getEnvironmentData(VITEST_RESOURCE_CONTEXT_KEY),
  ].filter((existing): existing is VitestResourceContextDescriptor => existing !== undefined);
  for (const existing of existingContexts) {
    if (!contextsMatch(existing, context)) {
      throw new Error("Conflicting Vitest resource context preload");
    }
  }
  const published =
    context.kind === "owned"
      ? Object.freeze({
          ...context,
          environment: Object.freeze({ ...context.environment }),
          owners: Object.freeze([...context.owners]),
        })
      : Object.freeze(context);
  if (target[VITEST_RESOURCE_CONTEXT_SYMBOL] === undefined) {
    Object.defineProperty(target, VITEST_RESOURCE_CONTEXT_SYMBOL, {
      configurable: false,
      enumerable: false,
      value: published,
      writable: false,
    });
  }
  setEnvironmentData(VITEST_RESOURCE_CONTEXT_KEY, published);
}

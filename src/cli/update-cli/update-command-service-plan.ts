// Read-only managed Gateway ownership and Node selection for update planning.
import fs from "node:fs/promises";
import path from "node:path";
import { err as resultError, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { summarizeGatewayServiceLayout } from "../../daemon/service-layout.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { assertGatewayServiceMutationAllowed } from "../../infra/gateway-supervision.js";
import { nodeVersionSatisfiesEngine } from "../../infra/runtime-guard.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { resolveNodeRunner } from "./shared.js";

export type ManagedServiceRootRedirect = {
  root: string;
  previousRoot: string;
};

export class GatewayServiceUpdateOwnershipError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "GatewayServiceUpdateOwnershipError";
  }
}

export function resolveGatewayServiceManagementBlockMessageForUpdate(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  try {
    assertGatewayServiceManagementAllowedForUpdate(env);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function assertGatewayServiceManagementAllowedForUpdate(
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    assertGatewayServiceMutationAllowed("manage the gateway service during update", env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GatewayServiceUpdateOwnershipError(message, err);
  }
}

export function isGatewayServiceManagementAllowedForUpdate(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveGatewayServiceManagementBlockMessageForUpdate(env) === undefined;
}

type PackageRuntimePreflight = {
  nodeRunner?: string;
  replacedNodeRunner?: string;
  targetVersion?: string;
};

export async function resolvePackageRuntimePreflight(params: {
  target?: { version: string; nodeEngine: string | null };
  timeoutMs?: number;
  nodeRunner?: string;
  fallbackNodeRunner?: string;
}): Promise<Result<PackageRuntimePreflight, string>> {
  const nodeRunner = normalizeOptionalString(params.nodeRunner);
  const unchanged = (): PackageRuntimePreflight => (nodeRunner ? { nodeRunner } : {});
  const target = params.target;
  if (!target) {
    return ok(unchanged());
  }
  const runtime = await resolvePackageRuntimeForPreflight({
    nodeRunner,
    timeoutMs: params.timeoutMs,
  });
  const satisfies = nodeVersionSatisfiesEngine(runtime.version, target.nodeEngine);
  const targetVersion = target.version;
  const unchangedRuntime = { ...unchanged(), targetVersion };
  if (satisfies === true) {
    return ok(unchangedRuntime);
  }
  const fallbackNodeRunner = normalizeOptionalString(params.fallbackNodeRunner);
  if (nodeRunner && fallbackNodeRunner && fallbackNodeRunner !== nodeRunner) {
    const fallbackRuntime = await resolvePackageRuntimeForPreflight({
      nodeRunner: fallbackNodeRunner,
      timeoutMs: params.timeoutMs,
    });
    const fallbackSatisfies = nodeVersionSatisfiesEngine(
      fallbackRuntime.version,
      target.nodeEngine,
    );
    if (fallbackSatisfies === true) {
      return ok({
        nodeRunner: fallbackNodeRunner,
        replacedNodeRunner: nodeRunner,
        targetVersion,
      });
    }
  }
  if (satisfies !== false) {
    return ok(unchangedRuntime);
  }
  const runtimeLabel = runtime.nodeRunner
    ? `Node ${runtime.version ?? "unknown"} at ${runtime.nodeRunner}`
    : `Node ${runtime.version ?? "unknown"}`;
  return resultError(
    [
      `${runtimeLabel} is too old for openclaw@${targetVersion}.`,
      `The requested package requires ${target.nodeEngine}.`,
      runtime.nodeRunner
        ? "Upgrade the Node runtime that owns the managed Gateway service, then rerun `openclaw update`."
        : "Upgrade to Node 22.22.3+, Node 24.15.0+, or Node 25.9.0+, then rerun `openclaw update`.",
      "Bare `npm i -g openclaw` can silently install an older compatible release.",
      "After upgrading Node, use `npm i -g openclaw@latest`.",
    ].join("\n"),
  );
}

async function resolvePackageRuntimeForPreflight(params: {
  nodeRunner?: string;
  timeoutMs?: number;
}): Promise<{ version: string | null; nodeRunner?: string }> {
  const nodeRunner = normalizeOptionalString(params.nodeRunner);
  if (!nodeRunner) {
    return { version: process.versions.node ?? null };
  }
  const res = await runCommandWithTimeout([nodeRunner, "--version"], {
    timeoutMs: Math.min(params.timeoutMs ?? 10_000, 10_000),
  }).catch(() => null);
  return {
    version: res?.code === 0 ? res.stdout.trim().replace(/^v/u, "") || null : null,
    nodeRunner,
  };
}

async function tryRealpathOrResolve(value: string): Promise<string> {
  return await fs.realpath(path.resolve(value)).catch(() => path.resolve(value));
}

function resolveManagedServiceNodeRunner(
  command: GatewayServiceCommandConfig | null,
): string | undefined {
  const args = command?.programArguments ?? [];
  // Native heap flags and dev loaders separate the executable from the entrypoint.
  const runner = args.indexOf("gateway") > 1 ? args[0] : undefined;
  const executable = normalizeOptionalString(runner ? path.basename(runner) : undefined);
  return ["node", "node.exe"].includes(executable?.toLowerCase() ?? "") ? runner : undefined;
}

export async function resolveManagedServicePackageUpdatePlan(params: {
  root: string;
}): Promise<{ rootRedirect: ManagedServiceRootRedirect | null; nodeRunner?: string }> {
  if (!isGatewayServiceManagementAllowedForUpdate(process.env)) {
    return { rootRedirect: null };
  }
  // Root and runtime planning share one effective command; mutation and restart
  // revalidate independently so this snapshot cannot grant later service authority.
  const command = await resolveGatewayService()
    .readCommand(process.env, { requireEffective: true })
    .catch(() => null);
  const layout = await summarizeGatewayServiceLayout(command);
  const serviceRoot = layout?.packageRoot;
  const serviceNode = resolveManagedServiceNodeRunner(command);
  if (
    serviceRoot &&
    layout.packageRootReal &&
    layout.entrypointSourceCheckout !== true &&
    (await tryRealpathOrResolve(params.root)) !== layout.packageRootReal
  ) {
    return {
      rootRedirect: { root: serviceRoot, previousRoot: params.root },
      ...(serviceNode ? { nodeRunner: serviceNode } : {}),
    };
  }
  if (!serviceNode) {
    return { rootRedirect: null };
  }
  const [serviceNodeReal, currentNodeReal] = await Promise.all([
    tryRealpathOrResolve(serviceNode),
    tryRealpathOrResolve(resolveNodeRunner()),
  ]);
  return {
    rootRedirect: null,
    ...(serviceNodeReal !== currentNodeReal ? { nodeRunner: serviceNode } : {}),
  };
}

export async function gatewayServiceCommandUsesRoot(params: {
  root: string | undefined;
  env?: NodeJS.ProcessEnv;
  command?: GatewayServiceCommandConfig | null;
}): Promise<boolean | null> {
  const expectedRoot = normalizeOptionalString(params.root);
  if (!expectedRoot) {
    return null;
  }
  const command =
    params.command === undefined
      ? isGatewayServiceManagementAllowedForUpdate(params.env ?? process.env)
        ? await resolveGatewayService()
            .readCommand(params.env ?? process.env, { requireEffective: true })
            .catch(() => null)
        : null
      : params.command;
  const layout = await summarizeGatewayServiceLayout(command);
  const serviceRoot = layout?.packageRoot;
  const serviceEntrypoint = layout?.entrypoint;
  if (
    !serviceRoot ||
    !serviceEntrypoint ||
    (!path.isAbsolute(serviceEntrypoint) && !path.win32.isAbsolute(serviceEntrypoint))
  ) {
    return null;
  }
  const [expectedRootReal, serviceRootReal] = await Promise.all([
    tryRealpathOrResolve(expectedRoot),
    tryRealpathOrResolve(serviceRoot),
  ]);
  if (expectedRootReal === serviceRootReal) {
    return true;
  }
  // Paired read-only release mounts have different paths but the same directory
  // identity. Copies of another release must remain foreign.
  const [expected, actual] = await Promise.all(
    [expectedRootReal, serviceRootReal].map((root) => fs.stat(root).catch(() => null)),
  );
  if (expected && actual && expected.dev === actual.dev && expected.ino === actual.ino) {
    return true;
  }
  const managed = command?.managedDefinition;
  if (
    !managed ||
    (await gatewayServiceCommandUsesRoot({ root: expectedRoot, command: managed })) !== true
  ) {
    return false;
  }
  const namespace = path.dirname(expectedRootReal);
  const managedLayout = await summarizeGatewayServiceLayout(managed);
  const stableEntry = path.join(
    namespace,
    "current",
    "dist",
    path.basename(managedLayout?.entrypoint ?? ""),
  );
  if (serviceEntrypoint !== stableEntry) {
    return false;
  }
  // Deployment-owned current points into this installation's releases, either
  // by symlink or by a paired bind mount. Unrelated namespaces remain foreign.
  const releases = path.join(namespace, "releases");
  if (serviceRootReal.startsWith(`${releases}${path.sep}`)) {
    return true;
  }
  try {
    for await (const entry of await fs.opendir(releases)) {
      const candidate = await fs.lstat(path.join(releases, entry.name));
      if (actual && candidate.dev === actual.dev && candidate.ino === actual.ino) {
        return true;
      }
    }
  } catch {
    // Without directory identity proof, the override cannot authorize lifecycle actions.
  }
  return false;
}

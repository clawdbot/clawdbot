/** Validates node-owned placement workspace identities and canonical paths. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";

const GATEWAY_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export type NodeWorkerManagedWorkspaceRequest = {
  workspaceDir: string;
  environmentId: string;
  sessionId: string;
  ownerEpoch: number;
  sessionKey: string;
};

export function hashNodeWorkerWorkspaceComponent(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function nodeWorkerWorkspaceGenerationKey(params: {
  gatewayNamespace: string;
  environmentHash: string;
  sessionHash: string;
  generation: number;
}): string {
  return [
    params.gatewayNamespace,
    params.environmentHash,
    params.sessionHash,
    params.generation,
  ].join("/");
}

export function nodeWorkerWorkspaceLaunchGenerationKey(reference: {
  gatewayNamespace: string;
  environmentId: string;
  sessionId: string;
  ownerEpoch: number;
}): string {
  return nodeWorkerWorkspaceGenerationKey({
    gatewayNamespace: reference.gatewayNamespace,
    environmentHash: hashNodeWorkerWorkspaceComponent(reference.environmentId, 16),
    sessionHash: hashNodeWorkerWorkspaceComponent(reference.sessionId, 32),
    generation: reference.ownerEpoch,
  });
}

export function nodeWorkerWorkspaceSessionKey(
  environmentHash: string,
  sessionHash: string,
): string {
  return `${environmentHash}/${sessionHash}`;
}

export function parseNodeWorkerWorkspaceGeneration(name: string): number | undefined {
  const generation = Number(name);
  return Number.isSafeInteger(generation) && generation >= 0 && String(generation) === name
    ? generation
    : undefined;
}

export function parseNodeWorkerWorkspaceTransferGeneration(name: string): number | undefined {
  const staging = /^\.([0-9]+)\.workspace-transfer-.+$/u.exec(name)?.[1];
  const backup = /^([0-9]+)\.previous-.+$/u.exec(name)?.[1];
  const generation = staging ?? backup;
  return generation === undefined ? undefined : parseNodeWorkerWorkspaceGeneration(generation);
}

/** Proves an existing workspace was derived from its exact node-owned placement identity. */
export function resolveNodeManagedWorkspaceIdentity(
  root: string,
  request: NodeWorkerManagedWorkspaceRequest,
): { workspaceDir: string; gatewayNamespace: string; generationKey: string } {
  const fail = () => {
    throw new Error("INVALID_REQUEST: node placement does not own the requested workspace");
  };
  if (
    typeof request.workspaceDir !== "string" ||
    !path.isAbsolute(request.workspaceDir) ||
    typeof request.environmentId !== "string" ||
    !request.environmentId ||
    typeof request.sessionId !== "string" ||
    !request.sessionId ||
    typeof request.sessionKey !== "string" ||
    !request.sessionKey ||
    !Number.isSafeInteger(request.ownerEpoch) ||
    request.ownerEpoch < 1
  ) {
    return fail();
  }

  let stats: fs.Stats;
  let workspaceDir: string;
  try {
    stats = fs.lstatSync(request.workspaceDir);
    workspaceDir = fs.realpathSync.native(request.workspaceDir);
  } catch {
    return fail();
  }
  const components = path.relative(root, workspaceDir).split(path.sep);
  const gatewayNamespace = components[0];
  if (!gatewayNamespace || !GATEWAY_NAMESPACE_PATTERN.test(gatewayNamespace)) {
    return fail();
  }
  const environmentHash = hashNodeWorkerWorkspaceComponent(request.environmentId, 16);
  const sessionHash = hashNodeWorkerWorkspaceComponent(request.sessionId, 32);
  const expected = path.join(
    root,
    gatewayNamespace,
    "workspaces",
    environmentHash,
    sessionHash,
    String(request.ownerEpoch),
  );
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    !isPathInside(root, workspaceDir) ||
    components.length !== 5 ||
    components[1] !== "workspaces" ||
    request.workspaceDir !== workspaceDir ||
    workspaceDir !== expected
  ) {
    return fail();
  }
  return {
    workspaceDir,
    gatewayNamespace,
    generationKey: nodeWorkerWorkspaceGenerationKey({
      gatewayNamespace,
      environmentHash,
      sessionHash,
      generation: request.ownerEpoch,
    }),
  };
}

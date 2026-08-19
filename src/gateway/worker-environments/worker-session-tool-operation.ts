import { sha256Base64Url, sha256HexPrefixCore } from "../../infra/crypto-digest.js";

export class WorkerSessionToolOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super("Worker session operation outcome is unknown; it was not replayed", { cause });
    this.name = "WorkerSessionToolOutcomeUnknownError";
  }
}

export function computeWorkerSessionToolRequestDigest(value: unknown): string {
  return sha256Base64Url(`openclaw.worker-session-tool-request.v1\0${JSON.stringify(value)}`);
}

export function workerSessionToolOperationKey(operationSeed: string, purpose: string): string {
  return sha256Base64Url(`openclaw.worker-session-tool-operation.v1\0${operationSeed}\0${purpose}`);
}

export function throwIfWorkerSessionToolAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

export function workerChildSessionKey(params: {
  operationSeed: string;
  targetAgentId: string;
}): string {
  const suffix = sha256HexPrefixCore(
    `openclaw.worker-session-tool-operation.v1\0${params.operationSeed}\0child-session`,
    32,
  );
  return `agent:${params.targetAgentId}:dashboard:cloud-${suffix}`;
}

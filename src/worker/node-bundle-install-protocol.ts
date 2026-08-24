import { z } from "zod";
import {
  WORKER_BUNDLE_PREWARM_VERSION,
  validateWorkerAdmissionHandshake,
  type WorkerAdmissionHandshake,
} from "../../packages/gateway-protocol/src/index.js";
import { MAX_WORKER_BUNDLE_ARCHIVE_BYTES } from "../shared/worker-bundle-limits.js";

export const NODE_WORKER_BUNDLE_TRANSFER_PATH = "/__openclaw__/worker-bundle/v1";
export const NODE_WORKER_BUNDLE_INSTALL_ERROR_CODE = "WORKER_BUNDLE_INSTALL_FAILED";

const REQUEST_MAX_BYTES = 16 * 1024;
const GATEWAY_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

const WorkerBuildSchema = z.custom<WorkerAdmissionHandshake>(
  (value) => validateWorkerAdmissionHandshake(value),
  "invalid worker build identity",
);

const BundleInstallInputSchema = z
  .object({
    gatewayNamespace: z.string().regex(GATEWAY_NAMESPACE_PATTERN),
    bundlePrewarm: z.literal(WORKER_BUNDLE_PREWARM_VERSION).optional(),
    build: WorkerBuildSchema,
    archive: z
      .object({
        token: z.string().regex(TOKEN_PATTERN),
        sha256: z.string().regex(SHA256_PATTERN),
        bytes: z.number().int().min(1).max(MAX_WORKER_BUNDLE_ARCHIVE_BYTES),
      })
      .strict(),
  })
  .strict();

export type NodeWorkerBundleInstallInput = z.infer<typeof BundleInstallInputSchema>;
export type NodeWorkerBundleInstallResult = WorkerAdmissionHandshake;

export class NodeWorkerBundleInstallError extends Error {
  readonly code = NODE_WORKER_BUNDLE_INSTALL_ERROR_CODE;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NodeWorkerBundleInstallError";
  }
}

export function parseNodeWorkerBundleInstallInput(
  raw?: string | null,
): NodeWorkerBundleInstallInput {
  if (!raw || Buffer.byteLength(raw, "utf8") > REQUEST_MAX_BYTES) {
    throw new Error("INVALID_REQUEST: invalid node worker bundle install request");
  }
  try {
    return BundleInstallInputSchema.parse(JSON.parse(raw) as unknown);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`INVALID_REQUEST: invalid node worker bundle install request: ${detail}`, {
      cause: error,
    });
  }
}

export function parseNodeWorkerBundleInstallResult(
  value: unknown,
): NodeWorkerBundleInstallResult | null {
  return validateWorkerAdmissionHandshake(value) ? structuredClone(value) : null;
}

export function nodeWorkerBundleTransferPath(bundleHash: string): string {
  return `${NODE_WORKER_BUNDLE_TRANSFER_PATH}/bundles/${bundleHash}`;
}

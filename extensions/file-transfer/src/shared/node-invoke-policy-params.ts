import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import type { FileTransferNodeInvokeCommand } from "./node-invoke-policy-commands.js";

const FILE_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const FILE_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
const DIR_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DIR_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;

function readMaxBytes(input: {
  value: unknown;
  defaultValue: number;
  hardMax: number;
  policyMax?: number;
}): number {
  const parsed =
    input.value === undefined
      ? input.defaultValue
      : readPositiveIntegerParam({ maxBytes: input.value }, "maxBytes");
  const requested = parsed ?? input.defaultValue;
  const clamped = Math.max(1, Math.min(requested, input.hardMax));
  return input.policyMax ? Math.min(clamped, input.policyMax) : clamped;
}

export function validateFetchMaxBytesParam(
  command: FileTransferNodeInvokeCommand,
  params: Record<string, unknown>,
) {
  if (command !== "file.fetch" && command !== "dir.fetch") {
    return;
  }
  if (params.maxBytes !== undefined) {
    readPositiveIntegerParam(params, "maxBytes");
  }
}

export function prepareParams(input: {
  command: FileTransferNodeInvokeCommand;
  params: Record<string, unknown>;
  followSymlinks: boolean;
  maxBytes?: number;
}): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...input.params,
    followSymlinks: input.followSymlinks,
  };
  delete next.preflightOnly;
  delete next.expectedCanonicalPath;
  delete next.expectedBinding;
  if (input.command === "file.fetch") {
    next.maxBytes = readMaxBytes({
      value: input.params.maxBytes,
      defaultValue: FILE_FETCH_DEFAULT_MAX_BYTES,
      hardMax: FILE_FETCH_HARD_MAX_BYTES,
      policyMax: input.maxBytes,
    });
  } else if (input.command === "dir.fetch") {
    next.maxBytes = readMaxBytes({
      value: input.params.maxBytes,
      defaultValue: DIR_FETCH_DEFAULT_MAX_BYTES,
      hardMax: DIR_FETCH_HARD_MAX_BYTES,
      policyMax: input.maxBytes,
    });
  }
  return next;
}

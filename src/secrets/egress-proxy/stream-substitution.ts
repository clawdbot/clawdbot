import { Transform, type TransformCallback } from "node:stream";
import {
  looksLikeSecretSentinel,
  SECRET_SENTINEL_MAX_LENGTH,
  SECRET_SENTINEL_PREFIX,
  SECRET_SENTINEL_SUFFIX,
} from "../sentinel.js";

const SENTINEL_PREFIX_BYTES = Buffer.from(SECRET_SENTINEL_PREFIX);
const SENTINEL_SUFFIX_BYTES = Buffer.from(SECRET_SENTINEL_SUFFIX);

export type SecretEgressRefusalReason =
  | "invalid-proxy-auth"
  | "missing-proxy-auth"
  | "non-https-request"
  | "non-https-port"
  | "destination-not-allowed"
  | "unresolved-sentinel"
  | "upstream-error";

export class SecretEgressSubstitutionError extends Error {
  constructor(
    readonly reason: SecretEgressRefusalReason,
    readonly details?: { host: string; secretName: string },
  ) {
    super(
      details
        ? `Secret "${details.secretName}" is not allowed for host "${details.host}". Run: openclaw secrets store set ${details.secretName} --allow-host ${details.host}`
        : "Secret egress proxy refused an unresolved secret sentinel",
    );
    this.name = "SecretEgressSubstitutionError";
  }
}

function processPendingBuffer(params: {
  buffer: Buffer;
  flush: boolean;
  onSubstitution: () => void;
  resolveSentinel: (sentinel: string) => string | undefined;
  push: (chunk: Buffer) => void;
}): Buffer {
  let pending = params.buffer;
  for (;;) {
    const prefixIndex = pending.indexOf(SENTINEL_PREFIX_BYTES);
    if (prefixIndex === -1) {
      const carryBytes = params.flush
        ? 0
        : Math.min(pending.length, SENTINEL_PREFIX_BYTES.length - 1);
      const emitBytes = pending.length - carryBytes;
      if (emitBytes > 0) {
        params.push(pending.subarray(0, emitBytes));
      }
      return carryBytes > 0 ? pending.subarray(emitBytes) : Buffer.alloc(0);
    }
    if (prefixIndex > 0) {
      params.push(pending.subarray(0, prefixIndex));
      pending = pending.subarray(prefixIndex);
    }
    const suffixIndex = pending.indexOf(SENTINEL_SUFFIX_BYTES, SENTINEL_PREFIX_BYTES.length);
    if (suffixIndex === -1) {
      if (params.flush || pending.length > SECRET_SENTINEL_MAX_LENGTH) {
        throw new SecretEgressSubstitutionError("unresolved-sentinel");
      }
      return pending;
    }
    const sentinelEnd = suffixIndex + SENTINEL_SUFFIX_BYTES.length;
    if (sentinelEnd > SECRET_SENTINEL_MAX_LENGTH) {
      throw new SecretEgressSubstitutionError("unresolved-sentinel");
    }
    const sentinel = pending.subarray(0, sentinelEnd).toString("ascii");
    const resolved = looksLikeSecretSentinel(sentinel)
      ? params.resolveSentinel(sentinel)
      : undefined;
    if (resolved === undefined) {
      throw new SecretEgressSubstitutionError("unresolved-sentinel");
    }
    params.push(Buffer.from(resolved, "utf8"));
    params.onSubstitution();
    pending = pending.subarray(sentinelEnd);
  }
}

/** Rewrites process-local sentinels across arbitrary request-body chunk boundaries. */
export function createSecretEgressBodyTransform(params: {
  onSubstitution: () => void;
  resolveSentinel: (sentinel: string) => string | undefined;
}): Transform {
  let pending: Buffer = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback) {
      try {
        const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        pending = processPendingBuffer({
          buffer: pending.length > 0 ? Buffer.concat([pending, input]) : input,
          flush: false,
          onSubstitution: params.onSubstitution,
          resolveSentinel: params.resolveSentinel,
          push: (output) => this.push(output),
        });
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback: TransformCallback) {
      try {
        pending = processPendingBuffer({
          buffer: pending,
          flush: true,
          onSubstitution: params.onSubstitution,
          resolveSentinel: params.resolveSentinel,
          push: (output) => this.push(output),
        });
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

import { randomBytes } from "node:crypto";
import { isApprovalNotFoundError } from "../infra/approval-errors.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";

type NativeApprovalBinding = { token: string; expiresAtMs: number };

/** Own one plugin's process-local native controls through resolution and card updates. */
export function createNativeApprovalControlRegistry<
  TBinding extends NativeApprovalBinding,
>(params: { releaseClaimOnLookupExpiry: boolean; onComplete?: (binding: TBinding) => void }) {
  const bindings = new Map<string, TBinding>();
  const resolving = new Set<string>();

  const get = (token: string): TBinding | null => {
    const binding = bindings.get(token);
    if (!binding) {
      return null;
    }
    if (binding.expiresAtMs <= Date.now()) {
      bindings.delete(token);
      if (params.releaseClaimOnLookupExpiry) {
        resolving.delete(token);
      }
      return null;
    }
    return binding;
  };
  const complete = (token: string): void => {
    const binding = bindings.get(token);
    resolving.delete(token);
    bindings.delete(token);
    if (binding) {
      params.onComplete?.(binding);
    }
  };

  return {
    createToken: () => randomBytes(18).toString("base64url"),
    register(binding: TBinding): boolean {
      if (binding.expiresAtMs <= Date.now()) {
        return false;
      }
      bindings.delete(binding.token);
      bindings.set(binding.token, binding);
      // Eviction removes the binding while an awaited resolver still owns its claim.
      pruneMapToMaxSize(bindings, 1024);
      return true;
    },
    get,
    values: () => bindings.values(),
    pruneExpired(nowMs: number): void {
      for (const [token, binding] of bindings) {
        if (binding.expiresAtMs <= nowMs) {
          bindings.delete(token);
          resolving.delete(token);
        }
      }
    },
    unregister(tokens: readonly string[]): void {
      for (const token of tokens) {
        complete(token);
      }
    },
    async settle<TResult>(
      token: string,
      resolveAndUpdate: (binding: TBinding) => Promise<TResult>,
    ): Promise<
      | { kind: "missing" }
      | { kind: "in-flight" }
      | { kind: "not-found"; binding: TBinding }
      | { kind: "settled"; binding: TBinding; result: TResult }
    > {
      const binding = get(token);
      if (!binding) {
        return { kind: "missing" };
      }
      if (resolving.has(token)) {
        return { kind: "in-flight" };
      }
      resolving.add(token);
      let result: TResult;
      try {
        // The claim covers both Gateway resolution and the terminal card update.
        result = await resolveAndUpdate(binding);
      } catch (error) {
        if (isApprovalNotFoundError(error)) {
          complete(token);
          return { kind: "not-found", binding };
        }
        resolving.delete(token);
        throw error;
      }
      complete(token);
      return { kind: "settled", binding, result };
    },
  };
}

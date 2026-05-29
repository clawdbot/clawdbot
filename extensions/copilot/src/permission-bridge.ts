/**
 * Permission bridge for the copilot agent runtime.
 *
 * BACK-POINTER: The full runtime-neutral permission/tool-policy logic
 * lives in `src/agents/pi-tools.before-tool-call.ts` (820 LOC, exports
 * `runBeforeToolCallHook`, `BeforeToolCallBlockedError`, etc.). Per Q4
 * (proposal section 3.4), we deliberately do NOT extract a shared helper
 * - PI source stays untouched. Instead, this module:
 *
 *   1. Defines a small `CopilotPermissionPolicy` contract that the
 *      host can implement to mirror PI's policy decisions for the
 *      copilot agent runtime.
 *   2. Provides built-in policies for common defaults (fail-closed,
 *      approve-all-for-test, allow-list-by-kind).
 *   3. Provides a `delegatingPolicy({ onRequest })` so the core layer
 *      can plug in a host-side callback that calls into
 *      `runBeforeToolCallHook` / `effective-tool-policy` and returns
 *      the SDK-shaped decision.
 *   4. Adapts the resulting policy into the SDK's
 *      `PermissionHandler` shape via `createPermissionBridge(policy)`.
 *
 * Cross-package boundary note: the heavy `pi-tools.before-tool-call`
 * surface cannot be imported here (`tsconfig.package-boundary.base.json`).
 * The host bridges core PI logic into this module by injecting a
 * `delegatingPolicy` from the core wiring layer that constructs
 * `AgentHarnessAttemptParams` for the copilot agent runtime.
 *
 * If PI's permission semantics change materially, the contract here
 * must be revisited in lockstep. The unit tests in
 * `permission-bridge.test.ts` exercise the SDK-shaped decision
 * envelope so any silent drift in the SDK type is caught at typecheck.
 */

import type {
  PermissionHandler,
  PermissionRequest as SdkPermissionRequest,
  PermissionRequestResult as SdkPermissionRequestResult,
} from "@github/copilot-sdk";

/** Request shape forwarded to host-implemented policies. */
export interface CopilotPermissionContext {
  /** SDK session id that originated the request. */
  sessionId: string;
  /** Original SDK request payload. */
  request: SdkPermissionRequest;
}

/**
 * Policy contract. Implementors return an SDK-shaped decision (or a
 * Promise of one).
 *
 * Returning `undefined` is treated as "no opinion" and falls through to
 * the default fail-closed decision (`reject` with `REJECT_ALL_FEEDBACK`).
 * This keeps composition trivial without requiring explicit `reject`
 * returns from every code path.
 */
export type CopilotPermissionPolicy = (
  ctx: CopilotPermissionContext,
) => SdkPermissionRequestResult | undefined | Promise<SdkPermissionRequestResult | undefined>;

/** Built-in fail-closed default. Mirrors the pre-bridge attempt.ts stub. */
export const REJECT_ALL_FEEDBACK =
  "copilot agent runtime: no permission policy installed (fail-closed default)";

export const rejectAllPolicy: CopilotPermissionPolicy = () => ({
  kind: "reject",
  feedback: REJECT_ALL_FEEDBACK,
});

/**
 * Approve every request as "approve-once". Use only in tests / live
 * smoke runs where the operator has accepted the risk. This is the
 * SDK-bundled `approveAll` behavior re-exported as an explicit named
 * policy so test sites can opt in without `@github/copilot-sdk`
 * imports leaking into call sites.
 */
export const allowOncePolicy: CopilotPermissionPolicy = () => ({
  kind: "approve-once",
});

export interface AllowListPolicyOptions {
  /** Permission kinds that should be approved once. */
  kinds: ReadonlyArray<SdkPermissionRequest["kind"]>;
  /** Optional feedback text attached to rejections. */
  rejectFeedback?: string;
}

/**
 * Approve requests whose `kind` is in the allow-list; reject everything
 * else with `rejectFeedback` (defaulting to `REJECT_ALL_FEEDBACK`).
 */
export function allowListPolicy(options: AllowListPolicyOptions): CopilotPermissionPolicy {
  const allowed = new Set<SdkPermissionRequest["kind"]>(options.kinds);
  const feedback = options.rejectFeedback ?? REJECT_ALL_FEEDBACK;
  return ({ request }) => {
    if (allowed.has(request.kind)) {
      return { kind: "approve-once" };
    }
    return { kind: "reject", feedback };
  };
}

export interface DelegatingPolicyOptions {
  /**
   * Host-supplied callback. Returning `undefined` falls through to the
   * fail-closed default. Throwing falls back to the configured
   * `onError` policy if provided; otherwise the throw is converted to a
   * reject with the error message embedded in `feedback` (so the model
   * sees the diagnostic instead of a generic RPC failure).
   */
  onRequest: CopilotPermissionPolicy;
  /**
   * Optional fallback when `onRequest` throws. If omitted, throws are
   * reflected back as `reject` with the error message in `feedback`.
   * If supplied and `onError` also throws, fall through to the
   * error-message reject.
   */
  onError?: CopilotPermissionPolicy;
}

/**
 * Wrap a host callback into a policy, catching synchronous throws and
 * async rejections so the SDK never sees an exception (which would
 * surface as a generic RPC failure to the model).
 */
export function delegatingPolicy(options: DelegatingPolicyOptions): CopilotPermissionPolicy {
  const { onRequest, onError } = options;
  return async (ctx) => {
    try {
      const result = await onRequest(ctx);
      if (result !== undefined) {
        return result;
      }
      return { kind: "reject", feedback: REJECT_ALL_FEEDBACK };
    } catch (error) {
      if (onError) {
        try {
          const fallback = await onError(ctx);
          if (fallback !== undefined) {
            return fallback;
          }
        } catch {
          // fall through to error-message reject
        }
      }
      return {
        kind: "reject",
        feedback: `copilot permission policy threw: ${formatError(error)}`,
      };
    }
  };
}

/**
 * Compose policies in order. The first policy to return a non-undefined
 * result wins. If all return undefined, a fail-closed `reject` is
 * produced. Throws inside any policy short-circuit to `reject` with the
 * error message; downstream policies are not consulted after a throw
 * (so a misbehaving host policy cannot mask itself by being followed by
 * an allow-policy).
 */
export function composePolicies(...policies: CopilotPermissionPolicy[]): CopilotPermissionPolicy {
  return async (ctx) => {
    for (const policy of policies) {
      try {
        const result = await policy(ctx);
        if (result !== undefined) {
          return result;
        }
      } catch (error) {
        return {
          kind: "reject",
          feedback: `copilot permission policy threw: ${formatError(error)}`,
        };
      }
    }
    return { kind: "reject", feedback: REJECT_ALL_FEEDBACK };
  };
}

/**
 * Adapt a `CopilotPermissionPolicy` to the SDK's
 * `PermissionHandler` shape. The returned handler always resolves
 * (never rejects), defaulting to fail-closed when the policy returns
 * undefined or throws.
 */
export function createPermissionBridge(
  policy: CopilotPermissionPolicy = rejectAllPolicy,
): PermissionHandler {
  return async (request, invocation) => {
    const ctx: CopilotPermissionContext = {
      request,
      sessionId: invocation.sessionId,
    };
    try {
      const result = await policy(ctx);
      if (result !== undefined) {
        return result;
      }
    } catch (error) {
      return {
        kind: "reject",
        feedback: `copilot permission policy threw: ${formatError(error)}`,
      };
    }
    return { kind: "reject", feedback: REJECT_ALL_FEEDBACK };
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

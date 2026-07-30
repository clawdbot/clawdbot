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
 *   2. Adapts the resulting policy into the SDK's
 *      `PermissionHandler` shape via `createPermissionBridge(policy)`.
 *
 * Cross-package boundary note: the heavy `pi-tools.before-tool-call`
 * surface cannot be imported here (`tsconfig.package-boundary.base.json`).
 * The host bridges core PI logic into this module by injecting a
 * `CopilotPermissionPolicy` from the core wiring layer that constructs
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
interface CopilotPermissionContext {
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
const REJECT_ALL_FEEDBACK =
  "copilot agent runtime: no permission policy installed (fail-closed default)";

export const rejectAllPolicy: CopilotPermissionPolicy = () => ({
  kind: "reject",
  feedback: REJECT_ALL_FEEDBACK,
});

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

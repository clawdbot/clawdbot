/**
 * User-input bridge for the copilot agent runtime.
 *
 * STATUS — MVP DORMANT: This module is intentionally NOT registered with
 * the SDK in the current harness (see `attempt.ts` / `side-question.ts`).
 * The SDK contract is "When `onUserInputRequest` is provided, enables the
 * `ask_user` tool allowing the agent to ask questions" (see
 * `node_modules/@github/copilot-sdk/dist/types.d.ts` `SessionConfig`);
 * by omitting the handler we hide `ask_user` from the model entirely.
 * Agents under the MVP must make best-judgment decisions from the
 * initial prompt rather than asking clarifying questions mid-turn.
 *
 * FOLLOW-UP: The scaffolding below stays in tree so the follow-up that
 * ports the codex user-input-bridge pattern
 * (`extensions/codex/src/app-server/user-input-bridge.ts`) has a stable
 * surface to wire — that change will route SDK `UserInputRequest`s
 * through `params.onBlockReply` / `onPartialReply` and resolve the
 * pending promise from the next inbound channel message, then register
 * `createUserInputBridge(delegatingUserInputPolicy(...))` from
 * `createSessionConfig`.
 *
 * BACK-POINTER: The host-side channel/TUI prompt flow lives outside
 * this package boundary in `commitments/` and the channel plugins
 * (slack/discord/cli/tui). Per proposal §50, this bridge does NOT
 * import that flow directly (the package boundary
 * `tsconfig.package-boundary.base.json` only allows
 * `openclaw/plugin-sdk/*` and `@github/copilot-sdk`). Instead, this
 * module:
 *
 *   1. Defines a small `CopilotUserInputPolicy` contract that the
 *      core wiring layer implements to forward `UserInputRequest`s to
 *      the host's channel/TUI prompt path.
 *   2. Provides built-in policies for common defaults (deny-all with a
 *      synthetic answer, auto-first-choice, static-answer).
 *   3. Provides a `delegatingUserInputPolicy({ onRequest })` so the
 *      core wiring layer can plug in a host-side callback that calls
 *      into `commitments/` and returns the SDK-shaped response.
 *   4. Adapts the resulting policy into the SDK's `UserInputHandler`
 *      shape via `createUserInputBridge(policy)`.
 *
 * SDK contract note: unlike `PermissionHandler` (which has a
 * `no-result` escape hatch), `UserInputHandler` MUST resolve with a
 * `UserInputResponse`. The bridge therefore never returns `undefined`
 * to the SDK; if a policy returns `undefined` or throws, the default
 * fail-closed answer is used so the model sees a real string rather
 * than a generic RPC failure.
 *
 * If the host's prompt contract changes materially, the contract here
 * must be revisited in lockstep. The unit tests in
 * `user-input-bridge.test.ts` exercise the SDK-shaped response envelope
 * so any silent drift in the SDK type is caught at typecheck.
 */

import type { SessionConfig } from "@github/copilot-sdk";

type UserInputHandler = NonNullable<SessionConfig["onUserInputRequest"]>;
type SdkUserInputRequest = Parameters<UserInputHandler>[0];
type SdkUserInputResponse = Awaited<ReturnType<UserInputHandler>>;

/** Request shape forwarded to host-implemented user-input policies. */
export interface CopilotUserInputContext {
  /** SDK session id that originated the request. */
  sessionId: string;
  /** Original SDK request payload. */
  request: SdkUserInputRequest;
}

/**
 * Policy contract. Implementors return an SDK-shaped response (or a
 * Promise of one).
 *
 * Returning `undefined` is treated as "no opinion" and falls through
 * to the default fail-closed response (`DENY_ALL_ANSWER`). This keeps
 * composition trivial without requiring explicit responses from every
 * code path.
 */
export type CopilotUserInputPolicy = (
  ctx: CopilotUserInputContext,
) => SdkUserInputResponse | undefined | Promise<SdkUserInputResponse | undefined>;

/**
 * Default answer used when no host policy provides one. The string is
 * intentionally explicit so the model can detect the missing-prompt
 * condition rather than treating it as a real user answer.
 */
export const DENY_ALL_ANSWER =
  "[copilot agent runtime: no user-input policy installed; request declined]";

export const denyAllUserInputPolicy: CopilotUserInputPolicy = () => ({
  answer: DENY_ALL_ANSWER,
  wasFreeform: true,
});

/**
 * Auto-pick the first choice if the request offers choices; otherwise
 * fall back to `DENY_ALL_ANSWER` as a freeform answer. Useful for
 * non-interactive test runs.
 */
export const firstChoicePolicy: CopilotUserInputPolicy = ({ request }) => {
  if (request.choices && request.choices.length > 0) {
    return { answer: request.choices[0], wasFreeform: false };
  }
  return { answer: DENY_ALL_ANSWER, wasFreeform: true };
};

export interface StaticAnswerPolicyOptions {
  /** Answer returned for every request. */
  answer: string;
  /**
   * Whether the answer should be flagged as a freeform response.
   * Defaults to `true` (caller did not pick from `choices`).
   */
  wasFreeform?: boolean;
}

/** Always return a fixed answer. Useful for deterministic tests. */
export function staticAnswerPolicy(options: StaticAnswerPolicyOptions): CopilotUserInputPolicy {
  const wasFreeform = options.wasFreeform ?? true;
  return () => ({ answer: options.answer, wasFreeform });
}

export interface DelegatingUserInputPolicyOptions {
  /**
   * Host-supplied callback. Returning `undefined` falls through to the
   * fail-closed default. Throwing falls back to the configured
   * `onError` policy if provided; otherwise the throw is converted to
   * a `DENY_ALL_ANSWER` response so the SDK never sees an exception
   * (which would surface as a generic RPC failure to the model).
   */
  onRequest: CopilotUserInputPolicy;
  /**
   * Optional fallback when `onRequest` throws. If omitted, throws are
   * converted to a `DENY_ALL_ANSWER` response with the error message
   * appended. If supplied and `onError` also throws, fall through to
   * the error-message response.
   */
  onError?: CopilotUserInputPolicy;
}

/**
 * Wrap a host callback into a policy, catching synchronous throws and
 * async rejections so the SDK never sees an exception.
 */
export function delegatingUserInputPolicy(
  options: DelegatingUserInputPolicyOptions,
): CopilotUserInputPolicy {
  const { onRequest, onError } = options;
  return async (ctx) => {
    try {
      const result = await onRequest(ctx);
      if (result !== undefined) {
        return result;
      }
      return { answer: DENY_ALL_ANSWER, wasFreeform: true };
    } catch (error) {
      if (onError) {
        try {
          const fallback = await onError(ctx);
          if (fallback !== undefined) {
            return fallback;
          }
        } catch {
          // fall through to error-message response
        }
      }
      return {
        answer: `${DENY_ALL_ANSWER} (host policy threw: ${formatError(error)})`,
        wasFreeform: true,
      };
    }
  };
}

/**
 * Compose policies in order. The first policy to return a non-undefined
 * result wins. If all return undefined, a fail-closed `DENY_ALL_ANSWER`
 * response is produced. Throws inside any policy short-circuit to the
 * error-message response; downstream policies are not consulted after a
 * throw.
 */
export function composeUserInputPolicies(
  ...policies: CopilotUserInputPolicy[]
): CopilotUserInputPolicy {
  return async (ctx) => {
    for (const policy of policies) {
      try {
        const result = await policy(ctx);
        if (result !== undefined) {
          return result;
        }
      } catch (error) {
        return {
          answer: `${DENY_ALL_ANSWER} (host policy threw: ${formatError(error)})`,
          wasFreeform: true,
        };
      }
    }
    return { answer: DENY_ALL_ANSWER, wasFreeform: true };
  };
}

/**
 * Adapt a `CopilotUserInputPolicy` to the SDK's `UserInputHandler`
 * shape. The returned handler always resolves with a valid
 * `UserInputResponse` (never throws, never returns undefined),
 * defaulting to `DENY_ALL_ANSWER` when the policy returns undefined or
 * throws.
 */
export function createUserInputBridge(
  policy: CopilotUserInputPolicy = denyAllUserInputPolicy,
): UserInputHandler {
  return async (
    request: SdkUserInputRequest,
    invocation: { sessionId: string },
  ): Promise<SdkUserInputResponse> => {
    const ctx: CopilotUserInputContext = {
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
        answer: `${DENY_ALL_ANSWER} (host policy threw: ${formatError(error)})`,
        wasFreeform: true,
      };
    }
    return { answer: DENY_ALL_ANSWER, wasFreeform: true };
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

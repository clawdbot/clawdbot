/**
 * Hooks bridge for the copilot agent runtime.
 *
 * BACK-POINTER: The host-side hook runner lives outside this package
 * boundary in `src/agents/harness/lifecycle-hook-helpers.ts` (uses the
 * plugin hook runner via `src/plugins/hook-runner-global.ts`). Per
 * proposal §266 (todo `hooks-bridge`), this module provides a small
 * contract surface that mirrors the SDK's `SessionHooks` shape; the
 * core wiring layer constructs handlers that call into
 * `runAgentHarnessLlmInputHook`, `runAgentHarnessLlmOutputHook`,
 * `runAgentHarnessAgentEndHook`, etc., and threads them through
 * `AttemptParamsLike.hooks`.
 *
 * Cross-package boundary note: the heavy host lifecycle helpers
 * cannot be imported here (`tsconfig.package-boundary.base.json`). The
 * bridge keeps the SDK hook contracts intact, wraps each provided
 * handler in an error-isolating envelope so a thrown host hook cannot
 * crash the SDK session, and returns a `SessionHooks` object that
 * `createSessionConfig` can plug into `SessionConfig.hooks`.
 *
 * Note on default omission: if no handlers are supplied, the bridge
 * returns `undefined` so that `SessionConfig.hooks` stays absent and
 * the SDK skips the entire hook subsystem (matches the "no hooks
 * installed" runtime behaviour the harness had pre-bridge).
 */

import type { SessionConfig } from "@github/copilot-sdk";

// All hook handler types are derived from SessionHooks so this bridge
// stays pinned to the same SDK source the rest of the harness uses,
// without depending on the SDK re-exporting individual handler aliases
// (which it does not, as of @github/copilot-sdk@1.0.0-beta.4).
type SdkSessionHooks = NonNullable<SessionConfig["hooks"]>;
type PreToolUseHandler = NonNullable<SdkSessionHooks["onPreToolUse"]>;
type PostToolUseHandler = NonNullable<SdkSessionHooks["onPostToolUse"]>;
type UserPromptSubmittedHandler = NonNullable<SdkSessionHooks["onUserPromptSubmitted"]>;
type SessionStartHandler = NonNullable<SdkSessionHooks["onSessionStart"]>;
type SessionEndHandler = NonNullable<SdkSessionHooks["onSessionEnd"]>;
type ErrorOccurredHandler = NonNullable<SdkSessionHooks["onErrorOccurred"]>;

export interface CopilotHooksConfig {
  onPreToolUse?: PreToolUseHandler;
  onPostToolUse?: PostToolUseHandler;
  onUserPromptSubmitted?: UserPromptSubmittedHandler;
  onSessionStart?: SessionStartHandler;
  onSessionEnd?: SessionEndHandler;
  onErrorOccurred?: ErrorOccurredHandler;
  /**
   * Optional hook-error notifier. Called whenever any wrapped handler
   * throws (synchronously or as a Promise rejection). Defaults to
   * `console.warn` so the failure is visible to operators without
   * crashing the SDK session. Receives the SDK hook name and the
   * raised error.
   */
  onHookError?: (info: { hookName: keyof SdkSessionHooks; error: unknown }) => void;
}

const DEFAULT_HOOK_ERROR_HANDLER: NonNullable<CopilotHooksConfig["onHookError"]> = ({
  hookName,
  error,
}) => {
  console.warn(`[copilot hooks-bridge] ${hookName} handler threw:`, error);
};

/**
 * Wrap a host handler in an error-isolating envelope so it cannot
 * throw out into the SDK. Returns `undefined` (no opinion) when the
 * host handler throws, so the SDK falls back to its default behaviour
 * for that hook.
 */
function isolate<TArgs extends readonly unknown[], TResult>(
  hookName: keyof SdkSessionHooks,
  handler: ((...args: TArgs) => TResult | Promise<TResult>) | undefined,
  onError: NonNullable<CopilotHooksConfig["onHookError"]>,
): ((...args: TArgs) => Promise<TResult | undefined>) | undefined {
  if (!handler) {
    return undefined;
  }
  return async (...args: TArgs) => {
    try {
      return await handler(...args);
    } catch (error) {
      try {
        onError({ hookName, error });
      } catch {
        // never let the error notifier itself throw out
      }
      return undefined;
    }
  };
}

/**
 * Build an SDK-shaped `SessionHooks` object from a host-supplied
 * `CopilotHooksConfig`. Returns `undefined` when no handlers were
 * supplied so the SDK skips the hook subsystem entirely.
 */
export function createHooksBridge(config?: CopilotHooksConfig): SdkSessionHooks | undefined {
  if (!config) {
    return undefined;
  }
  const onError = config.onHookError ?? DEFAULT_HOOK_ERROR_HANDLER;
  const hooks: SdkSessionHooks = {};
  const pre = isolate("onPreToolUse", config.onPreToolUse, onError);
  const post = isolate("onPostToolUse", config.onPostToolUse, onError);
  const userPrompt = isolate("onUserPromptSubmitted", config.onUserPromptSubmitted, onError);
  const sessionStart = isolate("onSessionStart", config.onSessionStart, onError);
  const sessionEnd = isolate("onSessionEnd", config.onSessionEnd, onError);
  const errorOccurred = isolate("onErrorOccurred", config.onErrorOccurred, onError);

  if (pre) {
    hooks.onPreToolUse = pre as PreToolUseHandler;
  }
  if (post) {
    hooks.onPostToolUse = post as PostToolUseHandler;
  }
  if (userPrompt) {
    hooks.onUserPromptSubmitted = userPrompt as UserPromptSubmittedHandler;
  }
  if (sessionStart) {
    hooks.onSessionStart = sessionStart as SessionStartHandler;
  }
  if (sessionEnd) {
    hooks.onSessionEnd = sessionEnd as SessionEndHandler;
  }
  if (errorOccurred) {
    hooks.onErrorOccurred = errorOccurred as ErrorOccurredHandler;
  }

  if (Object.keys(hooks).length === 0) {
    return undefined;
  }
  return hooks;
}

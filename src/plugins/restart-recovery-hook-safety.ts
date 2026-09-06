import { hasGlobalHooks } from "./hook-runner-global.js";
import type { PluginHookReplyDispatchKind } from "./hook-types.js";

const RESTART_RECOVERY_UNSAFE_CHAT_ADMISSION_HOOKS = [
  "before_dispatch",
  "before_agent_run",
  "before_message_write",
  "reply_dispatch",
] as const;

/** Initial chat admission defers before_agent_reply until after its durable checkpoint. */
export function findRestartRecoveryUnsafeChatAdmissionHook(
  dispatchKind: PluginHookReplyDispatchKind,
): (typeof RESTART_RECOVERY_UNSAFE_CHAT_ADMISSION_HOOKS)[number] | undefined {
  return RESTART_RECOVERY_UNSAFE_CHAT_ADMISSION_HOOKS.find((hookName) =>
    hookName === "reply_dispatch"
      ? hasGlobalHooks(hookName, { dispatchKind })
      : hasGlobalHooks(hookName),
  );
}

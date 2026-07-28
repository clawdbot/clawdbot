import { hasGlobalHooks } from "./hook-runner-global.js";

const RESTART_RECOVERY_UNSAFE_REPLY_HOOKS = [
  "before_dispatch",
  "before_agent_reply",
  "before_agent_run",
  "before_message_write",
  "reply_dispatch",
] as const;

const RESTART_RECOVERY_UNSAFE_CHAT_ADMISSION_HOOKS = [
  "before_dispatch",
  "before_agent_run",
  "before_message_write",
  "reply_dispatch",
] as const;

export function findRestartRecoveryUnsafeReplyHook():
  | (typeof RESTART_RECOVERY_UNSAFE_REPLY_HOOKS)[number]
  | undefined {
  return RESTART_RECOVERY_UNSAFE_REPLY_HOOKS.find((hookName) => hasGlobalHooks(hookName));
}

/** Initial chat admission defers before_agent_reply until after its durable checkpoint. */
export function findRestartRecoveryUnsafeChatAdmissionHook():
  | (typeof RESTART_RECOVERY_UNSAFE_CHAT_ADMISSION_HOOKS)[number]
  | undefined {
  return RESTART_RECOVERY_UNSAFE_CHAT_ADMISSION_HOOKS.find((hookName) => hasGlobalHooks(hookName));
}
